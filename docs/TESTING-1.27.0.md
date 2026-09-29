# GraphFlow 1.27.0 — 多宿主验收测试步骤

本版把「工作区构建偏好」从只支持 opencode 扩到**全部 19 个宿主 + dsh**，并把 `npm audit` 从 8 项清到 0。下面的步骤用于在**你自己的 agent 工具里**逐个验收。

本文档只讲**从 npm 安装的包**（`@roarpeng/graphflow@1.27.0`）怎么测。**不需要克隆仓库、不需要编译。**

---

## 0. 一次性准备

```bash
# macOS / Linux
mkdir -p ~/gf-test && cd ~/gf-test
npm init -y
npm install -g @roarpeng/graphflow@1.27.3
```

```powershell
# Windows PowerShell
mkdir $env:USERPROFILE\gf-test -Force; cd $env:USERPROFILE\gf-test
npm init -y
npm install -g @roarpeng/graphflow@1.27.3
```

如果安装报 `onnxruntime-node` 下载失败，加 `--ignore-scripts` 重装（两个平台命令相同）：

```bash
npm install -g --ignore-scripts @roarpeng/graphflow@1.27.3
```

这只影响本地 embedding（语义检索）功能，MCP、上下文压缩、记忆全部正常。`onnxruntime` 的二进制走独立 CDN，部分网络环境访问不到。

确认装好：

```bash
graphflow --version          # 应输出 1.27.3
graphflow install            # 注册 MCP + Skill 到本机检测到的 agent
graphflow doctor             # 输出里找 summary: 那一行
```

**不需要 `--json`，也不需要 `grep`。** 早期版本文档里写的 `doctor --json | grep -o ...` 在 Windows 上跑不了（`grep` 不是系统命令），而且 `doctor` 本身就打印了同样的信息。`doctor --json` 只在你写脚本时才需要。

**期望**：输出里有一行（实测在第 67 行附近，**不是最后一行**——后面还有补救建议和排查章节）形如

```
summary: installed=57 missing=0 stale=0 n/a=4 ok=true
```

关键是 `missing=0` 和 `stale=0`。`n/a` 只是没装对应宿主，不影响。

想只取这一行又不依赖 `grep`，用 Node。**注意必须用 `spawnSync` 而不是 `execSync`**：doctor 在 `ok=false` 时退出码非零，`execSync` 会直接抛错，把要读的那行输出一起丢掉。

```bash
node -e "const{spawnSync}=require('child_process');const r=spawnSync('graphflow',['doctor'],{encoding:'utf8'});console.log((r.stdout||'').split('\n').find(l=>l.startsWith('summary:'))||'未找到 summary 行')"
```

> **Windows 特有**：`graphflow` 报"不是内部或外部命令"时，npm 全局 bin 目录没进 PATH。用 `npm prefix -g` 找到目录（通常是 `%AppData%\npm`），把它加进系统 PATH，或直接用 `npx graphflow ...` 代替。
>
> `stale` 的含义要留意：宿主指向**已发布包**、而本机存在更新的本地构建时，doctor 报 stale。对**普通用户**这是正常状态；对**开发者**才是问题。`missing` 指的是 skill / hooks 未装齐，按提示补即可。

---

## 1. 每个 agent 都做一遍（核心步骤）

在你常用的每一个 agent 工具里（Cursor、Claude Code、Codex、Gemini、Trae、Kimi Code、Zed、Windsurf、Cline、Roo Code、Kilo Code、Qoder、ZCode、Continue、Antigravity、Amazon Q、opencode…），做**同一个动作**：

> 问它：**「用 graphflow_context 看一下这个仓库的结构」**

然后看两件事：

| 现象 | 含义 |
| --- | --- |
| 返回了图谱上下文（模块、文件分布、exports、hotspots） | ✅ 该宿主已正确接入 |
| 报「工具不存在」/「没有 graphflow 相关工具」 | ❌ 该宿主没吃到，重跑第 2 步排查 |
| 有工具但返回空 / 报错 | ⚠️ 可能是本地 embedding 不可用（见第 4 步），其余功能不受影响 |

**记录哪些 agent 通过、哪些没通过。** 本版我们只验证过「条目写对了」，**没有逐个验证运行时真的加载了**——这一步就是为了补上那个证据。

---

## 2. 确认条目指向正确（可选，命令行核查）

想知道某个宿主的 MCP 条目到底指向哪里。**用 Node 读文件，两个平台命令完全相同**，不依赖 `grep` / `jq`：

```bash
node -e "const f=require('os').homedir()+'/.cursor/mcp.json';const j=require('fs').readFileSync(f,'utf8');const m=j.match(/graphflow[\s\S]{0,200}/);console.log(m?m[0].slice(0,160):'(未找到 graphflow 条目)')"
```

把路径换成你关心的宿主（`~/.cursor/mcp.json`、`~/.claude.json`、`~/.qoder/mcp.json`、`~/.config/opencode/opencode.json`、`~/.codex/config.toml`）。

**普通用户**应看到 `npx -y --package=@roarpeng/graphflow graphflow-mcp`（走发布包，正确）。
**GraphFlow 开发者**会看到指向本地 `dist/surfaces/mcp/server.js` 的绝对路径。

---

## 3. 验证 opencode 运行时真的加载了（仅 opencode 可做）

opencode 会把 MCP server 拉成独立进程，所以只有它能做运行时确认。**日志那条跨平台**：

```bash
node -e "const f=require('os').homedir()+'/.local/share/opencode/log/opencode.log';const t=require('fs').readFileSync(f,'utf8').split('\n').filter(l=>l.includes('mcp connected')&&l.includes('graphflow')).slice(-3);console.log(t.join('\n')||'(无记录)')"
# 期望形如： mcp connected server=graphflow tools=10
```

**Windows** 的日志路径不同：`%USERPROFILE%\.local\share\opencode\log\opencode.log`（同一条路径，Node 的 `os.homedir()` 会自动处理）。

Linux / macOS 还可用 `ps -eo args | grep "surfaces/mcp/server.js" | grep -v grep` 看进程，Windows 用 `Get-Process node | Where-Object { $_.Path -like "*node*" }`，但日志更省事。

其余 18 个宿主不一定起独立进程，也不会在 opencode 日志里留痕——**它们只能用第 1 步验证**。

---

## 4. 语义检索是否可用（需要网络）

embedding 走本地模型，首次使用会从 Hugging Face 下载：

```bash
graphflow index
graphflow skill insights      # 应能看到技能 + 新鲜度
```

若报连接超时，是 HF 不可达，不是安装问题。影响范围：**仅语义检索 / 向量召回**。上下文压缩、图谱查询、记忆记录都不受影响。

**这一项是本版最需要你实测的部分**——我们把 `@huggingface/transformers` 从 3.x 升到了 4.3.0 来修 `sharp` 的 CVE，API 兼容性已验证（`pipeline` / `env.cacheDir` / `env.remoteHost` 都在），但**真实模型推理没跑过**，因为构建环境访问不到 huggingface.co。

请务必试一次 `graphflow index`，确认向量正常。

---

## 5. 开发者专用：工作区构建偏好

只在你**正在改 GraphFlow 源码**时才需要，让宿主加载你的本地构建而不是 npm 上的已发布包：

```bash
cd <GraphFlow 仓库路径>
npm run build
graphflow install --workspace-build
graphflow doctor          # 同样读最后一行 summary,不要 grep
```

验证全部宿主都指向本地构建：

```bash
node -e '
const inst = require("<GraphFlow路径>/dist/integrations/agent-mcp-installer.js");
const fs = require("fs");
const ws = process.cwd();
let ok = 0, total = 0;
for (const p of inst.buildAgentProfiles()) {
  const t = p.userTargets?.[0];
  if (!t) continue;
  total++;
  const hit = fs.existsSync(t.configPath) &&
    fs.readFileSync(t.configPath, "utf8").includes(ws + "/dist/surfaces/mcp/server.js");
  hit ? ok++ : console.log("  FAIL", p.id);
}
console.log(`指向工作区 dist: ${ok}/${total}`);'
```

**期望 19/19**（dsh 不在此表，它走 `cordis.patch.yml`）。

改完代码后**必须重启宿主**才会加载新构建。

**回滚**：`graphflow install --no-workspace-build`

---

## 6. 遇到问题怎么定位

| 症状 | 排查 |
| --- | --- |
| `graphflow: command not found` | 全局 npm bin 不在 PATH。`npm bin -g`（或 `npm prefix -g`）确认目录已加进 PATH |
| 某 agent 里没有 graphflow 工具 | 跑 `graphflow doctor`，看该 agent 的 `mcp` 项状态；`missing` 时先确认该 agent 的配置目录存在（如 `~/.cursor`） |
| 工具存在但一直 pending | MCP 进程启动失败。看 `graphflow doctor` 的 `stale` / `missing`；必要时手动启动看报错 |
| `onnxruntime-node` 安装失败 | 用 `--ignore-scripts` 重装。仅影响语义检索 |
| embedding 报网络错误 | Hugging Face 不可达。仅影响语义检索 |
| 装完 doctor 报 stale | 普通用户正常（走发布包）。开发者请见第 5 步 |

---

## 本版已知未验证项

诚实列出，避免你以为是 bug：

1. **18 个宿主的运行时行为**只验证到「配置条目写对了」，第 1 步就是为了补这个证据。
2. **embedding 真实数值**未在构建环境验证（HF 不可达），第 4 步是验证它的方式。
3. **宿主是否真按 GraphFlow 给出的 `recipe` 摆放注入内容**——我们看不到宿主拼出的 prompt，这个核心假设至今无法用代码验证。
4. `npm audit` 已是 0，但这是**依赖树**的干净，不代表 GraphFlow 自身没有 bug。

---

## 一句话总结

装完 → `graphflow install` → 在每个 agent 里问「用 graphflow_context 看一下仓库结构」→ 记录哪些通过。
