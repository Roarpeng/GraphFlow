# DeepSeek Harness 安装与启用 GraphFlow 项目插件

> 适用：全新 harness（`~/.dsh` 或 DSH_HOME）安装 GraphFlow 插件并启用全部能力
> （10 个 MCP 工具 + 自动会话记录 + 知识节点栏）。

## 前置条件

- Node.js ≥ 20、pnpm（`dsh plugin` 内部转发给 pnpm）
- DeepSeek Harness web 已能启动（`npx @deepseek-ai/dsh web` 或部署版）

## 方式 A：npm 安装（推荐，正式版）

```sh
# 1. 安装插件（装入 web profile 的 bundle 层）
dsh plugin --profile web add @roarpeng/graphflow

# 2. 验证组合配置里出现 graphflow 两行（mcp-graphflow + graphflow-dsh）
dsh --profile web --dump-config | grep -A 20 graphflow

# 3. 重启 harness（web 服务），使 MCP 工具与 glue 生效
```

安装后自动获得：

| 能力 | 载体 |
|---|---|
| 10 个 MCP 工具 `mcp__graphflow__graphflow_*` | `@deepseek-ai/dsh-mcp-client` 行 |
| `graphflow` skill（运行时注册） | `@roarpeng/graphflow/dsh` glue 行 |
| 每轮问答自动记录为对话节点（`agent/inbox/inserted` 挂钩，仅记用户真实提问） | 同上 |
| 回复自动补全（`session/event` 的 assistant/message 挂钩） | 同上 |

## 方式 B：本地开发安装（使用仓库 checkout）

在 GraphFlow 仓库 checkout 内：

```sh
# 1. 构建 dist
npm install
npm run build

# 2. 用本地路径覆盖 profile 依赖（symlink 指向 checkout）
dsh plugin --profile web add /绝对/路径/GraphFlow

# 3. 验证 symlink 与组合配置
ls -la ~/.dsh/profiles/web/node_modules/@roarpeng/graphflow   # -> 指向 checkout
dsh --profile web --dump-config | grep -c graphflow

# 4. 重启 harness
```

> 本地安装时 MCP 行仍以 `npx -y --package=@roarpeng/graphflow graphflow-mcp` 启动
> （npm 版，版本号与 checkout 一致即可）；glue 行直接解析 profile 内的本地包，
> 改动 `dsh/plugin.mjs` 后重启即生效。

## 启用 web 知识节点栏（右侧面板）

知识节点栏是**动态 Cordis 插件**（Host + Client 双半部），每次 harness 启动后需
重新激活（定义在 `web/plugin.mjs`，会话内执行）：

1. 打开任意会话，对 agent 说：
   > 按仓库 `web/plugin.mjs` 中的 `hostHalf()` 与 `clientHalf()` 源码，用
   > cordis_define 创建动态插件（idPrefix `gfweb`）并 cordis_run 激活。
2. 授权 Run 卡片（勾选"信任未来版本"可免重复授权）。
3. 会话头部出现"知识节点"按钮 → 点击打开右侧面板：
   - Workbench 主题树（主线/旁支、活跃、待回复）
   - 对话记录（提炼后的标题/结论摘要，点击节点自动向 agent 注入续聊指令）

> 重启 harness 后动态插件会消失，重新执行步骤 1-2 即可（约 1 分钟）。
> 未来的静态打包（`dsh.client` bundle）会让面板随包持久化，见 `web/README.md`。

## 验证清单

```sh
# 组合配置含 graphflow 行
dsh --profile web --dump-config | grep -c graphflow          # ≥ 4（两行+注释）

# MCP 握手（stdio 冒烟）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
  | npx -y --package=@roarpeng/graphflow graphflow-mcp

# 本地 CLI 建图 + 对话记录
cd 工作区 && graphflow graph index . && graphflow dialogue list --json
```

## 常见问题

| 问题 | 处理 |
|---|---|
| 重启后没有 `mcp__graphflow__*` 工具 | 确认 profile `package.json` 的 `dsh.profile.bundles` 含 `@roarpeng/graphflow`；`dsh plugin --profile web list`；重启 harness |
| 面板空白/加载失败 | 确认工作区已 `graphflow graph index .`（无图则无节点）；点"刷新"；检查会话 cwd 是否正确 |
| 不想自动记录 | 环境变量 `GRAPHFLOW_AUTO_CAPTURE=0` |
| 卸载 | `dsh plugin --profile web remove @roarpeng/graphflow` 后重启 |

## 相关文档

- `web/README.md`：知识节点栏实现说明与静态打包路线
- `ROADMAP.md`：进化方向（R0-R4）
- `plugin.json`：dsh 插件清单（能力/安装/用法）
