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

  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { execFile } = require("node:child_process");
    const { promisify } = require("node:util");
    const execFileAsync = promisify(execFile);

    async function runCommand() {
      if (!workerData.command) {
        throw new Error("openbmb embedded mode requires GRAPHFLOW_MINICPM_COMMAND");
      }
      const args = [
        "-m",
        workerData.modelPath || workerData.model,
        "-p",
        workerData.prompt,
        "-n",
        String(workerData.maxTokens),
        "--temp",
        String(workerData.temperature),
        "--no-display-prompt",
      ];
      const result = await execFileAsync(workerData.command, args, {
        timeout: workerData.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const output = (result.stdout || "").trim();
      if (!output) {
        throw new Error("openbmb embedded mode returned empty output");
      }
      return output;
    }

    async function runNodeLlama() {
      if (!workerData.modelPath) {
        throw new Error("openbmb embedded node-llama-cpp mode requires modelPath");
      }
      const moduleRef = await import("node-llama-cpp");
      const createLlama = moduleRef.getLlama || moduleRef.createLlama;
      if (typeof createLlama !== "function") {
        throw new Error("node-llama-cpp API not available");
      }
      const llama = await createLlama();
      const model = await llama.loadModel({ modelPath: workerData.modelPath });
      const context = await model.createContext({ contextSize: 2048 });
      const sequence = context.getSequence();
      const completion = await sequence.prompt(workerData.prompt, {
        temperature: workerData.temperature,
        maxTokens: workerData.maxTokens,
        stopOnAbortSignal: AbortSignal.timeout(workerData.timeoutMs),
      });
      const text = typeof completion === "string" ? completion.trim() : String(completion || "").trim();
      if (!text) {
        throw new Error("node-llama-cpp produced empty output");
      }
      return text;
    }

    (async () => {
      try {
        const text = workerData.engine === "node-llama-cpp" ? await runNodeLlama() : await runCommand();
        parentPort.postMessage({ ok: true, text });
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  `;

  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        engine,
        command,
        prompt: request.prompt,
        model: request.model,
        modelPath: options.modelPath,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
    });

    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`openbmb embedded worker timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs + 500);

    worker.once("message", (msg: { ok?: boolean; text?: string; error?: string }) => {
      clearTimeout(timer);
      if (msg.ok && msg.text) {
        resolve(msg.text);
        return;
      }
      reject(new Error(msg.error ?? "openbmb embedded worker failed"));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`openbmb embedded worker exited with code ${code}`));
      }
    });
  });
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

  const llama = await createLlama();
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
    const strict = process.env.GRAPHFLOW_OPENBMB_STRICT === "1";
    if (strict) {
      throw error;
    }
    return `[openbmb:${request.model}] ${request.prompt}`;
  }
}
