# Real-task plugin ON/OFF evaluation (offline)

Generated: 2026-09-12T04:00:18.251Z
Commit: ff6c36d04bf6e075401cd9eab8b6a8b878db51d2
Index delta this run: 2 files, 27 symbols
Ranker top-K: 10
Capability tolerance: 0.25

## Method

Both arms run the SAME real task on the SAME workspace and differ only in how
the agent is given the code: OFF reads raw files the plugin would compress; ON
uses the GraphFlow context package the plugin exposes plus the ObservationPack
projection. Numbers are re-tokenized with the shipped gpt-4o tokenizer, so they
are independent of GraphFlow's own estimate. A cheaper ON package that loses
required paths/symbols is caught by the capability guard and disqualified.

Live agent runs are not driven here: the DSH headless harness has no
DEEPSEEK_API_KEY in this checkout (the Web app authenticates via a browser
session). This follows docs/benchmark-standards.md.

## Summary

| Task | OFF greedy | OFF realistic | ON context | Saving | ON projected | Retrievable |
| --- | --- | --- | --- | --- | --- | --- |
| T1-efficiency-policy-fallback | 91,454 (10) | 8,826 (5) | 886 | 90.0% | 5,340 (2) | 100% |
| T2-mechanism-trial-to-report | 109,991 (10) | 13,198 (6) | 910 | 93.1% | 5,492 (3) | 100% |
| T3-tool-result-projection | 81,877 (10) | 13,885 (6) | 1,027 | 92.6% | 6,075 (2) | 100% |
| T4-token-savings-baseline | 83,890 (10) | 31,225 (6) | 814 | 97.4% | 5,389 (5) | 100% |
| T5-cli-command-registration | 103,176 (10) | 15,752 (5) | 872 | 94.5% | 4,696 (4) | 100% |
| **Total** | 470,388 | 82,886 | 4,509 | 94.6% | 26,992 | 100% |

## Per-task detail

### T1-efficiency-policy-fallback

> 在 GraphFlow 中 resolveEfficiencyPolicy 如何解析 efficiencyPolicy？当 contextPressure.maxContextTokens 非法时回退到什么值？给出定义文件。

- OFF greedy (grep + top-10 full files): 91,454 tokens across 10 files
- OFF realistic (ranker top-10 anchors -> full files): 8,826 tokens across 5 files
- ON GraphFlow context (summary + anchor pointers): 886 tokens
- ON ObservationPack projection of those files: 5,340 tokens (2 archived)
- one-shot coverage OFF -> ON: paths 0/1, symbols 0/1 -> paths 0/1, symbols 1/1  (ON first query missed: src/config/resolve.ts)
- retrievability (targeted query): paths 1/1, symbols 1/1

### T2-mechanism-trial-to-report

> graphflow mechanism trial 一次配对试验如何写入 graphflow-out/efficiency.json？请列出从 CLI 到落盘的调用链函数名（recordMechanismTrial、onComparison、appendEfficiencyRecord）。

- OFF greedy (grep + top-10 full files): 109,991 tokens across 10 files
- OFF realistic (ranker top-10 anchors -> full files): 13,198 tokens across 6 files
- ON GraphFlow context (summary + anchor pointers): 910 tokens
- ON ObservationPack projection of those files: 5,492 tokens (3 archived)
- one-shot coverage OFF -> ON: paths 2/3, symbols 3/3 -> paths 2/3, symbols 2/3  (ON first query missed: src/surfaces/cli/index.ts, onComparison)
- retrievability (targeted query): paths 3/3, symbols 3/3

### T3-tool-result-projection

> DSH 插件在什么条件下把较大的 tool/result 替换成 gfo 句柄？阈值是多少、如何关闭？涉及 projectToolResultEvent 与 projectToolResult。

- OFF greedy (grep + top-10 full files): 81,877 tokens across 10 files
- OFF realistic (ranker top-10 anchors -> full files): 13,885 tokens across 6 files
- ON GraphFlow context (summary + anchor pointers): 1,027 tokens
- ON ObservationPack projection of those files: 6,075 tokens (2 archived)
- one-shot coverage OFF -> ON: paths 1/3, symbols 2/3 -> paths 1/3, symbols 2/3  (ON first query missed: dsh/plugin.mjs, src/observations/policy.ts, inlineThresholdBytes)
- retrievability (targeted query): paths 3/3, symbols 3/3

### T4-token-savings-baseline

> GraphFlow 的 token-savings 基准如何构造对照臂？baselineTopKFilesFullText 与 grep 基线分别如何选文件？

- OFF greedy (grep + top-10 full files): 83,890 tokens across 10 files
- OFF realistic (ranker top-10 anchors -> full files): 31,225 tokens across 6 files
- ON GraphFlow context (summary + anchor pointers): 814 tokens
- ON ObservationPack projection of those files: 5,389 tokens (5 archived)
- one-shot coverage OFF -> ON: paths 1/1, symbols 2/2 -> paths 1/1, symbols 0/2  (ON first query missed: measureTopKFilesBaseline, measureBaseline)
- retrievability (targeted query): paths 1/1, symbols 2/2

### T5-cli-command-registration

> 在 GraphFlow 中新增一个 graphflow CLI 子命令需要改哪些注册点？以 observe 命令为例，列出 buildCliUsage 和 executeCommand 的位置。

- OFF greedy (grep + top-10 full files): 103,176 tokens across 10 files
- OFF realistic (ranker top-10 anchors -> full files): 15,752 tokens across 5 files
- ON GraphFlow context (summary + anchor pointers): 872 tokens
- ON ObservationPack projection of those files: 4,696 tokens (4 archived)
- one-shot coverage OFF -> ON: paths 1/2, symbols 1/2 -> paths 1/2, symbols 2/2  (ON first query missed: src/surfaces/cli/index.ts)
- retrievability (targeted query): paths 2/2, symbols 2/2

## How to reproduce

```sh
npm run benchmark:real-task-ab
npm run benchmark:real-task-ab -- --record   # also append paired records to graphflow-out/efficiency.json
```
