# 需求文档 — AI 代码评审 PR 机器人

> 阶段 1 产出物 / 流程中的「事实来源」。下游的系统设计、任务拆分、测试、evals 都以本文为准。
> 状态：**待评审**（确认「假设与待确认」一节后冻结）。

## 1. 概述

一个运行在 GitHub Pull Request 上的 AI 代码评审机器人。当 PR 创建或更新时，它拉取 diff，用 LLM 从**正确性 / 安全 / 可维护性 / 性能**四个维度评审，产出**结构化发现（JSON）**，并以**行内评论 + 一条汇总评论**的形式回帖到 PR。

本项目同时是学习 agent-native 开发流程的载体，因此每个阶段都会刻意产出可评审的 artifact。

## 2. 目标与非目标

### 目标
- 在 PR 上给出**高信噪比**的评审意见，覆盖四个维度。
- 输出**结构化**，既能被工具链消费，也能渲染成人读评论。
- 评审质量**可量化评测**（precision / recall / 误报率）。
- 作为独立 GitHub Action，与现有 CI/CD（lint / 类型 / 测试）**并存互补**——不替代；对高置信 `critical` 级发现阻断合并，其余仅评论。

### 非目标（MVP 明确不做，用于防止跑偏）
- 不自动修改代码 / 不提 commit（只评审，不改）。
- 不做全仓库静态分析（只看 PR diff + 必要上下文）。
- 不替代 CI 里的 lint / 类型检查 / 测试（互补，不重复它们能做的）。
- 不支持非 GitHub 平台（GitLab / Bitbucket 等）。
- 不做多轮对话式评审（对评论追问）——列入后续。
- 不自己编译 / 运行用户代码。

## 3. 用户与场景

- **Persona A — 仓库维护者**：希望在人工 review 前先得到一轮自动反馈，抓住低级 bug 和安全问题，减轻 reviewer 负担。
- **Persona B — PR 作者**：希望尽早拿到精确到行的反馈，自查后再请人 review。
- **典型场景**：开发者推 PR → bot 在数分钟内回帖 → 作者据此修正 → 人工 reviewer 面对更干净的 PR。

## 4. 用户故事 + 验收标准（Given/When/Then）

> 这些 AC 会直接转化为测试用例和 eval 样本。

**US-1（自动触发）** 作为维护者，当有人开 PR 时，bot 自动评审，无需手动触发。
- AC-1.1：Given 已配置 bot 的仓库，When PR 被 `opened` 或 `synchronize`（推新 commit），Then bot 自动开始评审。
- AC-1.2：Given PR 只改了文档 / lockfile / 生成文件，When bot 运行，Then 这些文件被跳过、不消耗评审预算。

**US-2（精确定位）** 作为 PR 作者，我希望意见指到具体行。
- AC-2.1：Given 一条发现，When 回帖，Then 评论锚定到 diff 中的「文件 + 行」；若该行不在 diff hunk 内，则降级到文件级或汇总评论（GitHub 仅允许评论改动行）。
- AC-2.2：每条发现含：维度 category、严重度 severity、标题、说明、（可选）修复建议、置信度。

**US-3（低误报）** 作为维护者，我希望低误报，从而信任它。
- AC-3.1：Given 产出发现，When 置信度低于阈值，Then 不回帖（仅进 JSON 或丢弃）。
- AC-3.2：bot 在评测集上 precision ≥ 目标基线（基线数值在 design/eval 阶段确定，此处占位）。

**US-4（不刷屏，Should-have）** 作为维护者，PR 多次更新不应重复刷评论。
- AC-4.1：Given PR 推了新 commit，When 重新评审，Then 不重复发已存在且仍适用的评论（幂等 / 去重）。

**US-5（结构化结果）** 作为工具链使用者，我希望拿到结构化结果。
- AC-5.1：bot 产出符合约定 schema 的 JSON（作为 artifact 与 stdout），同时渲染成 PR 评论。

## 5. 功能需求（FR）

- **FR-1 触发**：支持 GitHub Actions 在 `pull_request`（opened / synchronize）触发；同时提供 CLI 入口 `review <owner/repo#pr>`，便于本地运行与 e2e 测试。
- **FR-2 拉取**：通过 GitHub API 获取 PR diff / changed files，及评审所需的必要文件上下文。
- **FR-3 过滤**：跳过二进制、lockfile、生成文件、超大文件；支持可配置 ignore glob。
- **FR-4 评审**：将过滤后的 diff + 上下文交给 LLM，按四维度产出发现。
- **FR-5 结构化**：发现遵循统一 schema（见 §7）。
- **FR-6 阈值过滤**：按 severity / confidence 阈值过滤后再回帖。
- **FR-7 回帖**：发起一次 PR review，含行内评论（锚定 diff 行）+ 一条汇总评论（统计 + 概述）。
- **FR-8 输出**：同时产出 JSON artifact。
- **FR-9 鲁棒**：LLM 输出非法 JSON 时重试 / 修复；API 失败可重试并清晰报错；评审失败不应让 CI 崩（fail / neutral 可配置）。

## 6. 非功能需求（NFR）

- **NFR-1 性能**：中等 PR（≤ ~30 文件 / ~1k 行 diff）在数分钟内完成。
- **NFR-2 成本**：单次评审有 token / 调用预算上限；大 PR 走分块 / 抽样。
- **NFR-3 安全**：密钥只从环境 / secrets 读，不落日志；GitHub token 最小权限；代码不发往约定 LLM 之外的地方。
- **NFR-4 可靠性**：触发幂等；瞬时失败可重试。
- **NFR-5 可测试性**：过滤 / 解析 / 行锚定 / 阈值等核心逻辑设计为纯函数、可单测；GitHub 与 LLM 通过接口抽象以便 mock；提供 e2e 在样例 PR 上跑通。
- **NFR-6 CI 共存（好公民）**：作为独立 workflow 与现有 CI/CD 并行；最小权限（`contents:read` + `pull-requests:write`）；`concurrency` 在同 PR 推新 commit 时取消旧运行；**仅高置信 `critical` 发现使 check 失败、阻断合并**，其余仅评论；提供逃生阀（`skip-ai-review` label、阈值可配）；自身运行错误（区别于评审结论）不应误判为失败而拖垮流水线。

## 7. 输出契约（Finding Schema）

> 这是下一阶段「接口契约」的种子，各并行模块据此对齐。

```
Finding {
  file: string                       // 相对仓库根路径
  line: number                       // 锚点：diff 新文件侧行号
  end_line?: number
  severity: "critical" | "high" | "medium" | "low"
  category: "correctness" | "security" | "maintainability" | "performance"
  title: string                      // 一句话
  description: string                // 为什么是问题
  suggestion?: string                // 怎么改（可含代码）
  confidence: number                 // 0..1
}

ReviewResult {
  pr: string                         // owner/repo#number
  commit_sha: string
  findings: Finding[]
  summary: string
  stats: { by_severity, by_category, files_reviewed, files_skipped }
}
```

## 8. 假设与待确认（请你拍板 / 修改）

- **A-1 LLM**：**OpenAI API**；用 structured outputs（`response_format: json_schema`）保证 Finding schema 合法（直接满足 FR-5、降低 FR-9 的 JSON 解析风险）。具体模型设计阶段定，且做成可配置（`OPENAI_MODEL`）。
- **A-2 触发形态**：优先实现 **GitHub Action + CLI 双入口**，不自建 webhook 服务（更重）。
- **A-3 评审粒度**：MVP 以单文件粒度为主，跨文件关联列为 should-have。
- **A-4 幂等去重（US-4）**：列为 should-have；MVP 可先简单处理（如仅 `opened` 触发，或每次重发）。
- **A-5 评论语言**：默认英文（开源习惯）；可改中文。
- **A-6 实现 & 评测语言**：评审本身语言无关（LLM 处理任意语言，仅文件过滤等启发式与语言弱相关）。**本项目用 TypeScript 实现**；eval / dogfood 默认聚焦 TS——让 bot 评审**自己的 PR**，作为最真实的 e2e 与持续验证。
- **A-7 合并策略**：**对 `critical` 级发现让 check 失败、阻断合并**。为控误报：仅「高置信 critical」触发阻断，并提供逃生阀（`skip-ai-review` label / 阈值可配）。

## 9. 验收 / Evals 标准

- **评测集**：一组带「已知问题标注」的真实 / 构造 PR——每个维度都有正样本，外加一部分「干净」PR 用于测误报。
- **指标**：每维度 precision / recall；整体误报率；置信度校准。
- **通过线**：在 eval 阶段建立 baseline 后设定阈值（此处占位）。
- **整体验收**：所有 AC 对应测试通过 + e2e 在样例 PR 上跑通 + eval 指标达到设定阈值。

## 10. 范围（MVP vs 后续）

- **MVP**：FR-1~FR-9 核心路径（Action+CLI 触发、拉取、过滤、四维评审、JSON、行内+汇总回帖、阈值过滤、基本鲁棒）+ 单测 + e2e + 一个小 eval 集。
- **MVP（CI/CD，两层）**：① 项目自身流水线——每个 PR 自动跑 lint / 类型 / 单测 / e2e / eval（开发护栏）；② bot 以可复用 GitHub Action 形式打包（`uses:` 即可引入）。
- **后续**：幂等去重、跨文件 / 全仓上下文、对话式追问、多平台、自动应用修复建议。
