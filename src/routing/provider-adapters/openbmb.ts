import { logger } from "../../utils/logger";
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import { promisify } from "node:util";

export interface ProviderTextRequest {
  prompt: string;
  model: string;
}

export type OpenBmbMode = "embedded" | "ollama" | "openai-compat";

export interface OpenBmbRuntimeOptions {
  mode?: OpenBmbMode;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  modelPath?: string;
}

const execFileAsync = promisify(execFile);

interface ResolvedOpenBmbOptions {
  mode: OpenBmbMode;
  baseUrl: string;
  apiKey: string | undefined;
  modelPath: string | undefined;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

interface WorkerTaskPayload {
  id: number;
  engine: string;
  command?: string;
  prompt: string;
  model: string;
  modelPath?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

interface WorkerTaskState {
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

class EmbeddedWorkerPool {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, WorkerTaskState>();

  async run(payload: Omit<WorkerTaskPayload, "id">): Promise<string> {
    this.ensureWorker();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restartWorker(new Error(`openbmb embedded worker timed out after ${payload.timeoutMs}ms`), id);
        reject(new Error(`openbmb embedded worker timed out after ${payload.timeoutMs}ms`));
      }, payload.timeoutMs + 500);

      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, ...payload });
    });
  }

  private ensureWorker(): void {
    if (this.worker) {
      return;
    }

    const workerSource = `
      const { parentPort } = require("node:worker_threads");
      const { execFile } = require("node:child_process");
      const { promisify } = require("node:util");
      const execFileAsync = promisify(execFile);
      let llama = null;
      let loadedModel = null;
      let loadedContext = null;
      let loadedSequence = null;
      let loadedModelPath = null;

      async function runCommand(task) {
        if (!task.command) {
          throw new Error("openbmb embedded mode requires GRAPHFLOW_MINICPM_COMMAND");
        }
        const args = [
          "-m",
          task.modelPath || task.model,
          "-p",
          task.prompt,
          "-n",
          String(task.maxTokens),
          "--temp",
          String(task.temperature),
          "--no-display-prompt",
        ];
        const result = await execFileAsync(task.command, args, {
          timeout: task.timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        const output = (result.stdout || "").trim();
        if (!output) {
          throw new Error("openbmb embedded mode returned empty output");
        }
        return output;
      }

      async function ensureNodeLlama(task) {
        if (!task.modelPath) {
          throw new Error("openbmb embedded node-llama-cpp mode requires modelPath");
        }
        if (loadedSequence && loadedModelPath === task.modelPath) {
          return loadedSequence;
        }
        const moduleRef = await import("node-llama-cpp");
        const createLlama = moduleRef.getLlama || moduleRef.createLlama;
        if (typeof createLlama !== "function") {
          throw new Error("node-llama-cpp API not available");
        }
        llama = llama || await createLlama({ gpu: "auto" });
        loadedModel = await llama.loadModel({ modelPath: task.modelPath });
        loadedContext = await loadedModel.createContext({ contextSize: 2048 });
        loadedSequence = loadedContext.getSequence();
        loadedModelPath = task.modelPath;
        return loadedSequence;
      }

      async function runNodeLlama(task) {
        const sequence = await ensureNodeLlama(task);
        const completion = await sequence.prompt(task.prompt, {
          temperature: task.temperature,
          maxTokens: task.maxTokens,
          stopOnAbortSignal: AbortSignal.timeout(task.timeoutMs),
        });
        const text = typeof completion === "string" ? completion.trim() : String(completion || "").trim();
        if (!text) {
          throw new Error("node-llama-cpp produced empty output");
        }
        global.gc?.();
        return text;
      }

      parentPort.on("message", async (task) => {
        try {
          const text = task.engine === "node-llama-cpp" ? await runNodeLlama(task) : await runCommand(task);
          parentPort.postMessage({ id: task.id, ok: true, text });
        } catch (error) {
          logger.error({ error }, "Provider adapter caught error");
          parentPort.postMessage({ id: task.id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    `;

    this.worker = new Worker(workerSource, { eval: true });
    this.worker.on("message", (msg: { id?: number; ok?: boolean; text?: string; error?: string }) => {
      const id = msg.id;
      if (id === undefined) {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.ok && msg.text) {
        pending.resolve(msg.text);
        return;
      }
      pending.reject(new Error(msg.error ?? "openbmb embedded worker failed"));
    });
    this.worker.on("error", (error) => {
      this.restartWorker(error instanceof Error ? error : new Error(String(error)));
    });
    this.worker.on("exit", (code) => {
      if (code !== 0) {
        this.restartWorker(new Error(`openbmb embedded worker exited with code ${code}`));
      } else {
        this.worker = undefined;
      }
    });
  }

  private restartWorker(reason: Error, skipId?: number): void {
    const current = this.worker;
    this.worker = undefined;
    if (current) {
      void current.terminate();
    }
    for (const [id, pending] of this.pending.entries()) {
      if (id === skipId) {
        continue;
      }
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }
}

const embeddedWorkerPool = new EmbeddedWorkerPool();

function resolveOptions(input?: OpenBmbRuntimeOptions): ResolvedOpenBmbOptions {
  const mode = input?.mode ?? (process.env.GRAPHFLOW_OPENBMB_MODE as OpenBmbMode | undefined) ?? "embedded";
  const baseUrl = input?.baseUrl ?? process.env.GRAPHFLOW_OPENBMB_BASE_URL ?? "http://localhost:11434";
  const timeoutMsRaw = input?.timeoutMs ?? Number(process.env.GRAPHFLOW_OPENBMB_TIMEOUT_MS ?? 5000);
  const maxTokensRaw = input?.maxTokens ?? Number(process.env.GRAPHFLOW_OPENBMB_MAX_TOKENS ?? 256);
  const temperatureRaw = input?.temperature ?? Number(process.env.GRAPHFLOW_OPENBMB_TEMPERATURE ?? 0.1);

  return {
    mode,
    baseUrl,
    apiKey: input?.apiKey ?? process.env.GRAPHFLOW_OPENBMB_API_KEY,
    modelPath: input?.modelPath ?? process.env.GRAPHFLOW_OPENBMB_MODEL_PATH,
    timeoutMs: Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.floor(timeoutMsRaw)) : 5000,
    maxTokens: Number.isFinite(maxTokensRaw) ? Math.max(16, Math.floor(maxTokensRaw)) : 256,
    temperature: Number.isFinite(temperatureRaw) ? temperatureRaw : 0.1,
  };
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  options: { timeoutMs: number; apiKey?: string }
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`openbmb http ${response.status}: ${text.slice(0, 400)}`);
    }

    return asJsonRecord(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function pickFirstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickFirstString(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["response", "text", "content", "generated_text"]) {
      const found = pickFirstString(record[key]);
      if (found) return found;
    }
    const choices = record.choices;
    if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
      const choice = choices[0] as Record<string, unknown>;
      const found = pickFirstString(choice.message ?? choice.text);
      if (found) return found;
    }
    const message = record.message;
    if (message && typeof message === "object") {
      const found = pickFirstString((message as Record<string, unknown>).content);
      if (found) return found;
    }
  }
  return undefined;
}

async function runEmbedded(request: ProviderTextRequest, options: ResolvedOpenBmbOptions): Promise<string> {
  const useWorker = process.env.GRAPHFLOW_OPENBMB_USE_WORKER !== "0";
  if (useWorker) {
    return runEmbeddedInWorker(request, options);
  }

  const engine = process.env.GRAPHFLOW_MINICPM_ENGINE ?? "command";
  if (engine === "node-llama-cpp") {
    return runEmbeddedNodeLlamaCpp(request, options);
  }

  const command = process.env.GRAPHFLOW_MINICPM_COMMAND;
  if (!command) {
    throw new Error("openbmb embedded mode requires GRAPHFLOW_MINICPM_COMMAND");
  }

  const args = [
    "-m",
    options.modelPath ?? request.model,
    "-p",
    request.prompt,
    "-n",
    String(options.maxTokens),
    "--temp",
    String(options.temperature),
    "--no-display-prompt",
  ];

  const result = await execFileAsync(command, args, {
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const output = result.stdout.trim();
  if (!output) {
    throw new Error("openbmb embedded mode returned empty output");
  }
  return output;
}

async function runEmbeddedInWorker(
  request: ProviderTextRequest,
  options: ResolvedOpenBmbOptions
): Promise<string> {
  const engine = process.env.GRAPHFLOW_MINICPM_ENGINE ?? "command";
  const command = process.env.GRAPHFLOW_MINICPM_COMMAND;

  const payload: Omit<WorkerTaskPayload, "id"> = {
    engine,
    prompt: request.prompt,
    model: request.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
  };
  if (command) {
    payload.command = command;
  }
  if (options.modelPath) {
    payload.modelPath = options.modelPath;
  }

  return embeddedWorkerPool.run(payload);
}

async function runEmbeddedNodeLlamaCpp(
  request: ProviderTextRequest,
  options: ResolvedOpenBmbOptions
): Promise<string> {
  const modelPath = options.modelPath;
  if (!modelPath) {
    throw new Error("openbmb embedded node-llama-cpp mode requires modelPath");
  }

  const module = (await import("node-llama-cpp")) as any;
  const createLlama = module.getLlama ?? module.createLlama;
  if (typeof createLlama !== "function") {
    throw new Error("node-llama-cpp API not available");
  }

  const llama = await createLlama({ gpu: "auto" });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 2048 });
  const sequence = context.getSequence();
  const completion = await sequence.prompt(request.prompt, {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    stopOnAbortSignal: AbortSignal.timeout(options.timeoutMs),
  });

  const text = typeof completion === "string" ? completion.trim() : String(completion ?? "").trim();
  if (!text) {
    throw new Error("node-llama-cpp produced empty output");
  }
  global.gc?.();
  return text;
}

async function runOllama(request: ProviderTextRequest, options: ResolvedOpenBmbOptions): Promise<string> {
  const payload = await postJson(
    `${options.baseUrl.replace(/\/+$/, "")}/api/generate`,
    {
      model: request.model,
      prompt: request.prompt,
      stream: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
      },
    },
    { timeoutMs: options.timeoutMs }
  );

  const text = pickFirstString(payload.response ?? payload.text ?? payload.message);
  if (!text) {
    throw new Error("openbmb ollama response missing text");
  }
  return text;
}

async function runOpenAiCompat(request: ProviderTextRequest, options: ResolvedOpenBmbOptions): Promise<string> {
  const payload = await postJson(
    `${options.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
    {
      model: request.model,
      messages: [{ role: "user", content: request.prompt }],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: false,
    },
    { timeoutMs: options.timeoutMs, ...(options.apiKey ? { apiKey: options.apiKey } : {}) }
  );

  const text = pickFirstString(payload.choices ?? payload.message ?? payload.content);
  if (!text) {
    throw new Error("openbmb openai-compat response missing text");
  }
  return text;
}

export async function openbmbGenerateText(
  request: ProviderTextRequest,
  runtimeOptions?: OpenBmbRuntimeOptions
): Promise<string> {
  const options = resolveOptions(runtimeOptions);

  try {
    if (options.mode === "embedded") {
      return await runEmbedded(request, options);
    }
    if (options.mode === "ollama") {
      return await runOllama(request, options);
    }
    return await runOpenAiCompat(request, options);
  } catch (error) {
    logger.error({ error }, "Provider adapter caught error");
    const strict = process.env.GRAPHFLOW_OPENBMB_STRICT === "1";
    if (strict) {
      throw error;
    }
    return `[openbmb:${request.model}] ${request.prompt}`;
  }
}
