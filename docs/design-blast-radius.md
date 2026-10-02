# Design: U8 — Blast-Radius Engine(N 跳影响面引擎)

> 状态:设计稿(Phase 3)。动机:working-set 与 diff-challenge 各自维护一套"一跳"
> 影响面计算(代码重复、能力相同、都到不了二跳);质询门与精准喂料共享同一个底层需求:
> **"改了 X,图知道谁会疼"**。

## 1. 现状与差距

| 能力 | 输入 | 跳数 | 输出 |
| --- | --- | --- | --- |
| `working-set`(src/graph/working-set.ts) | touched files | 1 跳(calls/references/validates) | prefetch 文件清单 + reason |
| `diff-challenge`(src/graph/diff-challenge.ts) | touched files / planNodes | 1 跳 | 质询问题清单 |

共享缺口:二跳闭包(改 A 的调用方 B,B 又被 C 调用)、符号集入参(working-set 只吃
文件)、reason 传播(一跳后丢失"为什么")。

## 2. 设计:一个引擎,两个面

```ts
// src/graph/blast-radius.ts(新)
interface BlastRadiusOptions {
  roots: { files?: string[]; symbols?: string[] };   // 两面统一的入参
  maxHops: 1 | 2;                                     // 默认 1(现行为),2 为增量
  maxNodes: number;                                   // 预算上限(默认 64)
  relations?: GraphEdge["relation"][];                // 默认 calls/references/validates
}
interface BlastRadiusReport {
  nodes: Array<{
    id: string;                // 文件或符号锚点
    hop: 1 | 2;
    reason: string;            // "caller of X via calls" — 全路径 reason 串联
    viaPath: string[];         // 触达路径(审计 + 解释)
  }>;
  truncated: boolean;
  costMs: number;
}

export async function computeBlastRadius(client, options): Promise<BlastRadiusReport>
```

- **BFS 分层扩展**:一跳用现有 getNeighbors 逻辑(直接抽自 working-set 的
  expandCandidateFiles / diff-challenge 的 neighbors,两处合并为此引擎);二跳仅当
  `maxHops=2` 且预算未超,从一跳结果继续一跳,**跳过 test 文件除非 roots 含 test**
  (防爆炸;working-set 的 test-for 优先级保留为排序而非硬性)。
- **确定性**:同图同 roots 同预算 → 相同输出(排序 by (hop, id),符合 U2 稳定序原则)。
- **迁移**:`working-set` CLI 与 `diff-challenge` 改为薄壳(参数适配 + 各自的呈现层:
  prefetch 清单 vs 质询问题),行为兼容(一跳默认,输出集合不变——由现有测试锁定)。

## 3. 消费者

| 消费者 | 用法 | 阶段 |
| --- | --- | --- |
| working-set CLI / preview 预取 | blast(files, maxHops=1) → prefetch 清单(现行为) | 迁移 |
| diff-challenge / 质询门 | blast(files∪planSymbols, maxHops=2) → external-caller 质询升级为"二跳调用方也在场" | 迁移+增强 |
| U7 edit-intent 的 target 校验 | intent.target 锚点 ∈ blast(roots) 否则警告"编辑面超出影响面" | M2 |
| preview 精准喂料(未来) | blast(working-set roots, 2) 的 viaPath 作为 anchor-bodies 的函数级片段来源 | 观察期 |

## 4. 风险与护栏

- **图爆炸**:maxNodes 硬预算 + truncated 标记;二跳默认关,显式开启。
- **语义漂移**:迁移以"现有测试不改动即通过"为验收基线;呈现层差异(问题措辞/清单
  格式)留在壳里,引擎只出结构化报告。
- **性能**:一跳现状已可用;二跳 BFS 在 10k 节点图上预估 <50ms(两次 getNeighbors),
  budget 内;costMs 字段自我监督。

## 5. 里程碑

1. M1:引擎实现 + working-set/diff-challenge 迁移(行为不变,测试锁定)
2. M2:maxHops=2 进质询门(二跳调用方质询)+ U7 target 校验
3. M3:函数级片段喂给(viaPath → anchor-bodies 扩展)——待 M2 的质询命中率数据决定
