# AI Code Review Bot

一个运行在 GitHub PR 上的 AI 代码评审机器人：拉取 diff → 用 OpenAI 从**正确性 / 安全 / 可维护性 / 性能**四个维度评审 → 产出结构化 `Finding[]` → 以**行内评论 + 汇总评论**回帖。TypeScript + Bun 实现。

> 本仓库同时是一次"agent-native 开发流程"的实践记录，规格见 [`docs/specs/`](docs/specs/)。

## 作为 GitHub Action 使用

```yaml
# .github/workflows/ai-review.yml
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/<repo>@v1          # 本仓库 dogfood 时用 `uses: ./`
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4.1
```

- 需要在仓库 Secrets 里设置 `OPENAI_API_KEY`。
- 默认仅评论；当出现**高置信 `critical`** 发现时让 check 失败（配合分支保护可阻断合并）。
- 给 PR 打 `skip-ai-review` label 可跳过本次评审。

## 本地 CLI

```bash
export OPENAI_API_KEY=sk-...   GITHUB_TOKEN=ghp_...
bun run src/entrypoints/cli.ts <owner>/<repo>#<number> [--dry-run] [--json]
#   --dry-run  评审但不回帖   --json  打印结构化结果
```

## 配置（环境变量）

| 变量 | 作用 | 默认 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI 密钥（必填）| — |
| `OPENAI_MODEL` | 模型 id | `gpt-4.1` |
| `GITHUB_TOKEN` | PR 写权限 token | — |
| `AI_REVIEW_MAX_FILES` / `AI_REVIEW_COMMENT_LANGUAGE` / `AI_REVIEW_SKIP_LABEL` | 见 `src/core/config.ts` | — |

## 开发

```bash
bun install
bun run typecheck     # tsc --noEmit
bun run lint          # biome check .
bun test              # 全部单测 + 集成测试
```

约定见 [`CLAUDE.md`](CLAUDE.md)；契约见 `src/core/contracts.ts`（冻结，仅 import）。
