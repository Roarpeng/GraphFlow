# Prompt Reflex (0-LLM Local Reaction)

**English** | [中文](#中文)

GraphFlow 3.x can answer a chat prompt **without a single LLM turn**. When the user's prompt is a short, command-like text (e.g. `启动项目` or `build`) that matches the triggers of a compiled **`command-pipeline`** macro in this workspace, the macro executes locally, and the prompt is **blocked from ever reaching the model**. A longer prompt that merely *mentions* a trigger gets an injected hint instead; everything else passes through untouched.

Entry point (registered automatically by `graphflow install` per host):

```bash
graphflow hook user-prompt [--protocol generic|cursor|gemini]
```

The hook reads one stdin JSON payload (`prompt` / `user_prompt` / `input` are all accepted), resolves the workspace root (from `payload.cwd`, walking up at most 6 levels to a `.graphflow/` directory), and answers in the host's own dialect (see [Per-host config reference](#per-host-config-reference)).

## How it works

```
prompt ──► GRAPHFLOW_PROMPT_REFLEX=0? ──yes──► pass through
        ──► empty prompt ────────────────────► pass through
        ──► no command-pipeline trigger match ► pass through
        ──► trigger match, SHORT command ─────► run macro locally, BLOCK the prompt (0 LLM)
        ──► trigger match, long prompt ───────► pass through + inject a hint naming the macro
```

### Matching rules

| Rule | Detail |
| :--- | :--- |
| Eligible macros | Only compiled `kind: "command-pipeline"` macros from `.graphflow/macros.json`. `edit-codemod` macros **never** auto-run from a chat prompt (nor do `context-bundle` / `command-template`). |
| Normalization | Both sides lowercased; trailing sentence punctuation stripped from the prompt — `启动项目。` and `launch!` still match (`。．.!！?？;；`). |
| CJK triggers | Match as a plain substring — `\b` has no notion of CJK word boundaries. |
| Latin triggers | Must sit on **word boundaries**: trigger `launch` does not fire on `relaunch`. |
| Short-command gate | The prompt may only be executed and blocked when it is ≤ **24 characters** or ≤ **12 tokens**. CJK counting is per character (1 CJK char ≈ 1 word), so a 30-character Chinese sentence never looks like a short command. |
| Tie-break | When several macros match, the one with the highest `occurrences` (the one you actually use most) wins. |
| Fail-open | The whole verdict is wrapped defensively: any internal error returns `allow`. An empty prompt, no macro store, or no match also passes through. A macro that *runs but fails* fails soft — the failure text is handed to the model as a hint so the agent can help. |

### The three outcomes

| Outcome | When | What the host sees |
| :--- | :--- | :--- |
| **blocked** (0 LLM) | Short command matches a trigger | Macro runs locally; the prompt never reaches the model. Generic dialect: `PASS`/summary on stderr, empty stdout, exit code `2`. Cursor: `{ "continue": false, "user_message": … }`. Gemini: `{ "decision": "deny", "reason": … }`. Summary truncated to ~500 chars. |
| **hint** | Long prompt merely mentions a trigger | Prompt reaches the model with injected `additionalContext` naming the macro and its `gf_macro(action:"run", id=…)` call — the model stays in the loop. (Cursor's `beforeSubmitPrompt` has no context-injection field, so on Cursor a hint outcome is an empty decision and the prompt simply passes through.) |
| **allow** | Everything else | Prompt passes through untouched. |

**Kill switch:** `GRAPHFLOW_PROMPT_REFLEX=0` disables the entire feature — the hook stays registered but always answers *allow*. Nothing else needs to change.

## Making a workspace reflex-ready

1. **Have a compiled `command-pipeline` macro** in `.graphflow/macros.json` (compiled runner scripts live in `.graphflow/macros/<id>.mjs`). Two ways to get one:
   - **Auto-mined**: shell commands repeated **≥ 2 times** (recorded by the `PostToolUse` hook or `gf_exec` with `run: true`) are compiled by `gf_macro({ action: "mine" })` / `graphflow macro mine`. Note the auto-mined triggers are the **raw command strings themselves** (`npm run build`), which only matches prompts that literally contain the command.
   - **Saved explicitly**: `gf_macro({ action: "save", … })` or `graphflow macro save`, where you choose the triggers.
2. **Give it short intent-word triggers.** The reflex fires on what you would actually type in chat. For a macro that runs `npm install && npm run dev`, a trigger list like `["启动项目", "启动", "start dev"]` makes `启动项目` a 0-LLM command. Triggers are exact (normalized) words — not regexes, not fuzzy.
3. That's it — the hook must be registered in the host (next section) and the kill switch must not be set.

## Host capability matrix

Prompt Reflex depends on the host exposing a **prompt-level hook** (a hook that fires when the user submits a chat prompt, before the model sees it). Hosts fall into three tiers:

### Tier 1 — full 0-LLM block (auto-registered by `graphflow install`)

| Host | Prompt event | Notes |
| :--- | :--- | :--- |
| ZCode | `UserPromptSubmit` | |
| Claude Code | `UserPromptSubmit` | |
| Codex CLI | `UserPromptSubmit` | |
| Gemini CLI | `BeforeAgent` | Uses `--protocol gemini`. |
| Cursor | `beforeSubmitPrompt` | Uses `--protocol cursor`; can block, but cannot inject hints (no context-injection field). |
| Windsurf | `pre_user_prompt` | |
| Trae / Trae CN | `UserPromptSubmit` | |
| Qoder / Qoder CN | `UserPromptSubmit` | |
| Kimi Code | `UserPromptSubmit` | TOML `[[hooks]]` table in `config.toml`. |
| Continue CLI | `UserPromptSubmit` | **CLI only** — the Continue IDE extension ignores hooks. |

### Tier 2 — inject/rewrite (experimental)

The macro still runs locally, but these hosts cannot hard-block a prompt; the model receives the rewritten message or injected result and stays in the loop. `graphflow install` writes the adapter asset for each host below (and `graphflow uninstall` removes it).

| Host | Mechanism | Notes |
| :--- | :--- | :--- |
| OpenCode (v1), Kilo Code | `chat.message` plugin rewrite | Shared plugin auto-loads from `~/.config/opencode/plugin/` and `~/.config/kilo/plugin/`. OpenCode v2 needs a separate port. |
| Cline | file-based `UserPromptSubmit` hook with `cancel: true` | Written to `~/Documents/Cline/Hooks/UserPromptSubmit`; Unix-only officially (skipped on Windows). Enable Hooks once in Cline settings. |
| DeepSeek Harness (DSH) | `agent/pre-step` Cordis plugin | Plugin at `~/.dsh/plugins/graphflow-prompt-reflex.mjs` + managed block in `~/.dsh/cordis.patch.yml`; restart dsh after install. |

### Tier 3 — no prompt-level hooks

No prompt-level hook surface exists (or the surface cannot see the prompt text). The fallback is the ordinary `gf_macro` MCP tool (the agent calls it explicitly when rules/skills suggest it) — everything else in GraphFlow works; only the automatic 0-LLM block is unavailable.

| Host | Notes |
| :--- | :--- |
| VS Code (GitHub Copilot) | `userPromptSubmitted` hook is observe-only. |
| Zed | No hook system. |
| Claude Desktop | No hook system. |
| PearAI | No hook system. |
| Antigravity | `PreInvocation` fires per model call but its payload carries **no prompt text** and the event cannot block — the reflex cannot see or intercept the prompt (verified against the official hooks docs). |
| Roo Code | Project archived May 2026 — treat as legacy. |

## Per-host config reference

What `graphflow install` writes (all paths under `$HOME`; user hook entries in the same files are preserved, and `graphflow uninstall` removes only the GraphFlow entries):

| Host | Config file | Event key | Entry shape |
| :--- | :--- | :--- | :--- |
| ZCode | `~/.zcode/cli/config.json` | `hooks.events.UserPromptSubmit` (+ `hooks.enabled: true`) | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeoutMs: 60000 }] }` |
| Claude Code | `~/.claude/settings.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Codex CLI | `~/.codex/hooks.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Gemini CLI | `~/.gemini/settings.json` | `BeforeAgent` | `{ matcher: ".*", hooks: [{ name: "graphflow-prompt", type: "command", command: "graphflow hook user-prompt --protocol gemini", timeout: 60000 }] }` |
| Cursor | `~/.cursor/hooks.json` | `beforeSubmitPrompt` | `{ command: "graphflow hook user-prompt --protocol cursor", timeout: 15 }` |
| Windsurf | `~/.codeium/windsurf/hooks.json` | `pre_user_prompt` | `{ command: "graphflow hook user-prompt" }` (flat — Windsurf's schema has no matcher/hooks/type/timeout fields) |
| Trae / Trae CN | `~/.trae/hooks.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Qoder / Qoder CN | `~/.qoder/settings.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Kimi Code | `~/.kimi-code/config.toml` | `[[hooks]]` table (`event = "UserPromptSubmit"`) | Only legal fields `event` / `matcher` / `command` / `timeout` (seconds, 1–600); maintained by a span-based read-modify-write that preserves every user byte |
| Continue CLI | `~/.continue/settings.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |

## Verifying it works

1. **Registration**: `graphflow status` shows `[Hook ✓]` next to each Tier-1 host.
2. **Restart the session after a config change.** ZCode in particular reads its hook config at session start — an already-running session will not pick up a freshly installed hook until restarted.
3. **Dry-run the hook by hand** with a test payload (this is exactly what the host sends):

```bash
# Short command that should block (summary on stderr, exit code 2, empty stdout):
echo '{"prompt":"启动项目","cwd":"/path/to/workspace"}' | graphflow hook user-prompt

# Long prompt mentioning a trigger -> hint JSON on stdout, exit code 0:
echo '{"prompt":"请帮我看看支付模块的问题，另外有空的话启动项目","cwd":"/path/to/workspace"}' | graphflow hook user-prompt

# No trigger -> nothing printed (generic dialect), exit code 0:
echo '{"prompt":"解释一下这段代码","cwd":"/path/to/workspace"}' | graphflow hook user-prompt
```

4. **End to end**: type the trigger word in the host chat and confirm the macro's `PASS` line appears without a model turn.

## Security & privacy

- **Macros execute recorded shell commands locally.** Compiled runners call `spawnSync(cmd, { shell: true })` with the workspace root as `cwd`, with your user privileges. Treat `.graphflow/macros.json` + `.graphflow/macros/*.mjs` as executable content: review what you (or your agent) recorded, and delete entries you do not trust.
- **Triggers are explicit words**, stored in the macro definition — not inferred meanings and not regexes. A prompt only fires a macro when it literally contains a trigger (word-bounded for Latin scripts).
- **Only `command-pipeline` macros** are prompt-executable. `edit-codemod` macros — the ones that rewrite source files — **never** auto-run from a chat prompt.
- **Nothing leaves the machine.** The reflex path itself makes no LLM and no network calls; that is the point of the feature.
- **One switch kills everything**: `GRAPHFLOW_PROMPT_REFLEX=0` disables the feature on every host (the hook remains registered but always allows the prompt through).

---

# 中文

GraphFlow 3.x 可以**在不消耗任何 LLM 轮次**的情况下响应聊天输入。当用户的 prompt 是一段简短的命令式文本（例如 `启动项目`、`build`），并且命中了本工作区已编译的 **`command-pipeline`** 宏的触发词时，该宏会在本地执行，这条 prompt **不会到达模型**。只是在长 prompt 中*提及*触发词的，改为注入一条提示；其余 prompt 原样放行。

入口命令（由 `graphflow install` 按宿主自动注册）：

```bash
graphflow hook user-prompt [--protocol generic|cursor|gemini]
```

钩子从 stdin 读取一段 JSON（接受 `prompt` / `user_prompt` / `input` 字段），解析工作区根目录（从 `payload.cwd` 起最多向上找 6 层含 `.graphflow/` 的目录），并以宿主各自的方言应答（见[逐宿主配置参考](#逐宿主配置参考)）。

## 工作原理

```
prompt ──► GRAPHFLOW_PROMPT_REFLEX=0 ────yes──► 原样放行
        ──► 空 prompt ────────────────────────► 原样放行
        ──► 未命中任何 command-pipeline 触发词 ─► 原样放行
        ──► 命中触发词，且是短命令 ────────────► 本地执行宏，拦截 prompt（0 LLM）
        ──► 命中触发词，但是长 prompt ──────────► 放行 + 注入点名该宏的提示
```

### 匹配规则

| 规则 | 说明 |
| :--- | :--- |
| 参与匹配的宏 | 仅 `.graphflow/macros.json` 中 `kind: "command-pipeline"` 的已编译宏。`edit-codemod` 宏**绝不会**因聊天 prompt 而自动执行（`context-bundle` / `command-template` 同样不会）。 |
| 归一化 | 两侧统一小写；prompt 末尾的句读标点会被剥掉 —— `启动项目。`、`launch!` 依然命中（`。．.!！?？;；`）。 |
| 中文触发词 | 按普通子串匹配 —— `\b` 对中文没有词边界概念。 |
| 拉丁字母触发词 | 必须落在**词边界**上：触发词 `launch` 不会命中 `relaunch`。 |
| 短命令门 | 只有 ≤ **24 字符**或 ≤ **12 tokens** 的 prompt 才会被执行并拦截。中文按字计数（1 个 CJK 字符 ≈ 1 个词），因此 30 字的中文句子不会被误判成短命令。 |
| 多宏命中 | 取 `occurrences` 最高的那个（你实际用得最多的宏）。 |
| 失效开放（fail-open） | 整个判定被防御性包裹：内部任何错误都返回放行。空 prompt、无宏存储、未命中同样放行。宏*执行失败*则软失败 —— 失败文本作为提示交给模型，由它接手排查。 |

### 三种结局

| 结局 | 条件 | 宿主看到什么 |
| :--- | :--- | :--- |
| **拦截**（0 LLM） | 短命令命中触发词 | 宏本地执行，prompt 不到达模型。generic 方言：stderr 输出 `PASS`/摘要、stdout 为空、退出码 `2`；Cursor：`{ "continue": false, "user_message": … }`；Gemini：`{ "decision": "deny", "reason": … }`。摘要截断到约 500 字符。 |
| **提示** | 长 prompt 只是提及触发词 | prompt 到达模型，同时注入点名该宏及其 `gf_macro(action:"run", id=…)` 调用的 `additionalContext` —— 模型仍在环内。（Cursor 的 `beforeSubmitPrompt` 没有上下文注入字段，因此在 Cursor 上提示结局就是空应答，prompt 原样通过。） |
| **放行** | 其余情况 | prompt 原样通过，不做任何事。 |

**总开关：** `GRAPHFLOW_PROMPT_REFLEX=0` 关闭整个特性 —— 钩子仍保持注册，但一律应答*放行*。

## 让工作区具备反射条件

1. **准备一个已编译的 `command-pipeline` 宏**（存于 `.graphflow/macros.json`，编译产物在 `.graphflow/macros/<id>.mjs`）。两条路：
   - **自动挖掘**：重复 **≥ 2 次** 的 shell 命令（由 PostToolUse 钩子或 `run: true` 的 `gf_exec` 记录）经 `gf_macro({ action: "mine" })` / `graphflow macro mine` 编译。注意自动挖掘出的触发词是**原始命令串本身**（`npm run build`），只有 prompt 字面上含这条命令才会命中。
   - **显式保存**：`gf_macro({ action: "save", … })` 或 `graphflow macro save`，触发词由你指定。
2. **给宏配简短的意图词触发**。反射只对「你在聊天里真的会打的那句话」生效。一个跑 `npm install && npm run dev` 的宏，配上 `["启动项目", "启动", "start dev"]` 这样的触发词，`启动项目` 就成了 0-LLM 命令。触发词是（归一化后的）精确词 —— 不是正则，不做模糊匹配。
3. 就这些 —— 前提是钩子已注册进宿主（见上节），且总开关未关闭。

## 宿主能力矩阵

Prompt Reflex 依赖宿主提供**提示词级钩子**（在用户提交聊天 prompt、模型看到它之前触发的钩子）。宿主分三档：

### 第一档 —— 完整 0-LLM 拦截（`graphflow install` 自动注册）

| 宿主 | 提示词事件 | 备注 |
| :--- | :--- | :--- |
| ZCode | `UserPromptSubmit` | |
| Claude Code | `UserPromptSubmit` | |
| Codex CLI | `UserPromptSubmit` | |
| Gemini CLI | `BeforeAgent` | 使用 `--protocol gemini`。 |
| Cursor | `beforeSubmitPrompt` | 使用 `--protocol cursor`；能拦截，但不能注入提示（没有上下文注入字段）。 |
| Windsurf | `pre_user_prompt` | |
| Trae / Trae CN | `UserPromptSubmit` | |
| Qoder / Qoder CN | `UserPromptSubmit` | |
| Kimi Code | `UserPromptSubmit` | `config.toml` 的 TOML `[[hooks]]` 表。 |
| Continue CLI | `UserPromptSubmit` | **仅 CLI** —— Continue 的 IDE 扩展忽略钩子。 |

### 第二档 —— 注入/改写（进行中 / 实验性）

宏仍在本地执行，但这些宿主无法硬拦截 prompt；模型收到改写后的消息或注入的结果，仍保持在环内。`graphflow install` 会写入下述适配资产（`graphflow uninstall` 负责移除）。

| 宿主 | 机制 | 备注 |
| :--- | :--- | :--- |
| OpenCode（v1）、Kilo Code | `chat.message` 插件改写 | 共享插件自动加载于 `~/.config/opencode/plugin/` 与 `~/.config/kilo/plugin/`；OpenCode v2 需另行移植。 |
| Cline | 基于 `cancel: true` 的文件式 `UserPromptSubmit` 钩子 | 写入 `~/Documents/Cline/Hooks/UserPromptSubmit`；官方仅支持 Unix（Windows 上跳过安装）；需在 Cline 设置里启用 Hooks。 |
| DeepSeek Harness（DSH） | `agent/pre-step` Cordis 插件 | 插件位于 `~/.dsh/plugins/graphflow-prompt-reflex.mjs` + `~/.dsh/cordis.patch.yml` 托管块；安装后需重启 dsh。 |

### 第三档 —— 无提示词级钩子

没有提示词级钩子面（或该面看不到提示词文本）。回退方案是普通的 `gf_macro` MCP 工具（由 rules/skills 提示后，Agent 显式调用）—— GraphFlow 其余功能照常；只是自动 0-LLM 拦截不可用。

| 宿主 | 备注 |
| :--- | :--- |
| VS Code（GitHub Copilot） | `userPromptSubmitted` 钩子只读。 |
| Antigravity | `PreInvocation` 每次模型调用都触发，但载荷**不含提示词文本**且无法阻断 —— 反射层既看不到也拦不住（依据官方 hooks 文档核实）。 |
| Zed | 无钩子系统。 |
| Claude Desktop | |
| PearAI | |
| Roo Code | 项目已于 2026 年 5 月归档 —— 视为遗留。 |

## 逐宿主配置参考

`graphflow install` 写入的内容（路径均在用户主目录下；同一文件里的用户钩子条目会被保留，`graphflow uninstall` 只删除 GraphFlow 条目）：

| 宿主 | 配置文件 | 事件键 | 条目形状 |
| :--- | :--- | :--- | :--- |
| ZCode | `~/.zcode/cli/config.json` | `hooks.events.UserPromptSubmit`（另置 `hooks.enabled: true`） | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeoutMs: 60000 }] }` |
| Claude Code | `~/.claude/settings.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Codex CLI | `~/.codex/hooks.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Gemini CLI | `~/.gemini/settings.json` | `BeforeAgent` | `{ matcher: ".*", hooks: [{ name: "graphflow-prompt", type: "command", command: "graphflow hook user-prompt --protocol gemini", timeout: 60000 }] }` |
| Cursor | `~/.cursor/hooks.json` | `beforeSubmitPrompt` | `{ command: "graphflow hook user-prompt --protocol cursor", timeout: 15 }` |
| Windsurf | `~/.codeium/windsurf/hooks.json` | `pre_user_prompt` | `{ command: "graphflow hook user-prompt" }`（扁平结构 —— Windsurf 的 schema 没有 matcher/hooks/type/timeout 字段） |
| Trae / Trae CN | `~/.trae/hooks.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Qoder / Qoder CN | `~/.qoder/settings.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |
| Kimi Code | `~/.kimi-code/config.toml` | `[[hooks]]` 表（`event = "UserPromptSubmit"`） | 合法字段只有 `event` / `matcher` / `command` / `timeout`（秒，1–600）；以 span 级读-改-写维护，用户字节一字不动 |
| Continue CLI | `~/.continue/settings.json` | `UserPromptSubmit` | `{ hooks: [{ type: "command", command: "graphflow hook user-prompt", timeout: 60 }] }` |

## 验证

1. **注册状态**：`graphflow status` 在每个第一档宿主旁显示 `[Hook ✓]`。
2. **改配置后重启会话。** ZCode 尤其在会话启动时读取钩子配置 —— 已在运行的会话要重启后才能用上新装的钩子。
3. **手动空跑钩子**（宿主发送的就是这段 payload）：

```bash
# 应拦截的短命令（stderr 出摘要、退出码 2、stdout 为空）：
echo '{"prompt":"启动项目","cwd":"/path/to/workspace"}' | graphflow hook user-prompt

# 提及触发词的长 prompt -> stdout 出提示 JSON，退出码 0：
echo '{"prompt":"请帮我看看支付模块的问题，另外有空的话启动项目","cwd":"/path/to/workspace"}' | graphflow hook user-prompt

# 未命中 -> （generic 方言）什么都不打印，退出码 0：
echo '{"prompt":"解释一下这段代码","cwd":"/path/to/workspace"}' | graphflow hook user-prompt
```

4. **端到端**：在宿主聊天框里直接输入触发词，确认宏的 `PASS` 行出现且没有模型轮次。

## 安全与隐私

- **宏在本地执行已记录的 shell 命令。** 编译产物以 `spawnSync(cmd, { shell: true })` 运行，`cwd` 为工作区根目录，权限等同你的用户。请把 `.graphflow/macros.json` 与 `.graphflow/macros/*.mjs` 当作可执行内容对待：审查你（或你的 Agent）记录过什么，删除不信任的条目。
- **触发词是显式词条**，保存在宏定义里 —— 不是推断出的语义，也不是正则。prompt 必须字面上包含触发词（拉丁字母须落在词边界上）才会触发。
- **只有 `command-pipeline` 宏**可由 prompt 执行。会改写源码的 `edit-codemod` 宏**绝不**因聊天 prompt 自动运行。
- **没有任何数据离开本机。** 反射路径本身零 LLM、零网络调用 —— 这正是该特性的意义。
- **一个开关全关**：`GRAPHFLOW_PROMPT_REFLEX=0` 在所有宿主上禁用该特性（钩子保持注册，但一律放行 prompt）。
