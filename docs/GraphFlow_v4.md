# GraphFlow 插件深化执行任务清单（v4 提案）

**基线**：`Roarpeng/GraphFlow`，`main`，提交 `5536fb3`，package v3.9.2。审查基于静态源码，未重新运行测试/基准。

## 产品红线

- 只保留四个 MCP 工具：`gf_read`、`gf_edit`、`gf_exec`、`gf_macro`；新增能力作为内部模块和可选参数。
- 不开发模型路由、LLM 代理、云端记忆、通用 Agent、自动跨任务规划。
- 工具调用默认纯本地，兼容已有 CLI/MCP/22 宿主；新参数必须向后兼容。
- 无真实 API usage 时，所有 Token 数只能称为估算或工具文本量，不得冒充账单。

## P0 — 先让正确性/安全性可信

### PR 0 — A/B 任务基线
- 建立 30–50 条真实任务：代码定位、单文件修改、跨文件重构、依赖/调用方识别、测试失败诊断、重复命令复用；固定工作区 SHA 和验证脚本。
- 记录成功率、耗时、工具返回文本 Token 近似值、测试执行次数、失败重试次数；仅当宿主提供 usage 才测真实费用。

### PR 1 — `gf_edit` 写前事务
- 目标文件：`src/surgical-edit.ts`、`src/mcp-tools.ts`。
- 将跨文件导出引用、参数个数、字段移除、相对导入等检查移到所有文件写盘之前，允许策略区分 WARNING/BLOCK。
- 新增 `mode=prepare|commit`、`proposalId`、`expectedSha256`、事务恢复日志；磁盘异常必须可恢复。
- 安全失败不改动任何受管理文件。不要承诺跨多个文件的文件系统原子性；需用日志回滚来实现应用层事务。
- 测试：中途写入失败、跨文件契约不兼容、旧快照冲突、并发提交、符号改名和类型闭包回归。

### PR 2 — `gf_macro` 权限与可信执行
- 目标文件：`src/macro-engine.ts`、`src/task-reflector.ts`、`src/host-interceptor.ts`。
- 宏状态：`discovered → proposed → approved → active → revoked`。
- 从脚本的独立 `replaceAll` 文件写入统一走 `gf_edit` 事务；命令模板使用安全 argv/参数化模式，必要时采取严格命令白名单。
- 通过 Prompt Reflex 自动执行的命令需为显式预授权、低风险动作；启动程序、写文件、网络和外部副作用不得默认自动放行。
- 测试：命令注入、越权路径、项目版本变化、用户撤销和失败后状态清理。

### PR 3 — Tool Benefit Ledger
- 新增 `src/evidence-ledger.ts`，在 MCP 和 CLI 两层写标准化的本地工具回执。
- 字段：`taskId?`, `tool`, `workspaceHash`, `artifactHash`, `estimatedOutputTokens`, `durationMs`, `testStatus`, `verifiedOutcome?`, `observedModelUsage?`。
- 仅存摘要/哈希和必要诊断；默认不存原始提示词、API 密钥与完整源码。
- 无可用任务结果时明确 UNKNOWN，不根据「工具返回 OK」判断任务成功。

## P1 — 提升 Token 效率而不牺牲完成率

### PR 4 — `gf_read` Budget + Delta + Receipt
- 目标文件：`src/slicer.ts`、`src/mcp-tools.ts`、`src/circuit-breaker.ts`。
- 新增 `detail=locate|summary|code|closure`、`maxOutputTokens`、`sinceReceipt`、`cursor`，省略必须显式告知并可继续读取。
- 同 SHA 命中可以只返回证据 ID；跨分支与文件改变必须失效，禁止旧证据误命中。
- 对照黄金符号/依赖集，确保 Recall@k 不下降。

### PR 5 — `gf_exec` Test Evidence + Failure Fingerprint
- 目标文件：`src/dehydrator.ts`、`src/circuit-breaker.ts`、`src/mcp-tools.ts`。
- 返回被选择测试清单、原因、未覆盖风险和结构化状态 `PASS | FAIL | NO_TESTS | UNKNOWN | TIMEOUT`。
- 失败指纹由错误码、位置、测试名、调用栈根、代码改动 SHA 形成；三次连续同类失败且无新证据时给硬停止/用户覆盖选项（须适配宿主能力）。
- 风险高/推断不确定时执行更广验证或标记 UNKNOWN，不能把无测试判 PASS。

### PR 6 — Verified Recipe
- 基于现有 macro/reflect/trajectory 将成功操作升级为可复现配方。
- 必须包含来源证据、前置条件、版本范围、输入参数、验证脚本及权限；验证失败时降级/撤销。

## P2 — 进一步提高解析精度

### PR 7 — Optional LSP Confidence Escalation
- 现有 `src/lsp-bridge.ts` 作为可选后备；AST/语义索引低置信度或引用歧义时，才尝试 LSP definition/references。
- LSP 不可用应快速降级，不影响原有接口和速度；要测试置信度、精度、时延与内存。

## 验收与发布

1. 回归 `npm test`、`npm run build`、`npm run verify:parsers`、`npm run preflight`，按需跑新增专用测试。
2. 对照 v3.9.2 基线：任务成功率不下降；所有已知危险写入场景在提交前拒绝，或在中断后可靠恢复。
3. 试验目标：检索 P95 输出 Token 降 ≥20%，同一真实任务集平均成功任务费用降 ≥20%（仅当可观测 usage），具体达标依赖实测。
4. 宿主支持无法实现的硬停止必须显式降级为建议，禁止在报告里冒充强制拦截。
5. 修正 README 中 `affected-tests` “2-hop” 与当前代码 `MAX_ROUTING_HOPS=6` 的不一致。

详见随附交互式 HTML 开发报告。
