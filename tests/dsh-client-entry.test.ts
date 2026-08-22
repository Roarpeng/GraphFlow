// @vitest-environment node
/**
 * dsh/client.js 静态客户端 bundle 入口测试。
 *
 * dsh/client.js 是预构建 CJS factory：文件末尾执行
 * `window.__ModuleLoader__.load({ id, factory })`。Node 没有 window，因此测试在
 * 首次动态 import 之前 stub `globalThis.window` 捕获注册，然后驱动
 * `factory(stubRequire)`（stubRequire 只允许 seed 词 "react"）验证：
 *   1. loader 收到图行 id（= 扫描条目名）+ factory 函数；
 *   2. factory 导出 named `apply` 与 `inject` 服务声明数组；
 *   3. apply 注册两个 slot 贡献（gf-knowledge-toggle / gf-knowledge），
 *      ToggleButton 渲染调用 React.createElement（stubRequire("react") 返回的 React）；
 *   4. 面板取数走 `connection.rpc.call("/gf", "nodes", { workspaceRoot })`
 *      （RpcResult 信封解包 data.value），点击主题续聊走
 *      `sessions.binding(currentId).session.prompt(..., "queue")`。
 */
import { beforeAll, describe, expect, it } from "vitest";

const MODULE_ID = "@roarpeng/graphflow/dsh";

type LoadRegistration = {
  id: string;
  factory: (requireFn: (spec: string) => unknown) => Record<string, unknown>;
};

// 必须在首次 import dsh/client.js 之前 stub window（模块顶层副作用）。
const registrations: LoadRegistration[] = [];
(globalThis as unknown as { window: { __ModuleLoader__: { load: (r: LoadRegistration) => void } } }).window = {
  __ModuleLoader__: {
    load: (r) => registrations.push(r),
  },
};

let factory: LoadRegistration["factory"] | undefined;

beforeAll(async () => {
  await import("../dsh/client.js");
  factory = registrations[0]?.factory;
});

// ─────────────────────────── render harness ───────────────────────────

type ReactElement = {
  type: unknown;
  props: Record<string, unknown>;
  children: ReactElement[];
};

type CreateElementCall = { type: unknown; props: Record<string, unknown> };

interface ReactStub {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ReactElement;
  useState(initial: unknown): [unknown, (next: unknown | ((prev: unknown) => unknown)) => void];
  useEffect(fn: () => unknown): void;
  useCallback<T>(fn: T): T;
}

interface RenderHarness {
  React: ReactStub;
  createElementCalls: CreateElementCall[];
  renderComponent<T>(invoke: () => T, opts?: { fresh?: boolean }): T;
  renderTree(el: ReactElement, opts?: { fresh?: boolean }): ReactElement;
}

function createRenderHarness(): RenderHarness {
  const createElementCalls: CreateElementCall[] = [];
  let hookStates: Array<[unknown]> = [];
  let hookPos = 0;
  let effects: Array<() => unknown> = [];

  const React: ReactStub = {
    createElement(type, props, ...children) {
      const normalized: Record<string, unknown> = props ?? {};
      createElementCalls.push({ type, props: normalized });
      const flat: unknown[] = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child);
        else flat.push(child);
      }
      return { type, props: normalized, children: flat as ReactElement[] };
    },
    useState(initial) {
      const pos = hookPos++;
      if (hookStates[pos] === undefined) {
        hookStates[pos] = [typeof initial === "function" ? (initial as () => unknown)() : initial];
      }
      const set = (next: unknown | ((prev: unknown) => unknown)) => {
        const prev = hookStates[pos]?.[0];
        hookStates[pos] = [typeof next === "function" ? (next as (prev: unknown) => unknown)(prev) : next];
      };
      return [hookStates[pos]?.[0], set];
    },
    useEffect(fn) {
      effects.push(fn);
    },
    useCallback(fn) {
      return fn;
    },
  };

  function renderComponent<T>(invoke: () => T, opts: { fresh?: boolean } = {}): T {
    if (opts.fresh === true) hookStates = [];
    hookPos = 0;
    effects = [];
    const result = invoke();
    // 每次渲染后运行 effects（含 cleanup），让 subscribe / refresh 副作用真实发生。
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === "function") (cleanup as () => void)();
    }
    return result;
  }

  function renderTree(el: ReactElement, opts?: { fresh?: boolean }): ReactElement {
    let current = el;
    while (typeof current.type === "function") {
      const fn = current.type as (props: Record<string, unknown>) => ReactElement;
      current = renderComponent(() => fn(current.props), opts);
    }
    return current;
  }

  return { React, createElementCalls, renderComponent, renderTree };
}

// ─────────────────────────── ctx / slots stubs ───────────────────────────

type SlotSpec = { name: string; id: string; order: number; label: () => string };
type SlotComponent = (props: Record<string, unknown>) => ReactElement;
type RegisterCall = { spec: SlotSpec; component: SlotComponent };

function createSlotStub() {
  const injectCbs = new Map<string, () => unknown>();
  const registerCalls: RegisterCall[] = [];
  const slots = {
    inject: (key: string, cb: () => unknown) => {
      injectCbs.set(key, cb);
    },
    register: (spec: SlotSpec, component: SlotComponent) => {
      registerCalls.push({ spec, component });
      return () => undefined;
    },
  };
  return { slots, injectCbs, registerCalls };
}

function createCtxStub(services: Record<string, unknown>) {
  return {
    get: (name: string) => services[name],
  };
}

/** 运行捕获的 factory：stubRequire 只允许 seed 词 "react"，其余大声抛错（规格书 §1.1）。 */
function runFactory(h: RenderHarness): Record<string, unknown> {
  expect(factory).toBeTypeOf("function");
  return (factory as LoadRegistration["factory"])((spec: string) => {
    if (spec === "react") return h.React;
    throw new Error(`unexpected require: ${spec}`);
  });
}

function findButton(el: unknown, className: string): ReactElement | undefined {
  if (el === null || typeof el !== "object") return undefined;
  const node = el as ReactElement;
  if (node.type === "button" && String(node.props.className ?? "").includes(className)) return node;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    const found = findButton(child, className);
    if (found) return found;
  }
  return undefined;
}

/** 排空 microtask（含 promise 链的 .then/.catch/.finally）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─────────────────────────── tests ───────────────────────────

describe("dsh 静态客户端 bundle 入口（dsh/client.js）", () => {
  it("load() 收到图行 id 与 factory 函数", () => {
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.id).toBe(MODULE_ID);
    expect(typeof registrations[0]?.factory).toBe("function");
  });

  it("factory 只 require seed 模块，导出 named apply 与 inject 服务声明", () => {
    const h = createRenderHarness();
    const required: string[] = [];
    const mod = (factory as LoadRegistration["factory"])((spec: string) => {
      required.push(spec);
      if (spec === "react") return h.React;
      throw new Error(`unexpected require: ${spec}`);
    });
    expect(required).toEqual(["react"]);
    expect(typeof mod.apply).toBe("function");
    expect(mod.inject).toEqual(expect.arrayContaining(["sessions", "slots", "connection"]));
  });

  it("apply 注册 toggle 与 panel 两个 slot 贡献，ToggleButton 经 React.createElement 渲染", () => {
    const h = createRenderHarness();
    const mod = runFactory(h);
    const apply = mod.apply as (ctx: { get: (name: string) => unknown }) => void;
    const slotStub = createSlotStub();
    apply(createCtxStub({ slots: slotStub.slots, sessions: {}, connection: {} }));

    expect(slotStub.injectCbs.has("conversation.session.header.utilities")).toBe(true);
    expect(slotStub.injectCbs.has("shell.overlay")).toBe(true);

    slotStub.injectCbs.get("conversation.session.header.utilities")!();
    slotStub.injectCbs.get("shell.overlay")!();

    const toggleReg = slotStub.registerCalls.find((r) => r.spec.id === "gf-knowledge-toggle");
    const panelReg = slotStub.registerCalls.find((r) => r.spec.id === "gf-knowledge");
    expect(toggleReg?.spec.order).toBe(90);
    expect(panelReg?.spec.order).toBe(10);
    expect(toggleReg?.spec.label()).toBe("知识节点");

    // ToggleButton 渲染为原生 button（stubRequire("react") 返回的 React 被用于 createElement）
    const toggleEl = h.renderTree(toggleReg!.component({ sessionId: "s1" }));
    expect(toggleEl.type).toBe("button");
    expect(toggleEl.props["aria-label"]).toBe("知识节点");
    expect(h.createElementCalls.some((c) => c.type === "button" && c.props["aria-label"] === "知识节点")).toBe(true);
  });

  it("面板经 connection.rpc.call('/gf','nodes',…) 取数，续聊走 sessions.binding().prompt('queue')", async () => {
    const h = createRenderHarness();
    const mod = runFactory(h);
    const apply = mod.apply as (ctx: { get: (name: string) => unknown }) => void;

    const rpcCalls: Array<{ channel: string; endpoint: string; payload: unknown }> = [];
    let resolveNodes: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolveNodes = resolve;
    });
    const connection = {
      rpc: {
        call: (channel: string, endpoint: string, payload: unknown) => {
          rpcCalls.push({ channel, endpoint, payload });
          return pending;
        },
      },
    };

    const promptCalls: Array<{ messages: unknown; mode: unknown }> = [];
    const sessions = {
      binding: (_id: string) => ({
        session: {
          prompt: (messages: unknown, mode: unknown) => {
            promptCalls.push({ messages, mode });
            return Promise.resolve();
          },
        },
      }),
    };

    const slotStub = createSlotStub();
    apply(createCtxStub({ slots: slotStub.slots, sessions, connection }));
    slotStub.injectCbs.get("conversation.session.header.utilities")!();
    slotStub.injectCbs.get("shell.overlay")!();
    const toggleReg = slotStub.registerCalls.find((r) => r.spec.id === "gf-knowledge-toggle")!;
    const panelReg = slotStub.registerCalls.find((r) => r.spec.id === "gf-knowledge")!;

    // 点 toggle 打开面板
    const toggleEl = h.renderTree(toggleReg.component({ sessionId: "s1" }));
    (toggleEl.props.onClick as () => void)();

    // 渲染面板（open=true）→ 刷新 effect 触发取数
    const useSessions = (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ current: "s1", byId: { s1: { cwd: "/tmp/gf-ws" } } });
    const panelEl = h.renderTree(panelReg.component({ useSessions }), { fresh: true });
    expect(panelEl.type).toBe("div");
    expect(panelEl.props.className).toBe("gf-panel");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({ channel: "/gf", endpoint: "nodes", payload: { workspaceRoot: "/tmp/gf-ws" } });

    // 宿主返回 RpcResult 信封 → 重渲染出 workbench 主题与对话记录
    resolveNodes({
      ok: true,
      value: {
        workbench: [
          {
            rootId: "r1",
            task: "Build the static panel",
            nodes: [
              { id: "n1", title: "Static bundle", active: true, kind: "main", messageCount: 2, lastUserPreview: "how is it served?" },
            ],
          },
        ],
        dialogues: [
          { id: "d1", seq: 7, userQuery: "what is the rev param?", title: "rev param", summary: "sha1 slice", jumped: false },
        ],
      },
    });
    await flushMicrotasks();

    const panelEl2 = h.renderTree(panelReg.component({ useSessions }), { fresh: false });
    const topicButton = findButton(panelEl2, "gf-node");
    expect(topicButton).toBeDefined();
    (topicButton!.props.onClick as () => void)();

    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]?.mode).toBe("queue");
    const messages = promptCalls[0]?.messages as Array<{ type: string; text: string }>;
    const text = messages[0]?.text ?? "";
    expect(text).toContain('rootDir: "/tmp/gf-ws"');
    expect(text).toContain('topicId: "n1"');
    expect(text).toContain("Static bundle");
  });
});
