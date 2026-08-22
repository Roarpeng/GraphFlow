/**
 * GraphFlow — DeepSeek Harness 知识节点面板（静态 dsh client bundle，预构建即源码）。
 *
 * 本文件是 dsh client-modules 的静态客户端 bundle：预构建 CJS factory 形式，
 * 文件末尾以 `window.__ModuleLoader__.load({ id, factory })` 注册（id = 扫描条目名，
 * 与 cordis.patch.yml 的 glue 行一致）。dsh 宿主把 `exports["./client"]` 指向的
 * 本文件原样 serve（/plugins/@roarpeng/graphflow/dsh/client.js?rev=<sha1>），因此
 * 本文件本身就必须是 factory 产物 —— 不需要 bundler：factory 只 require seed 模块
 * `"react"`（dsh shell 提供的 7 个 seed 词之一，见 gf-static-spec §1.1）。
 *
 * 功能与动态版（web/plugin.mjs clientHalf）完全一致：
 *   - `conversation.session.header.utilities` 注册 "知识节点" ToggleButton
 *     （id gf-knowledge-toggle，order 90）；
 *   - `shell.overlay` 注册右侧 KnowledgePanel（id gf-knowledge，order 10）；
 *   - 取数走 Connection 通用 RPC 通道（规格书 §3.2 路 A）：
 *     `ctx.connection.rpc.call("/gf", "nodes", { workspaceRoot: cwd })`，
 *     宿主（dsh/plugin.mjs，I2 负责）在 `/gf` 注册 handler 并返回 RpcResult 信封
 *     `{ ok: true, value: { workbench, dialogues } }`；
 *   - 点击续聊：`sessions.binding(currentId).session.prompt([...], "queue")`。
 *
 * 仅纯 JavaScript：无 TS/JSX/import；React 来自 require seed。样式在 factory 闭包内
 * 注入 <style>（防重守卫，照抄 dsh-client-ui-jobs/lib/client.js:10-19 先例）。
 */

const factory = (require) => {
  const module = { exports: {} };
  const exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

  const React = require("react");

  // ── styles（闭包内注入，data-plugin-css 防重守卫） ──
  const CSS = `
.gf-panel {
  position: fixed;
  top: 64px;
  right: 16px;
  bottom: 96px;
  width: 340px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-overlay, #202020);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4));
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,.35);
  color: var(--dsw-alias-label-primary, #eee);
  font-size: 13px;
  line-height: 1.45;
  overflow: hidden;
  z-index: 1000;
  pointer-events: auto;
}
.gf-panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  flex: none;
}
.gf-panel-title { font-weight: 600; flex: 1; }
.gf-panel-btn {
  background: none;
  border: none;
  color: var(--dsw-alias-label-secondary, #aaa);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
}
.gf-panel-btn:hover { background: rgba(128,128,128,.18); }
.gf-panel-body { flex: 1; overflow: auto; padding: 4px 10px 16px; }
.gf-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #aaa);
  margin: 12px 2px 6px;
  letter-spacing: .04em;
}
.gf-node {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 8px;
  padding: 6px 8px;
  margin: 2px 0;
  color: var(--dsw-alias-label-primary, #eee);
  cursor: pointer;
  font: inherit;
}
.gf-node:hover { background: rgba(128,128,128,.14); }
.gf-node-title { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.gf-node-label { font-weight: 500; min-width: 0; }
.gf-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(128,128,128,.22);
  color: var(--dsw-alias-label-secondary, #aaa);
  flex: none;
}
.gf-badge-active { background: var(--dsw-alias-brand-primary, #4a90d9); color: #fff; }
.gf-badge-pending { background: var(--dsw-alias-state-warn-primary, #e0a13c); color: #000; }
.gf-badge-jump { background: var(--dsw-alias-state-warn-primary, #e0a13c); color: #000; }
.gf-node-preview {
  color: var(--dsw-alias-label-secondary, #aaa);
  font-size: 12px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-empty { color: var(--dsw-alias-label-secondary, #aaa); padding: 18px 6px; text-align: center; font-size: 12px; }
.gf-error { color: var(--dsw-alias-state-error-primary, #e06c6c); padding: 10px; font-size: 12px; }
.gf-toggle {
  background: none;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4));
  color: var(--dsw-alias-label-secondary, #aaa);
  cursor: pointer;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 8px;
}
.gf-toggle:hover { background: rgba(128,128,128,.14); }
.gf-toggle-active { color: var(--dsw-alias-brand-primary, #4a90d9); border-color: var(--dsw-alias-brand-primary, #4a90d9); }
`;
  const tagId = "@roarpeng/graphflow/dsh/gf-panel";
  if (
    typeof document !== "undefined" &&
    document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null
  ) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@roarpeng/graphflow/dsh";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── package-private 面板状态（factory 只物化一次，状态随页面存活） ──
  const panel = { open: false, sessionId: undefined, listeners: new Set() };
  const subscribe = (fn) => {
    panel.listeners.add(fn);
    return () => {
      panel.listeners.delete(fn);
    };
  };
  const setOpen = (open, sessionId) => {
    panel.open = open;
    if (sessionId !== undefined) panel.sessionId = sessionId;
    for (const fn of Array.from(panel.listeners)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };

  /** Cordis 客户端服务声明（模块级，fiber 等待这些服务出现后才 apply）。 */
  const inject = ["sessions", "slots", "connection"];

  /** apply 时的 ctx，供组件按需取服务（Connection 取数 / sessions 续聊）。 */
  let pluginCtx = null;

  function apply(ctx) {
    pluginCtx = ctx;
    const slots = ctx.get("slots");
    if (slots === undefined) return;

    // 会话头部开关（session 作用域 list slot）
    slots.inject("conversation.session.header.utilities", () =>
      slots.register(
        { name: "conversation.session.header.utilities", id: "gf-knowledge-toggle", order: 90, label: () => "知识节点" },
        (props) => React.createElement(ToggleButton, { ...props, panel, setOpen, subscribe })
      )
    );

    // 右侧面板（root 作用域 list slot，additive）
    slots.inject("shell.overlay", () =>
      slots.register(
        { name: "shell.overlay", id: "gf-knowledge", order: 10, label: () => "知识节点" },
        (props) =>
          React.createElement(KnowledgePanel, {
            ...props,
            panel,
            setOpen,
            subscribe,
            sessionsOf: () => ctx.get("sessions"),
          })
      )
    );
  }

  // ── 取数：Connection 通用 RPC 通道（规格书 §3.2 路 A） ──
  // 宿主端点: ctx.connection.rpc.handle("/gf", handler, { authority: "trusted-host" })
  // 返回信封: { ok: true, value: { workbench, dialogues } } | { ok: false, error: { code, message, details } }
  function fetchNodes(ctx, cwd) {
    const connection = ctx && typeof ctx.get === "function" ? ctx.get("connection") : undefined;
    if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
      return Promise.resolve({ ok: false, error: "no-connection" });
    }
    return connection.rpc.call("/gf", "nodes", { workspaceRoot: cwd }).catch((err) => ({
      ok: false,
      error: String(err && err.message ? err.message : err),
    }));
  }

  // ── 共享 helpers ──

  function buildResumeInstruction(kind, id, cwd, title) {
    const arg = kind === "topic" ? `topicId: "${id}"` : `resumeFromTurnId: "${id}"`;
    return (
      `继续对话：请先调用 mcp__graphflow__graphflow_context({ rootDir: "${cwd}", ${arg} })` +
      `，读取该知识节点记录的历史问答与上下文，然后基于它继续当前任务。` +
      `节点: ${title || id}`
    );
  }

  function clip(text, max) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1)}…`;
  }

  // ── components ──

  function ToggleButton(props) {
    const { panel, setOpen, subscribe, sessionId } = props;
    const [open, setLocal] = React.useState(panel.open);
    React.useEffect(() => subscribe(() => setLocal(panel.open)), []);
    return React.createElement(
      "button",
      {
        type: "button",
        "aria-label": "知识节点",
        title: "知识节点",
        onClick: () => setOpen(!panel.open, sessionId),
        className: "gf-toggle" + (open ? " gf-toggle-active" : ""),
      },
      "知识节点"
    );
  }

  function KnowledgePanel(props) {
    const { panel, setOpen, subscribe, useSessions, sessionsOf } = props;
    const [open, setLocal] = React.useState(panel.open);
    React.useEffect(() => subscribe(() => setLocal(panel.open)), []);
    const currentId = useSessions((s) => s.current);
    const cwd = useSessions((s) => (s.current ? s.byId[s.current]?.cwd : undefined));
    const [data, setData] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [tick, setTick] = React.useState(0);

    const refresh = React.useCallback(() => {
      if (!cwd) return;
      setLoading(true);
      fetchNodes(pluginCtx, cwd)
        .then((res) => {
          setData(res);
          setError(null);
        })
        .catch((err) => setError(String(err && err.message ? err.message : err)))
        .finally(() => setLoading(false));
    }, [cwd]);

    React.useEffect(() => {
      if (open && cwd) refresh();
    }, [open, cwd, tick]);

    if (!open) return null;

    const resume = (kind, id, title) => {
      const sessions = sessionsOf && typeof sessionsOf === "function" ? sessionsOf() : undefined;
      const binding = sessions && currentId ? sessions.binding(currentId) : undefined;
      if (!binding || !binding.session || !cwd) return;
      const text = buildResumeInstruction(kind, id, cwd, title);
      binding.session.prompt([{ type: "text", text }], "queue").catch(() => {});
    };

    const header = React.createElement(
      "div",
      { className: "gf-panel-header" },
      React.createElement("div", { className: "gf-panel-title" }, "知识节点"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "gf-panel-btn",
          "aria-label": "刷新",
          title: "刷新",
          onClick: () => setTick((v) => v + 1),
        },
        "刷新"
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "gf-panel-btn",
          "aria-label": "关闭",
          title: "关闭",
          onClick: () => setOpen(false, undefined),
        },
        "✕"
      )
    );

    let body;
    if (loading && !data) {
      body = React.createElement("div", { className: "gf-empty" }, "加载中…");
    } else if (error) {
      body = React.createElement("div", { className: "gf-error" }, `加载失败: ${error}`);
    } else if (!data || data.ok !== true) {
      const envelopeError =
        data && data.error
          ? typeof data.error === "string"
            ? data.error
            : data.error.message || data.error.code || null
          : null;
      body = envelopeError
        ? React.createElement("div", { className: "gf-error" }, `加载失败: ${envelopeError}`)
        : React.createElement("div", { className: "gf-empty" }, "暂无数据（需要安装 GraphFlow MCP 插件并建立知识图谱）");
    } else {
      // data 是 RpcResult 信封：data.ok === true 时数据在 data.value
      const value = data.value || {};
      const wbData = value.workbench;
      const outlines = Array.isArray(wbData) ? wbData : wbData && Array.isArray(wbData.outlines) ? wbData.outlines : [];
      const dialogues = Array.isArray(value.dialogues) ? value.dialogues : [];
      const sections = [];
      if (outlines.length === 0 && dialogues.length === 0) {
        sections.push(
          React.createElement(
            "div",
            { className: "gf-empty" },
            "暂无知识节点 — 使用 graphflow_plan / graphflow_context 后，这里会出现主题与对话记录"
          )
        );
      }
      for (const outline of outlines) {
        const children = [
          React.createElement("div", { className: "gf-section-title" }, `Workbench · ${clip(outline.task, 60)}`),
        ];
        for (const node of outline.nodes || []) {
          children.push(renderTopicNode(node, resume));
        }
        sections.push(React.createElement("div", { key: outline.rootId }, children));
      }
      if (dialogues.length > 0) {
        const children = [React.createElement("div", { className: "gf-section-title" }, "对话记录")];
        for (const turn of dialogues) {
          children.push(
            React.createElement(
              "button",
              {
                key: turn.id,
                type: "button",
                className: "gf-node",
                onClick: () => resume("turn", turn.id, `#${turn.seq} ${turn.userQuery}`),
              },
              React.createElement(
                "div",
                { className: "gf-node-title" },
                React.createElement("span", { className: "gf-badge" }, `#${turn.seq}`),
                React.createElement(
                  "span",
                  { className: "gf-node-label" },
                  clip(turn.title || turn.userQuery, 40)
                ),
                turn.jumped ? React.createElement("span", { className: "gf-badge gf-badge-jump" }, "跳转") : null
              ),
              React.createElement(
                "div",
                { className: "gf-node-preview" },
                turn.summary && turn.summary.trim()
                  ? `A: ${clip(turn.summary, 60)}`
                  : turn.assistantReply && turn.assistantReply.trim()
                    ? `A: ${clip(turn.assistantReply, 60)}`
                    : "A: (待回复)"
              )
            )
          );
        }
        sections.push(React.createElement("div", { key: "dialogues" }, children));
      }
      body = React.createElement("div", { className: "gf-panel-body" }, sections);
    }

    return React.createElement("div", { className: "gf-panel" }, header, body);
  }

  function renderTopicNode(node, resume) {
    const badges = [];
    if (node.active) badges.push(React.createElement("span", { key: "a", className: "gf-badge gf-badge-active" }, "当前"));
    if (node.kind === "side") badges.push(React.createElement("span", { key: "s", className: "gf-badge" }, "旁支"));
    if (node.pendingReply) badges.push(React.createElement("span", { key: "p", className: "gf-badge gf-badge-pending" }, "待回复"));
    if (node.messageCount > 0) {
      badges.push(React.createElement("span", { key: "m", className: "gf-badge" }, `${node.messageCount} 条`));
    }
    const children = [];
    for (const child of node.children || []) {
      children.push(renderTopicNode(child, resume));
    }
    return React.createElement(
      "div",
      { key: node.id },
      React.createElement(
        "button",
        {
          type: "button",
          className: "gf-node",
          onClick: () => resume("topic", node.id, node.title),
        },
        React.createElement("div", { className: "gf-node-title" }, React.createElement("span", { className: "gf-node-label" }, node.title), badges),
        node.lastUserPreview
          ? React.createElement("div", { className: "gf-node-preview" }, clip(node.lastUserPreview, 70))
          : null
      ),
      children
    );
  }

  exports.apply = apply;
  exports.inject = inject;
  return module.exports;
};

window.__ModuleLoader__.load({ id: "@roarpeng/graphflow/dsh", factory });
