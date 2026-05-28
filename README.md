# GraphFlow

**A Context-Aware Multi-Agent Orchestration Engine**

GraphFlow 是一个基于 TypeScript 原生构建的轻量级、自适应多智能体编排引擎。它通过整合**多模态全局图谱上下文**（如 Graphify）与**高级提示词管理/工作流状态机**（如 Superpowers），为现代 AI 辅助开发（如 Claude Code, Cursor, Hermes）提供强大的并发执行、动态拆解与闭环校验能力。

## 当前实现状态（v0.1 Full Feature）

已实现并可直接运行：

1. 混合路由：simple/complex 自动分流。
2. 复杂任务编排：Planner -> DAG -> Worker -> Validator。
3. 每任务校验与重试上限控制。
4. 模型分层路由与供应商 fallback（OpenAI/Anthropic/百炼/豆包）。
5. 图谱增量同步（run 完成后自动索引）。
6. Graphify MCP HTTP 客户端与 memory 模式切换。
7. 近无损上下文压缩：
- 双通道上下文包（summary + anchor）
- L1/L2/L3 配额
- 动态回补（refill）去重
8. CLI 全命令：`run`、`context preview`、`graph index`。
9. VS Code 扩展骨架已接核心 runtime。
10. 学习飞轮数据导出与 canary 门禁基础能力。

---

## 快速开始

```bash
npm install
npm run build
npm test
```

可选：复制配置模板。

```bash
copy graphflow.config.example.json graphflow.config.json
```

---

## CLI 使用

1. 执行任务：

```bash
npm run start -- run "update readme and add tests"
```

2. 查看上下文压缩预览：

```bash
npm run start -- context preview "orchestrate"
```

输出示例：

```text
summary=12; anchors=9; tokens=118; truncated=false; L1=6; L2=2; L3=1
```

3. 索引工作区到图谱：

```bash
npm run start -- graph index .
```

---

## 配置说明

配置文件：`graphflow.config.json`，可参考：`graphflow.config.example.json`。

关键字段：

1. `graphPolicy.transport`:
- `memory`：本地内存图谱（默认开发调试）
- `mcp-http`：Graphify MCP HTTP
2. `graphPolicy.enableNearLosslessMode`：是否启用近无损上下文包。
3. `graphPolicy.layerQuota`：L1/L2/L3 信息配额。
4. `graphPolicy.autoIndexOnPreview`：context preview 前是否自动索引工作区。
5. `learningPolicy.exportPath`：学习飞轮样本导出路径。

---

## 近无损上下文机制

GraphFlow 的 token 压缩不是简单截断，而是结构化压缩：

1. Summary Channel：在预算内提供高密度摘要文本。
2. Anchor Channel：保留可追溯锚点（ID + 类型 + 层级）。
3. Layer Quota：限制 L1/L2/L3 比例，避免信息偏食。
4. Refill：需要更多证据时按 hint 增量回补，且去重。

---

## 验证命令

```bash
npm run lint
npm run build
npm test
```

---

## 💡 核心设计理念

* **极简核心 (Minimal Core):** 摒弃臃肿的重型框架，核心流转完全基于 TypeScript 异步生成器与事件驱动 (EventEmitter) 构建，确保对状态流转的 100% 掌控。
* **白盒状态机 (White-box State):** 任务拆解与执行均依托于有向无环图 (DAG)。每一次模型的思考、工具调用与代码 Diff 均可溯源。
* **精准剪裁上下文 (Just-in-Time Context):** 拒绝粗暴的全量代码注入。通过 MCP (Model Context Protocol) 桥接外部知识图谱，仅为执行端 Agent 提取“视距内”的代码依赖，实现极低 Token 消耗与抗幻觉。
* **高低搭配 (Model Routing):** 规划 (Planner) 与校验 (Validator) 采用高智商模型保证逻辑下限，并发执行 (Worker) 采用高性价比模型提升吞吐量。

---

## 🏗 系统架构

```text
  ┌────────────────────────────────────────────────────────┐
  │                 Web UI  /  CLI Terminal                │  <-- 用户交互与看板层
  └───────────────────────────┬────────────────────────────┘
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │                    GraphFlow Core                      │  <-- 核心路由与状态引擎
  │  ┌──────────────────────┐    ┌──────────────────────┐  │
  │  │   Triage & Planner   │    │  Validator & Router  │  │  (强 LLM: Claude 3.5 Sonnet 等)
  │  └──────────┬───────────┘    └──────────▲───────────┘  │
  │             ▼                           │              │
  │     [生成任务 DAG 图]             [代码/结果严格对齐]         │
  │             ▼                           │              │
  │  ┌──────────────────────────────────────┴───────────┐  │
  │  │               Worker Agents 并发池                │  │  (性价比 LLM: Haiku / DeepSeek)
  │  └──────────────────────────────────────────────────┘  │
  └───────────────────────────┬────────────────────────────┘
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │               Context & External Tools                 │  <-- 基础设施接入层
  │   [Graphify MCP Server]       [本地文件系统 / AST 解析]   │
  └────────────────────────────────────────────────────────┘

```

---

## 🛠 技术栈选型

* **运行时:** Node.js (v20+) + TypeScript (原生支持顶层 Await，极度契合 I/O 并发)。
* **LLM 驱动:** `@ai-sdk/core` (Vercel AI SDK，统一封装多模型厂商 API，原生支持 Structured Outputs)。
* **上下文接入:** `@modelcontextprotocol/sdk` (作为 Client 无缝对接 Graphify 或任意提供代码上下文的 Server)。
* **并发控制:** 纯手写基于 `Promise` 与 `EventEmitter` 的 DAG 调度器。
* **CLI 界面:** `clack` / `commander`。

---

## 📂 目录结构规划

```text
graphflow/
├── src/
│   ├── agents/                 # 智能体核心逻辑
│   │   ├── base-agent.ts       # 封装 AI SDK 调用与重试机制的基类
│   │   ├── planner.ts          # 负责将大目标拆解为 DAG 任务数组
│   │   ├── worker.ts           # 负责执行单一、受限上下文的任务
│   │   └── validator.ts        # 负责比对需求与 Diff，控制重试循环
│   ├── core/                   # 无状态引擎层
│   │   ├── dag-engine.ts       # 核心有向无环图解析与并发调度器
│   │   ├── state-store.ts      # 全局运行状态、日志与溯源存储
│   │   └── types.ts            # 全局接口与类型定义
│   ├── mcp/                    # 外部知识库桥接
│   │   └── graphify-client.ts  # 通过 MCP 协议检索结构化上下文切片
│   ├── prompts/                # 集中管理的 System Prompts (防散落)
│   ├── utils/                  # 辅助工具 (限流器、Diff 解析、Token 估算)
│   └── index.ts                # CLI / API 统一入口
├── package.json
├── tsconfig.json
└── README.md

```

---

## 💻 核心代码范例 (Boilerplate)

### 1. 全局类型定义 (`src/core/types.ts`)

```typescript
export type TaskStatus = 'PENDING' | 'RUNNING' | 'VALIDATING' | 'COMPLETED' | 'FAILED';

export interface TaskNode {
  id: string;
  description: string;
  dependencies: string[]; // 依赖任务的 ID 列表
  status: TaskStatus;
  contextQuery: string;   // 传递给 Graphify 的检索条件
  result?: any;
  retryCount: number;
}

```

### 2. DAG 调度引擎引擎 (`src/core/dag-engine.ts`)

```typescript
import { EventEmitter } from 'events';
import { TaskNode } from './types';
// import { runWorker, runValidator } from '../agents';
// import { fetchContext } from '../mcp/graphify-client';

export class DagEngine extends EventEmitter {
  private tasks: Map<string, TaskNode> = new Map();

  public loadPlan(plan: TaskNode[]) {
    plan.forEach(task => this.tasks.set(task.id, task));
  }

  public async execute() {
    // 找出所有状态为 PENDING 且前置依赖均已 COMPLETED 的任务
    const readyTasks = Array.from(this.tasks.values()).filter(t => 
      t.status === 'PENDING' && 
      t.dependencies.every(depId => this.tasks.get(depId)?.status === 'COMPLETED')
    );

    if (readyTasks.length === 0 && this.isAllCompleted()) {
      this.emit('workflowComplete');
      return;
    }

    // 并发触发所有就绪任务
    await Promise.all(readyTasks.map(task => this.runTaskLoop(task)));
  }

  private async runTaskLoop(task: TaskNode) {
    task.status = 'RUNNING';
    this.emit('taskUpdate', task);
    
    try {
      // 1. MCP 动态上下文切片
      // const context = await fetchContext(task.contextQuery);
      const context = "mocked_context"; 
      
      // 2. 闭环执行与校验
      let isSuccess = false;
      while (task.retryCount < 3 && !isSuccess) {
        // const workerOutput = await runWorker(task, context);
        // const validation = await runValidator(task, workerOutput);
        
        const validation = { passed: true, feedback: 'OK' }; // Mock

        if (validation.passed) {
          isSuccess = true;
          task.status = 'COMPLETED';
          // task.result = workerOutput;
          this.emit('taskUpdate', task);
          
          // 当前任务完成，递归驱动下游任务
          this.execute(); 
        } else {
          task.retryCount++;
          this.emit('taskWarn', `Task ${task.id} 打回，原因: ${validation.feedback}`);
        }
      }

      if (!isSuccess) {
        task.status = 'FAILED';
        this.emit('taskFailed', task);
      }

    } catch (error) {
      task.status = 'FAILED';
      this.emit('taskError', { task, error });
    }
  }

  private isAllCompleted(): boolean {
    return Array.from(this.tasks.values()).every(t => t.status === 'COMPLETED');
  }
}

```

### 3. Agent 抽象基类 (`src/agents/base-agent.ts`)

```typescript
import { generateText, generateObject, LanguageModel } from 'ai';

export abstract class BaseAgent {
  constructor(
    protected roleName: string,
    protected modelProvider: LanguageModel,
    protected systemPrompt: string
  ) {}

  protected async invokeText(prompt: string, context: string = '') {
    const { text } = await generateText({
      model: this.modelProvider,
      system: `${this.systemPrompt}\n\n<CONTEXT>\n${context}\n</CONTEXT>`,
      prompt: prompt,
      temperature: 0.2, // 保持代码生成的确定性
    });
    return text;
  }

  protected async invokeStructured<T>(prompt: string, schema: any): Promise<T> {
    const { object } = await generateObject({
      model: this.modelProvider,
      system: this.systemPrompt,
      prompt: prompt,
      schema: schema, 
    });
    return object as T;
  }
}

```

---

## 🚀 阶段开发路线图 (Roadmap)

### Phase 1: 基座搭建 (Engine Foundation)

* [ ] 初始化 TS 环境及 `eslint` / `prettier` 配置。
* [ ] 编写并测试 `DagEngine`，确保并发依赖处理逻辑无死锁。
* [ ] 实现基础的 Agent 基类，打通 Vercel AI SDK。

### Phase 2: 智能体角色填充 (Agent Implementation)

* [ ] **Planner Agent:** 使用 Structured Output，输入自然语言需求，输出符合严格 JSON Schema 的 DAG 任务数组。
* [ ] **Worker Agent:** 实现基础的文件修改意图生成（如输出 unified diff 格式）。
* [ ] **Validator Agent:** 实现双向对齐检查逻辑。

### Phase 3: 图谱与外部桥接 (Context & Integration)

* [ ] 引入 `@modelcontextprotocol/sdk`。
* [ ] 编写 `graphify-client.ts`，支持向外部知识库发送语义/符号查询并获取返回内容。
* [ ] 在 `DagEngine` 中接入限流队列（如 `p-queue`），防止高并发调用触发 LLM API 的 `429 Too Many Requests`。

### Phase 4: UI 与体验打磨 (Interface & Polish)

* [ ] 编写基于 `clack` 的精美命令行交互。
* [ ] 实现任务执行日志的流式输出（区分不同 Worker 的控制台颜色）。
* [ ] （进阶）对外暴露本地 HTTP/SSE 接口，为未来接驳可视化 Web 面板做准备。

---

## ⚠️ 避坑指南与最佳实践

1. **无限重试地狱:** `Validator` 打回任务时，必须严格限制最大重试次数（建议 `MAX_RETRIES = 3`）。超过阈值立即挂起该分支，抛出警告要求人类介入 (Human-in-the-loop)。
2. **Context 污染控制:** 当任务打回重试时，不要将上一次执行的巨量全量日志或完整错误堆栈喂给 Worker。必须由 Validator 提炼出精简的 `<Feedback>` 注入 Prompt。
3. **JSON Schema 深度边界:** Planner 拆解任务时，提示词中应明确限制 DAG 树的深度（建议不超过 2-3 层依赖），过深的层级会极大增加模型幻觉和结构化输出崩溃的概率。
4. **Token 桶限流:** 强烈建议在基类的 `invoke` 方法外部包裹一层请求限流器，多个 Worker 瞬时启动并发极易被 API 厂商风控拦截。