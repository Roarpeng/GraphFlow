# 贡献指南（Contributing to GraphFlow）

感谢你愿意参与 GraphFlow。这是一个**单人维护**的开源项目（bus factor = 1），社区协作是项目最需要的事——无论是修一个 bug、补一条文档，还是提一个复现 issue，都能直接降低单点风险。

- 项目定位与能力：[README.md](README.md)
- 下一步计划：[ROADMAP.md](ROADMAP.md)
- 提问与讨论：[Discussions](https://github.com/Roarpeng/GraphFlow/discussions)
- 问题与需求：[Issues](https://github.com/Roarpeng/GraphFlow/issues)（请使用仓库内置的 [bug / feature 模板](.github/ISSUE_TEMPLATE/)）

## 开发环境

| 要求 | 版本 |
| --- | --- |
| Node.js | ≥ 20（CI 矩阵：20 / 22） |
| npm | ≥ 10 |

```bash
npm install   # postinstall 为安全脚本，无副作用
```

> 注意：本机不联网也能开发。测试默认注入隔离配置（`tests/helpers/no-llm-config.ts`），不会触发真实 LLM 网络调用。

## 验证流程

- **局部验证（推荐，快）**：
  ```bash
  npx eslint <你改动的文件>
  npx vitest run tests/<你的新测试文件>.test.ts
  ```
- **完整验证（提交前 / PR 前必须）**：`npm run ci` 一次跑完 lint + build + 测试 + 扩展打包 + 扩展测试：
  ```bash
  npm run ci
  ```
  `npm run ci` 等价于 `npm run lint && npm run build && npm test && npm run build:extension && npm run test:extension`。

### CI 还会做什么

GitHub Actions（`.github/workflows/validate.yml`）在 lint / build / test 之外还执行：

- **版本一致性门禁**（`scripts/ci-version-check.cjs`）：package.json 版本号、CHANGELOG 最新条目、README 版本徽章三源必须一致——改版本时三处同步。
- **检索 golden set 回归门禁**：压缩 / 排序 / 召回相关改动必须保证召回率 ≥ 80% 且 Top-K 合规 ≥ 90%（132 条查询、9+ 域、含位置断言），防止检索质量悄悄劣化。
- **skill A/B 基准 job**（`benchmarks/run-skill-ab.ts` 存在性守卫）。

本地也可单独跑 `npx vitest run tests/retrieval-golden.test.ts` 验证检索回归。

## 代码规范

- **ESLint**：配置见 `eslint.config.js`（@typescript-eslint）——`no-explicit-any`、`no-unused-vars`（`^_` 前缀豁免）、`consistent-type-imports` 均为 error。
- **Prettier**：`.prettierrc`——semi 开启、单引号禁用、trailingComma `es5`、printWidth 100。
- **TypeScript strict**：`tsconfig.json` 全程 strict，新代码必须通过类型检查。
- **命名**：API / 变量 / 文件名用英文；注释与文档中文可接受（仓库现状如此）。
- **兼容性铁律**：**新行为默认关闭（feature flag）或严格向后兼容**——不得改变既有默认路径的行为；MCP 工具入参/返回值只做增量扩展。
- **依赖**：不要随手改 `package.json` / `package-lock.json` / `tsconfig.json` / `vitest.config.ts`（除非改动本身就需要），避免制造 lock 冲突与无关 diff。
- **Hook**：仓库配置了 husky pre-push（`npm run lint` + 文档一致性测试 m48）+ lint-staged（提交前自动 `eslint --fix`）。

## Commit 约定（Conventional Commits）

提交信息采用 conventional 风格，与仓库既有历史一致（参照 `git log` 与 [CHANGELOG.md](CHANGELOG.md) 头部规范）：

```
<type>(<scope>): <subject>
```

- **type**：`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `ci`
- **scope**（可选）：`graph` / `mcp` / `cli` / `learning` / `core` / `vscode` / `docs` / `release` 等
- 示例：`feat(mcp): expose graphflow://diagnose MCP resource`、`fix(graph): exclude agent work dirs from indexing`

**每次用户可见的变更必须在 CHANGELOG.md 增加条目**（格式：版本号 + 日期 + `Added` / `Changed` / `Fixed` / `Removed` 小节 + 中文描述，可附 P0–P4 优先级标注），与代码在同一 PR 内提交。

## 测试要求

- 测试框架为 **vitest**；**新测试必须新建 `tests/<name>.test.ts` 文件**，不要修改现有测试文件（它们是历史回归的保险丝）。
- **每条新行为都要有对应测试**：新增能力 → 新增用例；修复 → 先写复现用例再修。
- 复用测试基建：`tests/helpers/setup.ts`（默认 2s provider/embedding 超时）、`tests/helpers/no-llm-config.ts`（隔离配置工厂）。
- 检索 / 压缩 / 排序改动必须跑 `tests/retrieval-golden.test.ts`，不得让召回率跌破 80%。
- **MCP 工具面（10 个）不可破坏**：`graphflow_context` / `graphflow_plan` / `graphflow_run` / `graphflow_report_outcome` / `graphflow_insight` / `graphflow_index` / `graphflow_skill_insights` / `graphflow_diagnose` / `graphflow_artifact` / `graphflow_skill_guide`——不得改名、删减或破坏性改 schema；新增工具可以。
- 测试必须**确定性、离线**：不要依赖外网可达性或本机 ambient API key（用 `tests/helpers` 注入隔离配置）。

## PR 检查清单

提交 PR 前逐项核对：

- [ ] `npm run lint` 通过（无 error）
- [ ] 新增测试在 `tests/` 新文件，且 `npx vitest run tests/<新文件>.test.ts` 通过
- [ ] 涉及检索 / 压缩：`npm test` 全量通过（当前 95 文件 / 656 tests 全绿），召回门禁未破
- [ ] 未破坏 10 个 MCP 工具面；新增入参 / 返回字段为增量、向后兼容
- [ ] 新行为默认关闭（feature flag）或严格向后兼容
- [ ] TypeScript strict 通过（`npm run build` 无类型错误）
- [ ] CHANGELOG.md 已加条目（同 PR）；若改版本号，package.json / CHANGELOG / README 徽章三源一致
- [ ] 用户可见行为变化已在 README.md 对应小节说明
- [ ] 未改动本任务范围之外的文件（保持 diff 最小）

## 提交流程

1. 从 [Issues](https://github.com/Roarpeng/GraphFlow/issues) 认领或新建 issue（新建时使用仓库内置的 [bug / feature 模板](.github/ISSUE_TEMPLATE/)，方便维护者快速定位版本与复现信息），在 PR 描述中关联（`Closes #<n>`）。
2. 分支命名建议：`<type>/<简述>`（如 `fix/graph-index-ignore`）。
3. 提交 PR 后等待 CI（validate：Node 20/22 矩阵 + lint + build + 656 tests + 扩展构建与测试）。
4. 项目由单人维护，review 可能比大团队慢——请耐心，维护者会尽快处理；紧急问题可在 issue 里 @ 维护者。

## 成为维护者

目前项目是单人维护。长期、稳定、质量过关的贡献者会获得协作者权限（共同维护 CHANGELOG 与发版），这也是缓解 bus factor 的核心路径。从小 issue 起步即可。
