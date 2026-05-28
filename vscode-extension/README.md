# GraphFlow VS Code Extension

GraphFlow VS Code 扩展用于在编辑器内快速触发 GraphFlow CLI 任务执行，并查看运行历史。

## 当前版本

1. Extension: `0.1.0`
2. 对应 VSIX: `../artifacts/graphflow-vscode-0.1.0.vsix`
3. 依赖：工作区根目录 GraphFlow CLI 可运行

## 功能命令

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`

## 本地测试前置条件

在仓库根目录先完成基础构建：

```bash
npm install
npm run build
```

建议额外验证：

```bash
npm test
```

## 方式 A：安装 VSIX 测试

在仓库根目录执行：

```bash
code --install-extension artifacts/graphflow-vscode-0.1.0.vsix
```

然后重启 VS Code，在命令面板执行：

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`

## 方式 B：开发模式联调（推荐）

在本目录执行：

```bash
npm install
npm run build
```

在 VS Code 中按 `F5` 启动 Extension Development Host，之后在新窗口命令面板测试：

1. `GraphFlow: Run Task`
2. `GraphFlow: Show Runs`

## 打包扩展

在本目录执行：

```bash
npm run package
```

默认输出：

`../artifacts/graphflow-vscode-0.1.0.vsix`

## 验收标准

满足以下条件即可判定扩展本地可用：

1. 命令面板可看到 `GraphFlow: Run Task` 与 `GraphFlow: Show Runs`
2. `Run Task` 可触发并返回任务执行结果
3. `Show Runs` 可查看本次会话运行记录
4. 控制台无阻断级错误

## 常见问题

1. 命令执行失败或无输出
- 确认仓库根目录 `npm run build` 已通过
- 确认根目录 CLI 可执行：`npm run start -- run "health check"`

2. VSIX 安装后命令不可见
- 重启 VS Code
- 在扩展列表确认 GraphFlow 已启用

3. 打包时报输出路径不存在
- 先创建根目录 `artifacts/` 目录后再执行 `npm run package`
