# Postmortem：Windows 安装连环故障（v1.18.6 → v1.23.0）

> 2026-09-18。用户原话："再好的项目，人家安装不上也是扯淡。" 本文把五次真实故障的根因、修复与**守则**固化下来——每条守则都是用用户的真实失败换的，违反任何一条都会复现某一类故障。新贡献者改安装器/launcher/依赖面之前必读。

## 故障时间线与根因

| # | 现象 | 根因 | 修复版本 |
| --- | --- | --- | --- |
| 1 | ZCode MCP 一直"启动中"直至超时 | npx 条目首次启动需下载完整包 + 原生依赖（Windows 上数百 MB），120s 超时不够 | v1.19.1：全局安装探测 → node+server.js 直连条目 |
| 2 | `Cannot find module ...extensions\roarpeng.graphflow-1.16.0-universal\mcp-launcher.cjs` | 条目指向**带版本号的扩展目录**，IDE 升级删除旧目录 → 悬空引用；doctor 只查"条目存在"完全漏检 | v1.21.0：悬空检测 + install 自动重写；doctor 标 `dangling entry` |
| 3 | npm 一键安装后仍需手动折腾 | postinstall 全局分支是旧的半吊子手工流程（部分宿主 + 强制 npx + 无修复） | v1.21.0：postinstall 收敛为完整 CLI install |
| 4 | `server not found: ...\runtime\vendor\graphflow\dist\...` | **v1.22.0 自伤**：把 vendor 内容铺到 runtime 根，launcher 仍按 `__dirname/vendor/graphflow` 找——只验证了"文件存在"，没验证"launcher 能找到" | v1.23.0：稳定目录镜像扩展布局 + launcher 双布局回退 |
| 5 | `Cannot find module 'ajv'`（npx 缓存内） | `ajv-formats`（SDK 传递依赖）的 **peer `ajv` 在镜像残缺/npx 解析下丢失**；同一镜像还发过旧版（1.20.1）+ 残缺包（skills 缺失） | v1.23.0：ajv/ajv-formats 显式直接依赖；v1.22.1：首次运行自动注册兜底 |
| 6 | 完整 `graphflow install` 后 zcode 条目仍是 npx（直连从未生效） | **legacy sweep 覆盖**：buildInstallReport 在 HostAdapter 写完直连后，第 4 步全宿主 npx sweep 再写一遍，覆盖回 npx——v1.19.1 起潜伏；单测全绿因为都绕过了完整流程（R1 活例证） | v1.23.1：legacy sweep 加 `preferGlobalInstall: true` 与 adapter 一致 |

## 守则（违反即复现对应故障）

1. **R1 端到端冒烟，不是 existsSync**：安装器写入的任何启动路径（launcher/条目），必须在真实 spawn 里跑通过一次才算验证。#4 的直接教训——文件在磁盘上 ≠ launcher 找得到。
2. **R2 配置只指向稳定目录**：MCP 条目里的绝对路径只允许 `~/.graphflow/runtime/`（vendor 布局）、npm 全局包根、或 `${workspaceFolder}` 类宿主变量。**永远不写带版本号的扩展目录**。#2 的教训。
3. **R3 启动链优先级固定**：全局直连 > 稳定 runtime > npx。npx 是最后手段（冷启动 + 依赖解析不可控），不是默认。
4. **R4 关键 peer 显式声明**：运行时真会 require 的传递依赖 peer（如 ajv）必须进直接 dependencies——镜像/npx 的残缺解析不可控，显式声明可控。#5 的教训。
5. **R5 install 必带悬空修复，doctor 必显悬空**：每次 `graphflow install` 开头跑 `repairDanglingGraphflowMcpEntries`；doctor 对条目启动目标做存在性校验。检测不到的坏配置等于没有修复能力。
6. **R6 用户文档命令标明 shell**：`rmdir /s /q` 是 cmd 语法，PowerShell 里是 `Remove-Item -Recurse -Force`。给 Windows 命令必须写明在哪种 shell 里跑。
7. **R7 发版前干净环境走一遍**：CI 通过 ≠ 用户装得上。发版前在无缓存环境（清 `_npx`/`npm-cache`、或全新容器）走完 `npm install -g` → 首条命令 → MCP 连接 的完整路径。三平台矩阵已覆盖类型面，时序面靠这条。
8. **R8 用户侧 registry 不可控**：镜像会发旧版、会发残缺包。自保手段：首次运行兜底注册（v1.22.1）、`Skill source not found` 时提示官方源重装、文档给 `--registry` 参数。

## 快速排障表（support 用）

| 症状 | 一眼定位 |
| --- | --- |
| 启动中超时 | npx 条目 → `npm install -g` + `graphflow install` 换直连 |
| `Cannot find module ...<版本号>.../mcp-launcher.cjs` | 悬空扩展引用 → `graphflow install`（自动重写） |
| `Cannot find module 'ajv'` | npx 缓存残缺 → 清 `_npx` + 官方源重装 ≥1.23.0 |
| `server not found: ...runtime\...` | v1.22.0 布局 bug → 升级 ≥1.23.0 |
| 装完是旧版/缺 skills | 镜像残缺 → `--registry=https://registry.npmjs.org` 重装 |
