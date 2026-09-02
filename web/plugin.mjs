/**
 * GraphFlow — DeepSeek Harness web knowledge-node panel (reference source).
 *
 * This file is the SOURCE SEED of the dynamic Cordis plugin that renders the
 * right-side "知识节点" (knowledge nodes) panel in the DeepSeek Harness web
 * UI. It ships in the package (exports["./web"]) as documentation and as the
 * future bundle seed: once the dsh client-modules build pipeline can compile
 * a `dsh.client` package (rolldown factory bundle served at
 * `/plugins/<id>/client.js`), the two halves below become `code.host` and
 * `code.client` of a static client package with a `dsh.client` declaration.
 *
 * Until then it is activated per harness session as a dynamic Cordis plugin:
 *   - host half: harness.handle("gf.nodes.list") → runs the graphflow CLI
 *     (workbench tree + dialogue list) in the session workspace via the host
 *     `shell` service and returns structured JSON.
 *   - client half: registers
 *       * a "知识节点" toggle in `conversation.session.header.utilities`
 *         (opens the panel and remembers the session),
 *       * the panel itself in `shell.overlay` (frame-wide, right-anchored,
 *         additive — the shipped details column stays untouched), rendering
 *         workbench topics (mainline/side) + dialogue turns, and
 *       * click-to-resume: submits a continuation instruction through the
 *         session binding's `prompt('queue')` channel (the same pipe the
 *         composer uses), so the agent restores context via
 *         graphflow_context({ topicId | resumeFromTurnId }) and continues.
 *
 * Plain JavaScript only: no TS/JSX/import. React arrives as a closure symbol.
 */

/** Host half — the body of `code.host` (returns a Cordis Plugin). */
export function hostHalf() {
  return {
    name: "graphflow-web",
    apply(ctx) {
      const shell = ctx.get("shell");
      if (shell === undefined) return;

      const runCli = async (command, workspaceRoot) => {
        const spec = shell.resolve({
          command,
          workdir: workspaceRoot,
          timeoutMs: 20000,
          stdoutMaxBytes: 4_000_000,
        });
        return shell.run(spec);
      };

      const parseCliOut = (result) => {
        if (!result || result.exitCode !== 0) return null;
        const stdout = typeof result.stdout === "string" ? result.stdout : "";
        if (!stdout.trim()) return null;
        try {
          const parsed = JSON.parse(stdout);
          return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
        } catch {
          return null;
        }
      };

      harness.handle("gf.nodes.list", async (args) => {
        const workspaceRoot =
          args && typeof args.workspaceRoot === "string" && args.workspaceRoot.trim()
            ? args.workspaceRoot
            : null;
        if (!workspaceRoot) return { ok: false, error: "no-workspace" };
        try {
          const wb = await runCli("graphflow workbench tree --json", workspaceRoot);
          const dl = await runCli("graphflow dialogue list --json --limit 50", workspaceRoot);
          const tr = await runCli("graphflow dialogue traces --json --limit 50", workspaceRoot);
          return {
            ok: true,
            workbench: parseCliOut(wb),
            dialogues: parseCliOut(dl),
            traces: parseCliOut(tr),
          };
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) };
        }
      });
    },
  };
}

/** Client half — the body of `code.client` (returns a Cordis Plugin). */
export function clientHalf() {
  return {
    name: "graphflow-web",
    apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      // ── package-private panel state (in-memory, per plugin activation) ──
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

      // ── header utility toggle ──
      slots.inject("conversation.session.header.utilities", () =>
        slots.register(
          { name: "conversation.session.header.utilities", id: "gf-knowledge-toggle", order: 90, label: () => "知识节点" },
          (props) => React.createElement(ToggleButton, { ...props, panel, setOpen, subscribe })
        )
      );

      // ── right-side knowledge panel (frame-wide overlay, additive) ──
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
    },
  };
}

// ─────────────────────────── shared helpers ───────────────────────────

function buildResumeInstruction(kind, id, cwd, title) {
  const arg = kind === "topic" ? `topicId: "${id}"` : `resumeFromTurnId: "${id}"`;
  return (
    `继续对话：请先调用 mcp__graphflow__graphflow_context({ rootDir: "${cwd}", ${arg} })` +
    `，读取该知识节点记录的历史问答与上下文，然后基于它继续当前任务。` +
    `节点: ${title || id}`
  );
}

// ─────────────────────────── components ───────────────────────────

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
    host
      .call("gf.nodes.list", { workspaceRoot: cwd })
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
    const sessions = sessionsOf();
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
  } else if (!data || (data.ok !== true)) {
    body = React.createElement(
      "div",
      { className: "gf-empty" },
      "暂无数据（需要安装 GraphFlow MCP 插件并建立知识图谱）"
    );
  } else {
    const wbData = data.workbench;
    const outlines = Array.isArray(wbData)
      ? wbData
      : wbData && Array.isArray(wbData.outlines)
        ? wbData.outlines
        : [];
    const dialogues = Array.isArray(data.dialogues) ? data.dialogues : [];
    const traces = Array.isArray(data.traces) ? data.traces : [];
    const sections = [];
    if (outlines.length === 0 && dialogues.length === 0 && traces.length === 0) {
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
        const badges = [];
        if (turn.jumped) badges.push(React.createElement("span", { key: "j", className: "gf-badge gf-badge-jump" }, "跳转"));
        if (turn.supersedesTurnIds && turn.supersedesTurnIds.length > 0) {
          badges.push(React.createElement("span", { key: "s", className: "gf-badge gf-badge-supersede" }, "修正过结论"));
        }
        if (turn.forkBoundary) {
          badges.push(React.createElement("span", { key: "f", className: "gf-badge" }, "fork"));
        }
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
              badges
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
    if (traces.length > 0) {
      const children = [React.createElement("div", { className: "gf-section-title" }, "Agent 轨迹")];
      for (const trace of traces.slice(0, 20)) {
        children.push(
          React.createElement(
            "div",
            { key: trace.id, className: "gf-trace" },
            React.createElement(
              "span",
              { className: "gf-badge" + (trace.status === "failed" ? " gf-badge-jump" : "") },
              trace.status === "failed" ? "失败" : trace.status === "start" ? "启动" : "完成"
            ),
            React.createElement(
              "span",
              { className: "gf-node-preview" },
              `T#${trace.turnSeq} ${clip(trace.label, 48)} · ${new Date(trace.createdAt).toLocaleTimeString()}`
            )
          )
        );
      }
      sections.push(React.createElement("div", { key: "traces" }, children));
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

function clip(text, max) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

// ─────────────────────────── styles ───────────────────────────

export const PANEL_CSS = `
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
.gf-badge-supersede { background: var(--dsw-alias-state-ok-primary, #4caf7d); color: #000; }
.gf-trace {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  margin: 2px 0;
  border-radius: 8px;
  background: rgba(128,128,128,.08);
}
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
