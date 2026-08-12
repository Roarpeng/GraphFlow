# 学习飞轮自动闭环（Flywheel Auto-Capture）

> P0-1 / P0-2：让学习飞轮无需宿主 agent 主动调用 `graphflow_report_outcome` 也能自动闭环。

## 背景

GraphFlow 的飞轮（episode + skill）依赖宿主 agent 主动调用
`graphflow_report_outcome` / `graphflow outcome report <episodeId> <success>`
才会把 `pending` 的 episode 回填为真实结局（pass/fail）并触发 skill 分数更新。
如果宿主 agent 忘了调用（或没有 MCP 连接），episode 永远停留在 `pending`，
飞轮退化为只有 `context` 运行、没有任何学习回填的"空转"状态。

本特性提供三条互补的自动闭环路径（auto-capture 默认开启，
`GRAPHFLOW_AUTO_CAPTURE=0` 可显式关闭；hooks 需安装、backfill 为一次性操作）：

1. **自动记录（auto-capture）**：run 完成路径上自动生成 `pending` episode 并写入
   会话日志（`.graphflow/session-journal.jsonl`）。
2. **Claude Code hooks**：`SessionStart / SessionEnd / Stop` 时自动调用
   `graphflow outcome report <episodeId> <success>` 回填真实结局。
3. **一次性回填（backfill）**：从历史事件（learning-events.jsonl）或 git log
   挖掘 episode 记录，补上此前"没回填"的数据。

## 机制

```
host agent ──(run/context 完成)──▶ orchestrator
                                      │
                    maybeAutoCaptureEpisode (默认开启，GRAPHFLOW_AUTO_CAPTURE=0 关闭)
                      ├─ 结局未知 (DELEGATED / HUMAN_REVIEW_REQUIRED)
                      │   └─ 写入 pending episode（绝不伪造 COMPLETED）
                      └─ 追加会话日志 .graphflow/session-journal.jsonl
                                            │
Claude Code SessionEnd / Stop ──▶ session.sh ──▶ 读取最新一条 pending
                                            │
                          graphflow outcome report <episodeId> true
                                            │
                    updateEpisodeOutcome(pending → pass/fail) + applySkillLearning
```

### 自动记录（src/hooks/auto-capture.ts）

- 开关：**默认开启**。环境变量未设置或设置为 `1 / true / on / yes / enabled` 时开启；
  设置 `GRAPHFLOW_AUTO_CAPTURE=0`（接受 `0 / false / off / no / disabled`）时关闭，
  或在调用点显式传入 `enabled: false`。
- 时机：`finalizeEpisode`（run 完成路径）对结局未知的 run（`DELEGATED`、
  `HUMAN_REVIEW_REQUIRED`）自动生成 `outcome: "pending"` 的 episode，
  并把 `{ episodeId, task, taskKey, status, createdAt }` 追加到
  `<workspace>/.graphflow/session-journal.jsonl`。
- 原则：
  - **不伪造结局** —— 自动生成的记录一律 `pending`；`COMPLETED / FAILED` 等
    结局已知的 run 直接跳过，不产生 pending 噪音。
  - **幂等去重** —— 同一任务在 30 分钟窗口内的重复 run 复用最近一条记录。
  - **不阻断** —— 任何失败仅 log warn，绝不中断编排主流程。
- 已启用 episodic memory 时复用其已记录的 episodeId（不重复写节点）。

### Claude Code hooks（src/integrations/claude-code-hooks.ts）

生成器产出 `~/.claude/settings.json` 风格的 hooks 片段 + 一个 bash 脚本
（`~/.claude/graphflow-hooks/session.sh`，默认目录可覆盖）：

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "type": "command", "command": "bash '/home/you/.claude/graphflow-hooks/session.sh' start", "timeout": 30 }
    ],
    "SessionEnd": [
      { "type": "command", "command": "bash '/home/you/.claude/graphflow-hooks/session.sh' end", "timeout": 30 }
    ],
    "Stop": [
      { "type": "command", "command": "bash '/home/you/.claude/graphflow-hooks/session.sh' end", "timeout": 30 }
    ]
  }
}
```

由 `buildClaudeCodeHooksConfig({ hooksDir, settingsPath })` 生成（三个事件均带
`timeout: 30`，`SessionEnd` 与 `Stop` 共用 end 命令）。

行为：

- `start`：仅准备会话日志目录（不写图）。
- `end` / `Stop`：读取日志中最新一条 `pending-episode`，调用
  `graphflow outcome report <episodeId> <success>` 回填（与手动 report_outcome
  完全等价：pending → pass/fail + skill 分数更新）。成功值默认 `true`，
  可传第二个参数覆盖：`session.sh end false`。
- 安全：脚本内所有路径/命令均做 shell 转义（单引号包裹 + 双引号内 fallback 转义）；
  合并 settings.json 时**保留用户已有 hooks**；JSON 损坏时拒绝覆盖。
- 运行时覆盖（无需重新生成）：`GRAPHFLOW_HOOK_JOURNAL`、`GRAPHFLOW_HOOK_BIN`、
  `GRAPHFLOW_HOOK_CONFIG`。

#### 安装 / 卸载

推荐一键注册（检测到 `~/.claude` 时自动写入 hooks，并由 `doctor` 自检）：

```bash
graphflow install --json   # InstallReport.claudeCodeHooks + doctor.checks[category=hooks]
graphflow doctor --json    # missing hooks → ok=false + remediation
graphflow uninstall        # 同步移除 GraphFlow 写入的 hooks 条目与 session.sh
```

也可直接调用 API：

```ts
import { installClaudeCodeHooks, uninstallClaudeCodeHooks } from "@roarpeng/graphflow";

installClaudeCodeHooks({
  graphflowBin: "graphflow", // 默认；也可用绝对路径
  configPath: undefined,     // 需要时传工作区 graphflow.config.json
});
uninstallClaudeCodeHooks();  // 只移除本生成器写入的条目
```

注意：hook 进程需要 `graphflow` CLI 在 PATH 中
（`npm i -g @roarpeng/graphflow`），否则用 `GRAPHFLOW_HOOK_BIN` 指向绝对路径。
开启 pending 自动记录仍需 `GRAPHFLOW_AUTO_CAPTURE=1`（hooks 只负责回填已有 pending）。

### 一次性回填（scripts/backfill-episodes.cjs）

把此前缺失的学习信号补进图存储（默认 `graphflow-out/graphflow-graph.json`，
transport=file）：

```bash
node scripts/backfill-episodes.cjs                       # 自动选择数据源
node scripts/backfill-episodes.cjs --root /path/to/repo  # 指定仓库根目录
node scripts/backfill-episodes.cjs --dry-run             # 只看不动
node scripts/backfill-episodes.cjs --events /path/events.jsonl   # 强制指定事件文件
```

数据源优先级：

1. `.graphflow/learning-events.jsonl`（约定位置）→ 回退
   `graphflow-out/learning-events.jsonl`（默认 eventsPath）→ 回退
   `<root>/learning-events.jsonl`。解析真实反馈事件
   `{query, passed, tokenCost, retries}`，`passed → pass / fail`。
2. 均不存在时，从 `git log` 最近 200 条 commit 的 subject/body 挖掘
   （已合入历史的 commit 视为真实完成证据，outcome 用 `pass`）。

特性：**幂等**（episode id 由内容/commit hash 确定性生成，重复执行不重复写入）、
**容错**（坏行/无 git/存储损坏均不覆盖数据）、**原子写**（temp + rename）。

## 诊断

`graphflow diagnose` 中 `0 skill / 0 episode` 的常见原因与本特性的对应关系：

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| episode 全为 pending 且数量不变 | 宿主 agent 未调 report_outcome | 安装 Claude Code hooks（见上） |
| 0 episode | 从未启用 episodic memory / 无回填 | 确认 `GRAPHFLOW_AUTO_CAPTURE` 未被设为 `0` + 安装 hooks，或运行 backfill 脚本 |
| 0 skill | 飞轮无 episode 可学 | 同上，先有 episode 才有 skill 学习 |

## 局限与风险

- hooks 只回填**最新一条** pending（`tail -n 1`）；同一会话多条 pending 时，
  较早的保持 pending（可审计，不伪造）。
- `Stop` 触发时机早于 `SessionEnd`（`Stop` 在用户中断/结束前触发，`SessionEnd`
  在会话正式结束时触发），两者共用 end 脚本，重复回填会被
  `updateEpisodeOutcome` 自然覆盖（幂等）。
- backfill 的 git 分支把 commit 视为 `pass`，仅作为无事件数据时的兜底估计。
- auto-capture 默认开启（飞轮自证）；如需恢复旧行为，设置
  `GRAPHFLOW_AUTO_CAPTURE=0` 显式关闭。开启时也只新增 pending 记录与日志，
  不影响现有 episode/skill 语义。
