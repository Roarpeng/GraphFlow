# Design: U7 — Output-Side Tool-First (输出侧 tool-first 协议)

> 状态:设计稿(Phase 3)。核心动机:输出 token 单价是输入的 3-5 倍,而当前 run/桥接协议
> 让宿主 agent 用**自由文本**回答(重述上下文、整文件重写)。目标:模型输出**意图**,
> 工具输出**字节**。

## 1. 问题

- `executionDescriptor`(graphflow_run 桥接产物)携带 task/context/retryHints/steps,
  但对"agent 如何返回结果"没有任何结构约束——宿主 agent 的回答是自由文本,常常:
  - 复述 GraphFlow 已给的上下文(输入侧再付一遍输出价)
  - 整文件重写而非 diff(输出 token 放大 10-100 倍)
- anchor-bodies 已有 exact/relocated/drifted 三态寻址(U 已验证),但只用于**读取**,
  没有用于**写入寻址**。

## 2. 设计

### 2.1 ExecutionDescriptor 扩展 edit-intent 结构

```ts
executionDescriptor: {
  action: "execute";
  task: string;
  context: string;          // 不变(锚点内联,稳定序)
  retryHints: string[];
  steps?: FusedStep[];      // 不变
  /** U7 新增:结果回写的结构化协议 */
  resultProtocol?: {
    kind: "edit-intent-v1";
    /** 允许的输出形态:引用锚点 + 结构化意图,禁止复述上下文原文 */
    rules: [
      "reference anchor ids, never restate context text",
      "emit edits as intents (target anchor id + operation), not full files",
    ];
    /** 意图 schema(建议宿主采用;不采用时回退自由文本,协议永不强制) */
    intentSchema: {
      target: "anchor:<id>";        // anchor-bodies 三态寻址
      operation: "replace|insert|delete|rename";
      payload: "diff|hunk|identifier";  // 有界载荷
    };
  };
}
```

### 2.2 SKILL.md 输出纪律(协议层,零代码)

在 run 协议段加一条硬指引:

> 回答 run 结果时:引用锚点 id 而非复述上下文;编辑以意图表达(目标锚点 + 操作 + 最小
> diff),不整文件重写;验证结果给命令与退出码,不给日志全文(日志走 observation reduce)。

### 2.3 MCP 侧接收(后续增量,不在本稿)

`graphflow_report_outcome` 可选接收 `editIntents[]`(同 2.1 schema),存 episode 供
飞轮统计"意图密度"(意图/自由文本比)——作为输出侧 token 效率的代理指标进 cost ledger。

## 3. 不做(护栏)

- 不强制:协议是 advisory,宿主不支持时自由文本照旧(fail-open 原则一致)。
- 不代理执行:GraphFlow 仍不写代码;意图的执行者是宿主 agent 或其工具。
- 不在本轮实现接收端——先验证协议被宿主遵循的比例(dogfood 统计),有数据再建。

## 4. 预期收益路径

输出 token = f(复述量, 重写量)。协议把两者都换成引用与最小 diff:
- 复述 → 锚点引用(几乎为零)
- 整文件重写 → hunk(典型 1-2 个函数)
理论下限:输出量降一个数量级;实际上限取决于宿主遵循率——**这正是要 dogfood 测量的**。

## 5. 里程碑

1. M1(本稿):SKILL.md 纪律 + descriptor 结构落文档(协议存在)
2. M2:report_outcome 接收 editIntents + 意图密度进 ledger(测量)
3. M3:遵循率数据决定是否升级为 enforce(拒绝无意图的重型编辑回写)
