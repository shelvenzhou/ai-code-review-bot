# CLAUDE.md — AI 代码评审 PR 机器人（团队约定）

> 每个 agent 进场**先读本文件**。这是共享上下文与防跑偏规则。规格见 `docs/specs/`（01 需求 / 02 设计 / 03 任务）。

## 项目一句话
运行在 GitHub PR 上的 AI 代码评审机器人：拉 diff → 用 OpenAI 从「正确性/安全/可维护性/性能」四维评审 → 产出结构化 `Finding[]` → 回帖（行内 + 汇总）。TS + Bun 实现。

## 🔒 头号规则：契约冻结
- `src/core/contracts.ts` 是**冻结的**。只能 `import`，**禁止修改**。
- 若你认为契约缺字段 / 需变更 —— **停下来，走下面的「契约变更协议」**。**绝不擅自改契约或绕过它**。

## 🔁 契约变更协议（发现 contracts.ts overfit / 不够用怎么办）
「冻结」= **单一写者 + 禁止擅自改**，不是永不改。并行的敌人是**发散的**变更，不是变更本身。
1. **别绕过**：不在你的 worktree 改 `contracts.ts`，不用 `as any` / 类型断言硬凑。
2. **能局部解决就局部**：若问题只涉及你模块内部类型（不跨模块）→ 自定义内部类型解决，不动契约。
3. **是契约问题就上报**：在产出里写一段 `## 契约反馈`——涉及的类型/方法、当前接口为什么表达不了（overfit 在哪）、**最小**改动提案、阻塞级别（blocking / non-blocking）。
4. **阻塞时**：把不依赖该改动的部分先做完，其余留 TODO，返回报告——不卡死、不自由发挥。
5. **裁决（集成者=单一写者）**：内部问题→退回局部解决；**加性变更**（加可选字段 / 新别名 / 放宽 union）→直接改并广播，成本低；**破坏性变更**（改签名 / 重命名 / 必填）→设 checkpoint，改后受影响的 worktree rebase 同步。
6. 只有集成者改 `contracts.ts` 提交基线，其它人 rebase 取得 → 契约永不并行冲突。被改动影响的 agent，重跑那一个即可。

## 🧭 作用域（禁区）
- 只动**你工单指定的文件**（一般是 `src/<你的模块>/**` + 对应 `test/unit/<你的模块>/**`）。
- 不碰别的模块、不碰 CI/workflows、不碰 `package.json` 依赖（需加依赖先在产出里说明）。

## 🛠 命令
```bash
bun install
bun run typecheck     # tsc --noEmit
bun run lint          # biome check .   （bun run lint:fix 自动修）
bun test test/unit/<你的模块>
```

## ✅ 完成定义（DoD，每个工单都要满足）
1. `bun run typecheck` 通过
2. `bun run lint` 通过
3. 你模块的 `bun test` 全绿
4. 对外导出与 `contracts.ts` 一致（函数用 `satisfies` 对应的类型别名）
5. **未修改** `contracts.ts`

## 📐 代码约定
- TypeScript strict；ESM；`import` 带 `.ts` 后缀（Bun + bundler 解析）。
- 风格交给 Biome：双引号、2 空格、行宽 100（`bun run lint:fix` 自动）。
- 禁用 `any`；优先 `unknown` + 收窄。优先**纯函数**，副作用只放在 adapter（github/llm）。
- 错误处理：adapter 把外部错误包成清晰的领域错误再抛；纯函数对非法输入抛 `Error` 或返回明确空值（按契约）。
- 不 `console.log` 调试残留；需要日志走统一入口（入口模块负责）。

## 🧪 测试约定
- 用 `bun:test`：`import { describe, test, expect } from "bun:test"`。
- 纯模块（filter/diff/render/config）：表驱动、覆盖边界。
- adapter（github/llm）：注入 mock，不打真实网络。
- 测试文件：`test/unit/<模块>/<name>.test.ts`。

## 🔌 关键技术点
- LLM 用 **OpenAI structured outputs**（`openai/helpers/zod` 的 `zodResponseFormat`）保证输出合法 JSON。
- 契约里 `Finding` 的可选字段用 `optional`（idiomatic）；**LLM adapter 需另建 strict 变体**（可选字段 nullable）供 structured outputs，并把 `null` 归一为 `undefined`。
- 模型 ID 走 `OPENAI_MODEL`，不写死。
