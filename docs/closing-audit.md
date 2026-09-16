# Closing audit & promise ledger (R9)

> 治 agent「干着干着就忘了」：新增驱动忘记加载、新依赖忘记安装、新文件忘记注入容器/接线到环境、新命令忘记写文档。问题本质不是记忆，而是**承诺没有账本**——义务在任务中段产生、收尾时无人清点。R9 从**可观测的副作用**登记义务，在三个触点对账：不猜意图、只对账事实、默认质询不阻断。

## 三个触点

| 触点 | 行为 |
| --- | --- |
| `graphflow audit [--since <ref>] [--strict]` | 手动/CI 审计：并发跑全部检查器，输出质询清单 |
| `report_outcome success`（自动前置） | 上报成功前自动审计——默认温和（findings 附进 episode 证据并提醒）；`GRAPHFLOW_AUDIT_STRICT=1` 严格模式**拒绝上报成功**直到清零 |
| 会话首次 `graphflow_context`（跨会话提醒） | 上次会话的未决项从图上承诺账本读出，以 `pendingFollowThroughs` 字段返回「上次会话有 N 项未收尾」——新会话开局即被提醒，这是治「干着干着忘了」的关键一击 |

审计清零（findings 为空）会自动把 open 状态的账本条目标记 resolved，闭环完成。

## 内置检查器

| 检查器 | 义务 | 典型 finding |
| --- | --- | --- |
| dependency | `package.json` 声明的依赖必须存在于 lock（npm v1/v3；pip 仅在存在 poetry.lock / Pipfile.lock 时核对） | 「依赖 X 已加入 package.json 但 lock 未更新——忘跑 npm install 了吗？」 |
| orphan-file | 变更集中的源码文件在图中必须有入边（imports/references）；零入边 = 没接线 | 「新文件 src/x.ts 未被图中任何引用连接——是否忘记 import/注册？」 |
| doc-consistency | CLI 变更应伴随文档变更；README 版本徽章与 package.json 一致 | 「CLI 有变更但 README/docs 未动」/「徽章 1.19.2 ≠ package.json 1.20.0」 |

## 声明式规则（容器引用 / 驱动加载等一切项目特定义务）

项目根放 `graphflow.audit.json`：

```json
{
  "rules": [
    {
      "name": "driver-loaded",
      "description": "新增驱动必须被加载配置引用",
      "filePattern": "drivers/**/*.{c,ko,py}",
      "mustBeReferencedBy": ["**/modules-load/**", "scripts/load*", "docker-compose*.yml"],
      "severity": "error",
      "remediation": "把驱动加入 modules-load.d 或启动脚本"
    },
    {
      "name": "container-includes",
      "kind": "container-ref",
      "filePattern": "services/*/main.py",
      "mustBeReferencedBy": ["Dockerfile*", "docker-compose*.yml"]
    }
  ]
}
```

语义：baseline 中**新出现**且匹配 `filePattern` 的文件，必须被至少一个匹配 `mustBeReferencedBy` 的**磁盘上存在**的配置文件**内容引用**（文件名或相对路径）。glob 支持 `**` / `*` / `?` / `{a,b}`。内置规则集为空数组——零项目类型假设，一切项目语义由你声明。

## 基线策略

- 默认：**git 未提交工作区**（`git diff --name-only HEAD` + untracked）——正是 agent 会话结束时的天然收尾窗口。
- `--since <ref>`：扩大到 ref（`git diff <ref>...HEAD` + 工作区）。
- 无 git 项目：降级为纯状态检查（依赖/徽章仍有效），baseline 类检查跳过并在报告 `baseline.note` 说明。

## 诚实边界

- 只对账文件系统、配置文件、知识图谱、manifest 的**可观测事实**；不从对话文本猜测意图。
- 检查器失败一律 fail-open（返回已收集部分），绝不阻断 outcome 上报（strict 拒绝是显式语义，不是故障）。
- 孤儿文件检查在图不可用时跳过（不臆测）——图可用且入边明确为零才点名。

## 相关

- [efficiency-mechanisms.md](efficiency-mechanisms.md) — R6 效率机制
- [ROADMAP.md](../ROADMAP.md) — R9 条目与依据
- 测试：`tests/m94`–`m98`（契约 / 检查器×2 / 聚合器 / 承诺账本）
