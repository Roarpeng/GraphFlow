# GraphFlow Web 知识节点栏

DeepSeek Harness web 右侧"知识节点"面板的源码种子。

## 现状

- **自动按轮记录**（持久、随包生效）：`dsh/plugin.mjs`（glue）监听 `agent/inbox/inserted`，
  自动把每一轮用户提问写成 `dialogue-turn` 图节点（写入 agent 会话工作区的 `.graphflow/`）。
  回复补全沿用既有机制：agent 调用 `graphflow_context({ assistantReply })` 时填充（与
  Claude Code SessionEnd 同一契约）。可用 `GRAPHFLOW_AUTO_CAPTURE=0` 关闭。
- **右侧知识节点栏**（本会话生效）：以动态 Cordis 插件（Host + Client 双半部）挂载：
  - `conversation.session.header.utilities`：会话头部"知识节点"开关按钮
  - `shell.overlay`：右缘浮动面板（additive，不替换任何出厂 UI），展示
    Workbench 主题（主线/旁支、活跃、待回复、消息数）+ 对话轮次（Q/A、跳转标记）
  - 点击节点：通过会话 binding 的 `prompt('queue')` 通道提交续聊指令，agent 自动调用
    `graphflow_context({ topicId | resumeFromTurnId })` 恢复上下文继续

## 数据来源

面板数据由动态插件的 host 半部经 `harness.handle("gf.nodes.list")` 提供，
内部调用（当前工作区下）：
- `graphflow workbench tree --json`
- `graphflow dialogue list --json --limit 50`

## 打包为静态客户端插件（未来）

dsh web 的静态客户端包必须预编译为 `window.__ModuleLoader__.load({id, factory})`
工厂格式并经 `/plugins/<id>/client.js` 提供；纯 ESM 文件无法直接加载。
`plugin.mjs` 中的 `hostHalf()` / `clientHalf()` 即未来 `code.host` / `code.client`
的源码。届时需：
1. 在 `package.json` 增加 `dsh.client` 声明（`platform: "web"` + `inject` 列表）
2. 用 dsh monorepo 的 rolldown 管线把 `./web` 编译为客户端 bundle
3. 在 `cordis.patch.yml` 增加第三行（客户端插件行）

在完成上述打包前，**不要**在 `cordis.patch.yml` 添加该行（client-modules 扫描到
缺失 bundle 会使 profile 组合失败）。
