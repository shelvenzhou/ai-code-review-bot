# 系统设计 — AI 代码评审 PR 机器人

> 阶段 2 产出物。上承 [01-requirements.md](01-requirements.md)，下接任务拆分（03-tasks.md）。
> 状态：**待评审**。

## 1. 架构总览

一条线性流水线，两个入口（Action / CLI）汇聚到同一个核心 `runReview`：

```
入口(Action|CLI) → 解析 PR ref + Config + 凭证
        │
   ┌────▼─────────────────────────── runReview (orchestrator) ───────────────────────┐
   │ fetch ──→ filter ──→ chunk/budget ──→ LLM review ──→ postprocess ──→ anchor ──→ assemble │
   │ (GitHub)  (纯函数)    (纯函数)         (OpenAI)      (阈值/去重)    (diff定位)   (ReviewResult)│
   └──────────────────────────────────────────┬───────────────────────────────────────┘
                                               │
                          ┌────────────────────┼─────────────────────┐
                       JSON artifact       PR review 回帖           check 结论/exit code
                        (stdout/file)   (行内评论 + 汇总评论)      (高置信 critical → fail)
```

设计原则（也是防跑偏的基础）：
- **Ports & Adapters（六边形精简版）**：外部副作用（GitHub、OpenAI）藏在 `GitHubPort` / `LLMPort` 接口后 → 核心逻辑可用 fake 注入、确定性测试（NFR-5）。
- **核心纯函数化**：filter / diff 定位 / render / 阈值判定都是纯函数 → 单测便宜、覆盖率高；副作用只在 adapter。
- **契约先行**：`src/core/contracts.ts` 在所有人动手前先冻结（见 §3），各 agent 只依赖类型、不依赖彼此实现。

## 2. 模块边界与依赖图

| 模块 | 职责 | 纯/副作用 | 依赖 |
|---|---|---|---|
| **M0 core/contracts** | 全部共享类型 + zod schema + 两个 Port 接口 | 纯（仅类型） | — |
| **M1 config** | 加载/校验配置（env + 可选 repo 配置文件）+ 默认值/阈值/ignore | 纯-ish | M0 |
| **M2 github** | 实现 `GitHubPort`：拉 PR/diff/文件、回帖、设 check | 副作用 | M0 |
| **M3 filter** | ChangedFile[] + Config → 可评审 ReviewUnit[] + 跳过列表 | 纯 | M0 |
| **M4 diff** | 解析 unified diff → hunks；`isCommentable(line,hunks)` 判定行可否评论 | 纯 | M0 |
| **M5 llm** | 实现 `LLMPort`：构造 prompt（四维 rubric）、调 OpenAI structured outputs、解析 → Finding[] | 副作用 | M0 |
| **M6 review** | orchestrator `runReview`：串起 fetch→filter→budget→llm→postprocess→anchor→assemble + 算 status | 编排 | M0..M5,M7（仅接口） |
| **M7 render** | ReviewResult → 人读文本 / markdown 汇总 / 行内评论 payload | 纯 | M0 |
| **M8 entrypoints** | CLI + Action 两个薄包装：解析输入→装配 ports/config→调 runReview→输出 JSON + exit code | 副作用 | M6,M1,M2 |
| **M9 evals** | eval 数据集 + 打分器：跑 runReview 评 precision/recall | 编排 | M6,M0 |

**依赖图（决定并行度）：**

```
M0 contracts ……………………………… 串行，先做，阻塞所有人
        │ 冻结后扇出 ▼
 ┌───────┬───────┬───────┬───────┬───────┐
 M1config M2github M3filter M4diff M5llm  M7render   ← 6 个可完全并行（只依赖 M0）
 └───────┴───────┴───────┴───────┴───────┘
        │
 M6 review（可与上面并行：对着冻结的 ports 写，用 fake/stub，最后集成）
        │
 M8 entrypoints（待 M6 稳定）      M9 evals（待 M6；可先对 fake 起骨架）
```

**并行策略**：M0（小、串行，约 1 个 agent 快速完成并经评审）→ 然后 M1/M2/M3/M4/M5/M7 六路并行 → M6 同期对 mock 开发、随后集成（fan-in）→ M8/M9 收尾。这正是后面"多 agent 并行 + 集成"阶段要演练的扇出/扇入。

## 3. 接口契约（冻结物 = M0）

> 这是**最硬的防跑偏护栏**。下面是 `src/core/contracts.ts` 的设计；M0 落地时配 zod schema（运行时校验 + 推导 OpenAI 的 json_schema）。

```ts
export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "correctness" | "security" | "maintainability" | "performance";

export interface Finding {
  file: string;          // 相对仓库根
  line: number;          // 新文件侧行号（锚点）
  endLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  suggestion?: string;
  confidence: number;    // 0..1
}

export interface ReviewStats {
  bySeverity: Record<Severity, number>;
  byCategory: Record<Category, number>;
  filesReviewed: number;
  filesSkipped: number;
}

export interface ReviewResult {
  pr: string;            // owner/repo#number
  commitSha: string;
  findings: Finding[];
  summary: string;
  stats: ReviewStats;
  status: "pass" | "fail";   // fail = 存在高置信 critical → 阻断
}

// —— 领域类型 ——
export interface PrRef { owner: string; repo: string; number: number; }

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  patch?: string;        // unified diff（二进制为空）
  additions: number;
  deletions: number;
  previousPath?: string;
}

export interface PullRequestData extends PrRef {
  headSha: string; baseSha: string;
  title: string; body: string;
  files: ChangedFile[];
  labels: string[];
}

export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[]; }
export interface DiffLine { kind: "add" | "del" | "ctx"; newLine?: number; oldLine?: number; text: string; }

export interface ReviewUnit { file: string; patch: string; hunks: DiffHunk[]; }
export interface SkippedFile { path: string; reason: string; }

// —— 配置 ——
export interface Config {
  model: string;                 // OPENAI_MODEL
  categories: Category[];        // 启用的维度
  ignoreGlobs: string[];
  maxFiles: number;
  maxDiffBytes: number;
  tokenBudget: number;
  thresholds: {
    postConfidence: number;      // ≥ 才回帖 (FR-6)
    blockSeverity: Severity;     // "critical"
    blockConfidence: number;     // 高置信阈值 (A-7)
  };
  commentLanguage: "en" | "zh";
  skipLabel: string;             // "skip-ai-review"
}

// —— Ports（DI 接缝，可 mock）——
export interface GitHubPort {
  getPullRequest(ref: PrRef): Promise<PullRequestData>;
  postReview(ref: PrRef, review: ReviewPayload): Promise<void>;
}
export interface LLMPort {
  review(unit: ReviewUnit, cfg: Pick<Config, "model" | "categories" | "commentLanguage">): Promise<Finding[]>;
}
export interface ReviewPayload { summary: string; comments: InlineComment[]; event: "COMMENT"; }
export interface InlineComment { path: string; line: number; body: string; }

// —— 纯函数签名（各模块对外暴露的）——
// M3: (files, cfg) => { units, skipped }
// M4: parsePatch(patch) => DiffHunk[];  isCommentable(line, hunks) => boolean
// M7: render({ result, inlineFindings }) => { text, markdownSummary, inlineComments }
//     (anchoring 决策在 M6：用 isCommentable 选出 inlineFindings)
// M6: runReview(ref, { github, llm, config }) => Promise<ReviewResult>
```

要点：
- OpenAI structured outputs strict 模式要求字段全 required + `additionalProperties:false`，可选字段（endLine/suggestion）用 `nullable`；用 `openai/helpers/zod` 的 `zodResponseFormat` 从 zod 直接生成 schema，杜绝非法 JSON。
- `status` 由 orchestrator 依据「存在 severity=critical 且 confidence≥blockConfidence」计算；Action 据此映射 exit code / check 结论。

## 4. 关键技术决策（ADR-lite）

| # | 决策 | 理由 / 取舍 |
|---|---|---|
| D1 | Bun 全套（运行时/包管理/`bun test`） | 已定；DX 最佳。Action 打包见 D9。 |
| D2 | OpenAI structured outputs（zod→json_schema, strict） | 输出强制合规，FR-5 直接满足、FR-9 JSON 风险大降。代价：可选字段需 nullable。 |
| D3 | Ports & Adapters | GitHub/OpenAI 藏接口后 → 可注入 fake、确定性测试；模块解耦才能并行。 |
| D4 | 契约先行（先冻结 M0） | 并行的前提与最强防跑偏手段。 |
| D5 | 核心纯函数 / 副作用隔离 | filter/diff/render/阈值 纯函数，单测便宜。 |
| D6 | CI 内确定性：录制 LLM 响应 | e2e/eval 在 CI 用录制响应，确定可重放、免费、防回归；真调用走 dogfood/nightly。 |
| D7 | Lint+Format = Biome | 单工具、极快、与 bun 搭。 |
| D8 | GitHub 用 Octokit | 成熟、类型好。 |
| D9 | Action = composite（setup-bun + `bun run`） | 避免打包步骤；保持 bun 原生。代价：比纯 JS Action 略非主流。 |
| D10 | 模型可配（`OPENAI_MODEL`） | 默认选当前高能力型号（实现时按 OpenAI 最新可用确认），不写死。 |

## 5. CI/CD 设计（两层）

### 第 1 层 — 项目护栏流水线 `.github/workflows/ci.yml`
触发：`pull_request` + push 到 `main`；`concurrency` 按 ref 取消旧运行。并行 jobs：
- `lint`（biome）、`typecheck`（`tsc --noEmit`）、`unit`（`bun test test/unit`）、`e2e`（`bun test test/e2e`，用录制 fixture，**不调真 API**）、`eval-regression`（对录制响应跑 eval，比对 baseline 阈值）。
- 这些就是多 agent 并行时强制生效的 guardrails——任一 agent 的产出过不了，PR 红。

### 第 2 层 — bot 作为可复用 Action
- 仓库根 `action.yml`（composite）：`oven-sh/setup-bun` → `bun run src/entrypoints/action.ts`。inputs：`openai-api-key`、`github-token`、`model`、`config-path`、阈值等。
- **Dogfooding**：本仓库另有 `.github/workflows/ai-review.yml`，`uses: ./` 调用我们自己的 Action 评审本仓库 PR。`permissions: { contents: read, pull-requests: write }`，带 `concurrency` 与 `skip-ai-review` label 短路。→ 两层在此合一：我们既是作者又是第一个用户。
- secrets：`OPENAI_API_KEY`（repo secret）、`GITHUB_TOKEN`（自动，赋 PR 写权限）。

## 6. 测试与 Eval 策略（落点）

| 层 | 对象 | 怎么做 | 在哪跑 |
|---|---|---|---|
| 单测 | M1/M3/M4/M5(解析)/M7 + M6 阈值逻辑 | 纯函数直接断言；M5 mock OpenAI | 每 PR |
| 集成 | M6 `runReview` 全链路 | fake GitHubPort + fake LLMPort + fixture PR，确定性 | 每 PR |
| e2e（录制） | 入口→render→(mock)回帖 | 真 diff fixture + 录制 LLM 响应 | 每 PR |
| e2e（实弹） | 真 OpenAI + 真 GitHub 测试 PR | CLI 打一个 sandbox repo 的测试 PR | 手动 / nightly（带预算） |
| dogfood | 真实评审本仓库 PR | `ai-review.yml` | 每个真实 PR |
| **eval** | LLM 评审**质量** | 标注数据集 → 打分器 → 各维 precision/recall + 干净 PR 误报率 | CI 跑录制（防回归）；nightly 可实弹 |

**测试 vs eval 的区别（本项目要体会的重点）**：测试断言**确定性逻辑**对错（过滤、diff 定位、渲染、阈值）；eval 度量**不确定的 LLM 质量**（抓没抓到、误报多不多、置信度准不准）。前者红=代码 bug，后者退化=prompt/模型问题。eval baseline 建立后回填需求 §3/§9 的占位阈值。

## 7. 目录结构

```
/
├─ action.yml                     # 可复用 Action（composite）
├─ package.json  tsconfig.json  biome.json
├─ src/
│  ├─ core/contracts.ts           # M0 ← 先冻结
│  ├─ core/config.ts              # M1
│  ├─ github/client.ts            # M2
│  ├─ filter/index.ts             # M3
│  ├─ diff/index.ts               # M4（parse + anchor）
│  ├─ llm/client.ts  llm/prompt.ts# M5
│  ├─ review/run.ts               # M6
│  ├─ render/index.ts             # M7
│  └─ entrypoints/cli.ts  entrypoints/action.ts   # M8
├─ test/{unit,integration,e2e,fixtures}/
├─ evals/{dataset,scorer.ts,run.ts}               # M9
└─ .github/workflows/{ci.yml,ai-review.yml}
```

## 8. MVP 边界（对齐需求 §10）

- **MVP**：M0–M8 核心路径 + 单测/集成/录制 e2e + ci.yml + action.yml + ai-review.yml(dogfood) + M9 一个小 eval 集与打分器。
- **后续**：幂等去重、跨文件/全仓上下文、对话式追问、多平台、实弹 nightly eval 看板。
