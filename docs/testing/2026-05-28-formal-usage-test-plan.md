# GraphFlow 正式使用测试计划

- 日期: 2026-05-28
- 目标版本: v0.1.0
- 适用对象: CLI 与 VS Code 插件正式使用前验收

## 1. 测试目标

1. 验证核心能力完整可用：图谱、自动路由、规划/头脑风暴、复杂任务编排、校验闭环。
2. 验证 CLI 与 VS Code 插件能力一致。
3. 验证在本地持久化图谱场景下的连续可用性。

## 2. 前置条件

1. 在仓库根目录执行：

```bash
npm install
npm run lint
npm run build
npm test
```

2. 若需要插件验证，先安装或构建扩展：

```bash
code --install-extension artifacts/graphflow-vscode-0.1.0.vsix
```

## 3. 正式测试用例

### TC-01 基础健康检查

1. 执行命令：

```bash
npm run start -- run "health check"
```

2. 通过标准：
- 返回 `status=COMPLETED`
- 返回 `feedback=` 且不为空

### TC-02 图谱索引能力

1. 执行命令：

```bash
npm run start -- graph index .
```

2. 通过标准：
- 返回 `indexedFiles > 0`
- 返回 `indexedSymbols > 0`

### TC-03 上下文召回能力

1. 执行命令：

```bash
npm run start -- context preview "src/"
```

2. 通过标准：
- 返回 `summary > 0`
- 返回 `anchors > 0`
- 返回 `tokens <= maxContextTokens`

### TC-04 规划与头脑风暴能力

1. 执行命令：

```bash
npm run start -- plan "update readme and add tests and refactor architecture module"
```

2. 通过标准：
- 输出包含 `mode=complex`
- 输出包含 `ideas=`
- 输出包含 `plan=`
- 输出计划中至少 3 个任务节点

### TC-05 简单任务快速执行

1. 执行命令：

```bash
npm run start -- run "rename variable"
```

2. 通过标准：
- 返回 `status=COMPLETED`
- `attempts=1` 或低重试次数

### TC-06 复杂任务计划后执行

1. 执行命令：

```bash
npm run start -- run "update readme and add tests and refactor architecture module"
```

2. 通过标准：
- 返回 `status=COMPLETED`
- `attempts >= 3`
- `feedback` 包含 `Completed tasks:`

### TC-07 结果与需求对账校验

1. 执行命令：

```bash
npm run start -- run "update readme and add tests"
```

2. 通过标准：
- 反馈包含 `Validation passed:` 或明确对账反馈
- 对账失败时进入重试，超限后 `HUMAN_REVIEW_REQUIRED`

### TC-08 图谱持久化回归

1. 先执行：

```bash
npm run start -- run "update readme"
```

2. 关闭并重新打开终端后执行：

```bash
npm run start -- context preview "Task completed"
```

3. 通过标准：
- 仍可查询到历史运行相关内容（summary/anchors > 0）

## 4. VS Code 插件验收

1. 命令面板可见：
- GraphFlow: Run Task
- GraphFlow: Show Runs
- GraphFlow: Plan & Brainstorm

2. Run Task 验收：
- 输入 `health check`
- 出现完成提示

3. Show Runs 验收：
- 可见本会话运行记录

4. Plan & Brainstorm 验收：
- 输入复杂任务
- 显示 `mode`、`ideas`、`plan` 三段输出

## 5. 退出标准

1. TC-01 至 TC-08 全部通过。
2. 插件四项验收全部通过。
3. 执行期间无阻断级错误。

## 6. 问题记录模板

1. 用例编号:
2. 实际结果:
3. 预期结果:
4. 复现步骤:
5. 影响范围:
6. 临时规避方案:
