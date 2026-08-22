# MCP 协议演进 Roadmap — 无状态规范（2026-07-28）适配

> 状态：**v1.12.1 已落地（GraphFlow 支持的 transport 矩阵）** ｜ 适用版本：`@roarpeng/graphflow` v1.12.1 ｜
> 当前 SDK：`@modelcontextprotocol/sdk` `^1.30.0` ｜
> 当前协议：stdio 继续协商 `2025-11-25`；`server/discover` 返回 draft `DRAFT-2026-v1` ｜
> 关联代码：`src/surfaces/mcp/server.ts`、`src/surfaces/mcp/tool-definitions.ts`

## 0. v1.12 落地状态

- ✅ SDK 升级到 1.30。
- ✅ 工具 schema 声明 JSON Schema 2020-12。
- ✅ 所有工具结果保留 `content[0].text` 兼容层，并新增 `structuredContent`。
- ✅ 手写兼容层支持 `server/discover`；旧 `initialize` / `ping` stdio 路径继续可用。
- ✅ Streamable HTTP server transport：stateless JSON 与 stateful SSE 均可用，默认 loopback + Host/Origin 防护。
- ✅ 客户端矩阵：SDK Client 分别通过 HTTP JSON 和 stateful SSE；raw 请求覆盖 discovery、initialize、ping、tools、resources、structured tool result、DELETE 后 stale session、非法路径/Origin 与非 loopback 保护；stdio legacy handshake 由既有 MCP integration 覆盖。

## 1. 背景：2026-07-28 无状态规范改版要点

MCP 官方在 2026-07-28 发布无状态（stateless）规范改版，核心变化：

| # | 变更 | 含义 |
| --- | --- | --- |
| 1 | **移除 `initialize` 握手** | 客户端不再需要先 `initialize` 再发业务请求；`initialize` / `initialized` 通知不再是强制前置步骤 |
| 2 | **新增 `server/discover`** | 客户端通过 `server/discover` 发现服务器 capabilities / 协议信息，取代握手协商 |
| 3 | **每请求 `_meta` 协议信息** | 协议版本、capabilities 等协议信息随每个请求的 `_meta` 携带，服务器按请求判断能力 |
| 4 | **JSON Schema 2020-12** | 工具输入 schema 由旧 draft 迁移到 2020-12 dialect（`$schema` 标注、`additionalProperties` 语义等） |
| 5 | **`ping` / `logging` 12 个月弃用窗口** | `ping` 与 `logging` capability 进入弃用（deprecation）状态，官方给出 12 个月过渡窗口，窗口内继续支持 |

## 2. 当前实现与依赖面（v1.9.5）

GraphFlow 的 MCP 面目前完全基于官方 SDK（v1.9.4 起引入，协议 `2025-11-25`），
自带能力声明与处理路径如下：

- **SDK 承载握手**：`server.ts` 中 `new Server(...)` 注册 `capabilities:
  { tools, logging, resources }`；`StdioServerTransport` + SDK 内部完成
  `initialize` 协商与 `LATEST_PROTOCOL_VERSION` 版本选择。
- **手写兜底分支**：`handleRequest` 保留 `initialize` / `ping` /
  `notifications/initialized` 三个分支（协议版本协商返回
  `LATEST_PROTOCOL_VERSION`；`ping` 返回 `{}`；`initialized` 通知静默忽略），
  其余方法走 SDK 注册的 handler（`ListToolsRequestSchema`、
  `CallToolRequestSchema`、`SetLevelRequestSchema`、`ListResourcesRequestSchema`、
  `ReadResourceRequestSchema`）。
- **progress / logging 通知**：`sendProgress` / `sendLogNotification` 通过
  SDK `notification()` 发出；`attachMcpLogSink` 把日志接到 `logging` 通知上。
- **资源面（P2-1 新增）**：`graphflow://diagnose`、`graphflow://stats`、
  `graphflow://flywheel`、`graphflow://atp-ir`，全部只读。

### 2.1 当前 ping 依赖点（升级复核重点）

`ping` 目前有两层用途，升级时必须逐点复核：

1. `handleRequest` 中的 `case "ping": return respond(id, {})` —— 手写分支。
2. 客户端侧心跳：MCP 客户端（Cursor / Claude Code / 自研 stdio 客户端）用
   `ping` 探测服务器存活；若客户端随规范切换到 `server/discover` 或改用
   `_meta` 探活，服务器无需再响应 `ping`，但**在 12 个月弃用窗口内仍应响应**
   以兼容旧客户端。
3. SDK 内部对 `ping` 的默认处理：SDK `Server` 自带 `ping` 请求处理
   （`PingRequestSchema` 已注册），升级 SDK 后手写分支与 SDK 内置处理可能
   重叠 —— 复核清单要求确认二者不冲突（重复响应同一 id 或提前 return）。

## 3. 影响评估：无状态规范 × 当前 SDK 1.29

| 规范变更 | 对当前实现的直接影响 | 严重度 |
| --- | --- | --- |
| 移除 `initialize` 握手 | SDK 1.29 仍按旧协议协商；新规范下客户端不发 `initialize`，旧 SDK 的 `Server` 会因缺少握手而拒绝/等待业务请求 | 高 |
| 新增 `server/discover` | 旧 SDK 未实现 `server/discover` 方法，新客户端无法发现 capabilities | 高 |
| 每请求 `_meta` 协议信息 | 旧 SDK 不生成/不消费 `_meta` 协议字段；GraphFlow 仅在工具调用时读取 `_meta.progressToken`（`tool-handlers.ts` `readProgressToken`），字段名兼容 | 低 |
| JSON Schema 2020-12 | 工具定义 `inputSchema` 为手写 JSON（`tool-definitions.ts`），当前无 `$schema` 标注；2020-12 下 `additionalProperties: false` 语义保持，但需按 dialect 复核 | 中 |
| `ping` / `logging` 12 个月弃用 | `logging` capability 与 `sendLogNotification` 在窗口内继续可用；`ping` 手写分支在窗口内保留 | 低 |

**结论：SDK 1.29 无法直接对接无状态客户端，必须升级 SDK。**

## 4. 升级路径评估（分阶段）

### Phase 1 — 升级 SDK（获得兼容性的主路径）

将 `@modelcontextprotocol/sdk` 升级到支持无状态规范的版本（目标版本以
官方发布为准；预期新 SDK 同时兼容旧握手与无状态两种模式，由 SDK 内部按
客户端首包自动选择协议模式）。

- 期望行为：**升级 SDK 即自动获得兼容** —— 协议协商、`server/discover`
  响应、`_meta` 协议信息、JSON Schema 2020-12 转换全部由 SDK 承担；
  GraphFlow 侧无自研协议解析，工具/资源/日志注册接口不变。
- 验证：`npm run test`（656 个既有用例，尤其 `m55-mcp-integration.test.ts`
  与新增 `tests/mcp-resources.test.ts`）、手工 stdio 冒烟（见 §6）。

### Phase 2 — 清理手写兼容分支

升级验证通过后，删除 `handleRequest` 中的 `initialize` / `ping` /
`notifications/initialized` 手写分支，交由 SDK 处理：

- `initialize` → SDK 内置握手（或无状态模式下自动跳过）。
- `ping` → SDK 内置 `PingRequestSchema` 处理；若仍需显式空响应，改为在
  SDK 上注册 `PingRequestSchema` handler 而非手写 JSON 分支。
- `notifications/initialized` → 无状态规范下不再需要，SDK 负责忽略。

### Phase 3 — JSON Schema 2020-12 与弃用窗口管理

- `tool-definitions.ts`：按 2020-12 dialect 为每个工具 `inputSchema` 补
  `$schema: "https://json-schema.org/draft/2020-12/schema"`（或依赖 SDK
  自动标注），复核 `type/properties/required/additionalProperties` 语义。
- `logging`：12 个月弃用窗口内保留 `logging: {}` capability 与
  `sendLogNotification`；窗口结束后评估迁移到 `_meta`/日志替代通道。
- 保持响应旧客户端 `ping` 的能力，直到窗口结束或客户端矩阵全部升级。

## 5. 结论：升级 SDK 即自动获得兼容

GraphFlow 的 MCP 面是**纯 SDK 委托**架构：除 `handleRequest` 的少量
JSON-RPC 兼容分支外，所有协议行为（版本协商、方法路由、通知发送、schema
校验）均由官方 SDK 实现。因此：

> **结论：升级 `@modelcontextprotocol/sdk` 到支持 2026-07-28 无状态规范的
> 版本后，GraphFlow 自动获得新协议兼容（`server/discover`、每请求 `_meta`
> 协议信息、JSON Schema 2020-12），无需改动工具/资源注册代码。**
> 唯一需要人工跟进的是 12 个月弃用窗口内的 `ping` / `logging` 依赖点。

### 5.1 升级复核清单（升级后逐项验证）

- [ ] **ping 依赖（最高优先）**：手写 `case "ping"` 分支是否与 SDK 内置
      `PingRequestSchema` 处理冲突；旧客户端心跳是否仍得到 `{}` 响应；
      无状态客户端是否已改用 `server/discover` / `_meta` 探活。
- [ ] `initialize` 分支：旧握手模式仍可用（旧客户端矩阵未升级完的过渡期）。
- [ ] `notifications/initialized` 路径：SDK 无状态模式下不再发送/要求。
- [ ] `LATEST_PROTOCOL_VERSION`：升级后确认协商值与新规范一致；服务器
      `serverInfo` 版本（`PACKAGE_VERSION`）正常上报。
- [ ] `tools/list`：10 个工具定义原样返回（设计红线：工具面零改动），
      `inputSchema` 通过 2020-12 校验。
- [ ] `resources/list` + `resources/read`：4 个资源（diagnose/stats/
      flywheel/atp-ir）在无状态下正常枚举与读取；未知 URI 仍返回 `-32602`。
- [ ] `logging` / `progress` 通知：`sendLogNotification` / `sendProgress`
      在弃用窗口内行为不变；`SetLevelRequestSchema` handler 正常。
- [ ] 客户端矩阵：Cursor、Claude Code、自研 stdio 客户端分别冒烟
      （详见 §6）。

## 6. 冒烟与回归

- 单元：`npx vitest run tests/mcp-resources.test.ts tests/m55-mcp-integration.test.ts`
- CLI 冒烟：`npx tsx src/surfaces/mcp/cli-smoke.ts`（或等价 stdio 脚本），
  依次发送 `server/discover`（升级后）→ `resources/list` → `resources/read
  graphflow://atp-ir` → `tools/list` → `tools/call graphflow_diagnose`，
  校验响应结构与错误码（未知 URI → `-32602`、未知方法 → `-32601`）。
- 工具面回归：`graphflow_plan` / `graphflow_context` / `graphflow_index`
  在 Cursor 与 Claude Code 各跑一遍全链路。

## 7. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 新 SDK 无状态模式与旧客户端（未升级的 Cursor 版本）不兼容 | 优先选择同时支持握手与无状态双模式的 SDK 版本；Phase 2 清理手写分支前先完成双客户端冒烟 |
| `ping` 手写分支与 SDK 内置处理重叠，导致双响应或提前返回 | 升级后立即复核 §5.1 第一项；确认 SDK 的 `ping` handler 注册语义 |
| `logging` 弃用窗口结束后日志通道断供 | 窗口内规划 `_meta` / 文件日志替代；`sendLogNotification` 保持 no-op 安全 |
| 工具 schema 迁移 2020-12 引入兼容性偏差（如 `additionalProperties` 校验变严） | Phase 3 单独提交，跑全量 656 用例 + 客户端冒烟后再合入 |
