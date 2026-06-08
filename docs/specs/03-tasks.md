# 任务拆分与并行执行计划 — AI 代码评审 PR 机器人

> 阶段 3 产出物。上承 [02-design.md](02-design.md)。把模块变成 agent 可独立认领的工单 + 并行执行方式 + 防跑偏护栏。
> 状态：**待评审**。

## 1. 执行波次（fan-out / fan-in）

```
Wave 0  脚手架 + 契约 (T-scaffold, T0)        ── 串行，1 个执行者，【人工评审门】后才扇出
            │ 冻结 contracts.ts ▼
Wave 1  T1 T2 T3 T4 T5 T6  (+ T7 对 fake 起骨架) ── 6~7 个 worktree 并行
            │ 合并 + 【评审门】▼
Wave 2  T7 集成真实模块 → T8 入口                ── fan-in，跑全链路集成/e2e
            │ ▼
Wave 3  T9 evals + T10 CI/CD + 开启 dogfood
```

## 2. 防跑偏护栏（本项目的具体落地）

这一节是「怎么防止 agent 跑偏」的答案，每条都对应一个机制：

1. **契约冻结**：`src/core/contracts.ts`（T0）经评审后**冻结**。所有 agent 只能 `import` 它、**禁止修改**。若某 agent 认为契约需要改 → **停下来上报**，由人决定后统一改——绝不各自改。
2. **工单含「禁区」**：每个工单显式列出"只动哪些文件 / 不许碰什么"，把作用域钉死。
3. **worktree 隔离**：每个并行 agent 在自己的 git worktree + 分支，互不踩踏（本仓库用 Claude Code 的 `isolation: worktree` 子 agent 实现）。
4. **guardrails 强制 = DoD**：每个工单"完成"前必须本地通过 `bun run typecheck` + `biome check` + 自己那块的 `bun test`。CI（T10）在集成 PR 上再强制一遍——过不了就是红。
5. **测试先行**：工单里直接给出验收测试/用例，agent 写代码去满足它们，减少"自由发挥"。
6. **小作用域**：一个 agent 一个模块。
7. **评审 checkpoint**：每个 wave 结束人工（或评审 agent）看 diff 才合并。
8. **共享上下文**：仓库根的 `CLAUDE.md`（T-scaffold 产出）写明约定——代码风格、怎么跑测试、"不许改 contracts"、错误处理/命名约定——**每个 agent 进场先读它**。这是贯穿全程的上下文工程底座。

## 3. 工单卡片

> 统一字段：依赖 / 目标 / 产出文件 / 契约引用 / 验收（测试）/ DoD / 禁区。
> 全局 DoD（每张都适用）：`tsc --noEmit` 过、`biome check` 过、本模块 `bun test` 绿、对外导出与 contracts 一致、**未改 contracts.ts**。

### Wave 0（串行，先做）

**T-scaffold — 项目脚手架 + 共享上下文**
- 依赖：无
- 目标：建可运行的 TS+Bun 工程骨架与团队约定
- 产出：`package.json`、`tsconfig.json`、`biome.json`、目录骨架、`bun test` 配置、**`CLAUDE.md`（约定 + 防跑偏规则）**、`.env.example`
- DoD：`bun install` 通过；空 `bun test` 可运行；`biome check` 通过

**T0 — M0 契约（contracts.ts）**
- 依赖：T-scaffold
- 目标：定义 §3 全部类型 + zod schema + 两个 Port 接口
- 产出：`src/core/contracts.ts`
- 契约引用：本工单**即**契约源
- 验收：类型编译通过；zod schema 能校验样例对象；`zodResponseFormat(FindingSchema)` 能产出合法 OpenAI json_schema（strict，可选字段 nullable）
- DoD：导出齐全、命名稳定；**这是冻结点——合并前过人工评审门**
- 禁区：不写任何业务逻辑

### Wave 1（并行，每个独立 worktree）

**T1 — M1 config**
- 依赖：T0｜目标：env + 可选 repo 配置文件 → `Config`（默认值/阈值/ignore globs）
- 产出：`src/core/config.ts`｜契约：实现 `Config`
- 验收：解析 env、套用默认、拒绝非法值、合并 ignore globs（表驱动用例）
- 禁区：只动 `src/core/config.ts` + 其测试

**T2 — M2 github（adapter）**
- 依赖：T0｜目标：用 Octokit 实现 `GitHubPort`：`getPullRequest` 映射成 `PullRequestData`、`postReview` 发行内+汇总
- 产出：`src/github/client.ts`｜契约：实现 `GitHubPort`
- 验收：注入 mock Octokit，断言字段映射正确、二进制/无 patch 文件处理正确、行内评论锚定行不在 diff 时降级
- 禁区：只动 `src/github/**` + 测试；不碰编排

**T3 — M3 filter（纯）**
- 依赖：T0｜目标：`ChangedFile[] + Config → { units, skipped }`（二进制/lockfile/生成文件/超大/ignore glob）
- 产出：`src/filter/index.ts`
- 验收：表驱动覆盖各跳过原因 + 正常文件成 unit
- 禁区：保持纯函数，无 I/O

**T4 — M4 diff（纯）**
- 依赖：T0｜目标：`parsePatch(patch) → DiffHunk[]`；`anchor(line, hunks) → position | null`
- 产出：`src/diff/index.ts`
- 验收：真实 patch 样例；含边界（多 hunk、增/删/上下文、行不在 hunk → null）
- 禁区：纯函数，无 I/O。**diff 定位是最易出错处，用例要厚**

**T5 — M5 llm（adapter + prompt）**
- 依赖：T0｜目标：四维 rubric 的 prompt 构造 + OpenAI structured outputs 调用 + 解析 `Finding[]`，实现 `LLMPort`
- 产出：`src/llm/client.ts`、`src/llm/prompt.ts`
- 验收：mock OpenAI；断言 prompt 含 rubric+diff、解析结构化响应、空/拒答处理、置信度透传
- 禁区：只动 `src/llm/**` + 测试

**T6 — M7 render（纯）**
- 依赖：T0｜目标：`ReviewResult → { text, markdownSummary, inlineComments }`
- 产出：`src/render/index.ts`
- 验收：按严重度/文件分组；未能锚定的发现降级进汇总；中英文输出
- 禁区：纯函数

**T7 — M6 review（编排，可在 Wave 1 对 fake 起骨架）**
- 依赖：T0（接口）；Wave 2 集成真实模块｜目标：`runReview` 串联 + postprocess（阈值/去重/排序）+ status 计算（高置信 critical → fail）
- 产出：`src/review/run.ts`
- 验收：用 fake `GitHubPort`+`LLMPort`+fixture PR 的集成测试，确定性断言全链路与 status 逻辑
- 禁区：业务逻辑只在编排层；不在此实现 adapter 细节

### Wave 2 / 3

**T8 — M8 entrypoints**（依赖 T7）：`src/entrypoints/{cli,action}.ts`；解析输入→装配 config+ports→调 runReview→输出 JSON + exit code；`skip-ai-review` label 短路。验收：CLI 对 fixture 跑通、exit code 正确。

**T9 — M9 evals**（依赖 T7）：`evals/{dataset,scorer.ts,run.ts}`；标注数据集格式 + 打分器（发现↔标注按 file+line 邻近 + category 匹配）+ 种子数据集（正样本各维 + 干净 PR）。验收：打分器在已知集上算出正确 precision/recall；产出 baseline 回填需求 §3/§9。

**T10 — CI/CD**（依赖 T8、各测试就绪）：`.github/workflows/ci.yml`（lint/typecheck/unit/e2e/eval-regression，concurrency 取消旧运行）、`action.yml`（composite：setup-bun + bun run）、`.github/workflows/ai-review.yml`（dogfood，`uses: ./`，最小权限 + skip label）。验收：CI 在样例 PR 全绿；dogfood 在本仓库 PR 真发评论。

## 4. 在本环境怎么实际跑并行 agent

- **Wave 0** 由我直接做（串行、是地基），完成后停在评审门等你过。
- **Wave 1** 用 Claude Code 的 worktree 隔离子 agent：一个工单一个子 agent，每个只拿到「该工单卡片 + contracts.ts + CLAUDE.md」作为上下文，在独立 worktree 写代码 + 自测到 DoD 绿。
- **集成（Wave 2）** 我把各 worktree 收回主干，按依赖顺序合并、解冲突、跑全链路集成/e2e —— 这就是 fan-in，也是并行开发真正的难点所在。
- 每个 wave 之间有评审 checkpoint。

## 5. 关键路径

`T-scaffold → T0 → {T2,T4,T5} → T7 → T8 → T10(dogfood)`。T1/T3/T6 不在关键路径（更快），T9 可与 Wave 3 并行。
