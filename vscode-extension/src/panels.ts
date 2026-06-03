export interface GraphSnapshotResult {
  transport: "memory" | "mcp-http" | "file" | "sqlite";
  storePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<"File" | "Symbol" | "Module" | "TaskRun" | "Decision" | "Skill", number>;
  topRelations: Array<{ relation: string; count: number }>;
  sampleNodes: Array<{ id: string; type: string; contentPreview: string }>;
  sampleEdges: Array<{ from: string; relation: string; to: string }>;
}

export interface SkillInsightsResult {
  source: "graph-store" | "unavailable";
  transport: "memory" | "mcp-http" | "file" | "sqlite";
  storePath?: string;
  skills: Array<{
    id: string;
    name: string;
    score: number;
    uses: number;
    lastOutcome: "pass" | "fail";
    updatedAt: number;
  }>;
}

export interface ContextPreviewResult {
  query: string;
  summaryCount: number;
  anchorCount: number;
  tokenEstimate: number;
  truncated: boolean;
  anchorsByLayer: { l1: number; l2: number; l3: number };
  refillPreview: string[];
  summary: string[];
  anchors: Array<{ id: string; type: string; layer: string }>;
  tokenBudget: {
    maxContextTokens: number;
    estimatedRawTokens: number;
    compressedTokens: number;
    estimatedSavingsPercent: number;
    budgetUsedPercent: number;
  };
}

export interface GraphFlowSettings {
  configPath: string;
  provider: string;
  smartModel: string;
  economyModel: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  maxContextTokens: number;
  layerQuota: { l1: number; l2: number; l3: number };
  enableNearLosslessMode: boolean;
  autoIndexOnPreview: boolean;
  autoIndexOnRun: boolean;
  transport: "memory" | "mcp-http" | "file" | "sqlite";
  graphStorePath: string;
}

export function buildGraphSnapshotHtml(snapshot: GraphSnapshotResult, scriptUri: string): string {
  const typeOptions = Object.entries(snapshot.nodeTypeCount)
    .map(([type, count]) => `<option value="${escapeHtml(type)}">${escapeHtml(type)} (${count})</option>`)
    .join("");
  const nodeOptions = snapshot.sampleNodes
    .map(
      (node) =>
        `<option value="${escapeHtml(node.id)}">${escapeHtml(node.id)} [${escapeHtml(node.type)}]</option>`
    )
    .join("");
  const relationPills = snapshot.topRelations
    .map((item) => `<span class="pill">${escapeHtml(item.relation)}: ${item.count}</span>`)
    .join("");
  const serverNodeCards = renderServerNodeCardsHtml(snapshot.sampleNodes);
  const serverSvgMarkup = renderServerSnapshotSvg(snapshot.sampleNodes, snapshot.sampleEdges);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Graph Snapshot</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --panel: #fffaf2;
      --ink: #213547;
      --muted: #6d7f88;
      --line: #d8c9b7;
      --accent: #116466;
      --accent-soft: #d9efe8;
      --accent-2: #d97d54;
      --shadow: 0 14px 34px rgba(33, 53, 71, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(217, 125, 84, 0.18), transparent 22%),
        radial-gradient(circle at top left, rgba(17, 100, 102, 0.15), transparent 28%),
        var(--bg);
    }
    .shell { padding: 16px; display: grid; gap: 14px; }
    .hero {
      background: linear-gradient(135deg, rgba(255, 250, 242, 0.96), rgba(244, 239, 230, 0.92));
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .hero-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    .metric { padding: 12px; }
    .metric .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .metric .value { margin-top: 6px; font-size: 18px; font-weight: 700; }
    .toolbar {
      display: grid;
      grid-template-columns: 1.3fr 1fr 1fr auto;
      gap: 10px;
      align-items: end;
    }
    .field { display: grid; gap: 6px; }
    .field label { font-size: 12px; color: var(--muted); }
    input, select, button {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      font: inherit;
      background: #fff;
      color: var(--ink);
    }
    button {
      width: auto;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      border: none;
      padding-inline: 18px;
    }
    .layout { display: grid; grid-template-columns: 280px minmax(0, 1fr) 320px; gap: 12px; }
    .panel { overflow: hidden; }
    .panel h2 { margin: 0; font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
    .panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .panel-body { padding: 12px 14px; }
    .node-list { display: grid; gap: 8px; max-height: 540px; overflow: auto; }
    .node-item {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 12px;
      padding: 10px;
      cursor: pointer;
    }
    .node-item.active { border-color: var(--accent); background: var(--accent-soft); }
    .node-meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .node-title { font-size: 13px; font-weight: 600; word-break: break-all; }
    .node-preview { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .canvas-wrap { padding: 12px; }
    svg { width: 100%; height: 560px; display: block; background: linear-gradient(180deg, #fff, #f8f4ed); }
    .detail-grid { display: grid; gap: 10px; }
    .detail-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: #fff; }
    .detail-card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; }
    .pill-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill { background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .empty { color: var(--muted); font-size: 13px; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .toolbar, .hero-grid { grid-template-columns: 1fr; }
      svg { height: 420px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-grid">
        <div class="metric"><div class="label">Transport</div><div class="value">${escapeHtml(snapshot.transport)}</div></div>
        <div class="metric"><div class="label">Nodes / Edges</div><div class="value">${snapshot.nodeCount} / ${snapshot.edgeCount}</div></div>
        <div class="metric"><div class="label">Store</div><div class="value">${escapeHtml(snapshot.storePath ?? "n/a")}</div></div>
      </div>
    </section>
    <section class="panel panel-body">
      <div class="toolbar">
        <div class="field">
          <label for="graph-search">Search nodes</label>
          <input id="graph-search" type="search" placeholder="Find by id, type, preview" />
        </div>
        <div class="field">
          <label for="graph-type-filter">Filter by type</label>
          <select id="graph-type-filter"><option value="all">All types</option>${typeOptions}</select>
        </div>
        <div class="field">
          <label for="graph-node-list">Focus node</label>
          <select id="graph-node-list"><option value="">Auto focus</option>${nodeOptions}</select>
        </div>
        <button id="graph-reset" type="button">Reset</button>
      </div>
    </section>
    <div class="layout">
      <section class="panel">
        <div class="panel-head"><h2>Node Explorer</h2></div>
        <div class="panel-body"><div id="graph-node-cards" class="node-list">${serverNodeCards}</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Graph Canvas</h2></div>
        <div class="canvas-wrap"><svg id="graph-canvas" data-role="graph-canvas" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet">${serverSvgMarkup}</svg></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Graph Detail</h2></div>
        <div class="panel-body detail-grid" id="graph-detail">
          <div class="detail-card"><strong>Top relations</strong><div class="pill-row">${relationPills || '<span class="empty">No relation data</span>'}</div></div>
          <div class="detail-card"><strong>Selection</strong><pre id="graph-selection">Select a node to inspect its neighbors.</pre></div>
          <div class="detail-card"><strong>Active filter</strong><pre id="graph-filter-state">type=all\nsearch=(none)</pre></div>
        </div>
      </section>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

export function buildSkillInsightsHtml(insights: SkillInsightsResult, scriptUri: string): string {
  const serverTableRows = renderServerSkillTableRows(insights.skills);
  const serverSummary = renderServerSkillSummary(insights.skills);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Skill Insights</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f1eb;
      --panel: #fffdf8;
      --ink: #1f2937;
      --muted: #6b7280;
      --line: #decdbb;
      --accent: #0f766e;
      --accent-soft: #d8f1ee;
      --warn: #b45309;
      --danger: #b91c1c;
      --shadow: 0 14px 34px rgba(31, 41, 55, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(15, 118, 110, 0.12), transparent 24%),
        radial-gradient(circle at top left, rgba(180, 83, 9, 0.12), transparent 30%),
        var(--bg);
      padding: 16px;
    }
    .shell { display: grid; gap: 14px; }
    .meta, .toolbar, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    .meta, .toolbar { padding: 12px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip { background: var(--accent-soft); color: var(--accent); padding: 4px 10px; border-radius: 999px; font-size: 12px; }
    .toolbar { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 10px; }
    .field { display: grid; gap: 6px; }
    .field label { font-size: 12px; color: var(--muted); }
    input, select {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      font: inherit;
      background: #fff;
      color: var(--ink);
    }
    .panel { overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 10px; border-bottom: 1px solid #ece2d7; text-align: left; font-size: 13px; }
    th { background: #f9f3eb; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    tbody tr:hover { background: #fcf7ef; }
    .score-pass { color: var(--accent); font-weight: 700; }
    .score-fail { color: var(--danger); font-weight: 700; }
    .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .summary-card { padding: 12px; border: 1px solid var(--line); border-radius: 14px; background: #fff; }
    .summary-card .label { color: var(--muted); font-size: 12px; }
    .summary-card .value { margin-top: 6px; font-size: 18px; font-weight: 700; }
    .empty { padding: 18px; color: var(--muted); }
    @media (max-width: 900px) {
      .toolbar, .summary { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="meta">
      <div class="chips">
        <span class="chip">source: ${escapeHtml(insights.source)}</span>
        <span class="chip">transport: ${escapeHtml(insights.transport)}</span>
        <span class="chip">skills: ${insights.skills.length}</span>
        ${insights.storePath ? `<span class="chip">store: ${escapeHtml(insights.storePath)}</span>` : ""}
      </div>
    </section>
    <section class="toolbar">
      <div class="field">
        <label for="skill-search">Search skills</label>
        <input id="skill-search" type="search" placeholder="Find by name or id" />
      </div>
      <div class="field">
        <label for="skill-outcome-filter">Outcome filter</label>
        <select id="skill-outcome-filter">
          <option value="all">All outcomes</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
        </select>
      </div>
      <div class="field">
        <label for="skill-sort">Sort by</label>
        <select id="skill-sort">
          <option value="score">Score</option>
          <option value="uses">Uses</option>
          <option value="updatedAt">Updated time</option>
          <option value="name">Name</option>
        </select>
      </div>
    </section>
    <section class="summary" id="skill-summary">${serverSummary}</section>
    <section class="panel">
      <table data-role="skill-table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Score</th>
            <th>Uses</th>
            <th>Last Outcome</th>
            <th>Updated At</th>
          </tr>
        </thead>
        <tbody id="skill-table-body">${serverTableRows}</tbody>
      </table>
    </section>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

export function buildContextPreviewHtml(preview: ContextPreviewResult, scriptUri: string): string {
  const budget = preview.tokenBudget;
  const summaryItems = preview.summary
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const anchorRows = preview.anchors
    .map(
      (anchor) =>
        `<tr><td>${escapeHtml(anchor.layer)}</td><td>${escapeHtml(anchor.type)}</td><td>${escapeHtml(anchor.id)}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Context Preview</title>
  <style>
    body { margin: 0; padding: 16px; font-family: "Segoe UI", sans-serif; color: #1f2937; background: #f6f1eb; }
    .shell { display: grid; gap: 14px; }
    .panel { background: #fffdf8; border: 1px solid #decdbb; border-radius: 16px; padding: 14px; box-shadow: 0 14px 34px rgba(31,41,55,.08); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid #eadccc; border-radius: 12px; padding: 10px; background: #fff; }
    .label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .value { margin-top: 6px; font-size: 20px; font-weight: 700; color: #0f766e; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 8px; border-bottom: 1px solid #ece2d7; text-align: left; font-size: 13px; }
    code { background: #f3eadf; padding: 2px 5px; border-radius: 6px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel">
      <div class="label">Query</div>
      <h1>${escapeHtml(preview.query)}</h1>
    </section>
    <section class="panel">
      <h2>Token Budget</h2>
      <div class="grid">
        <div class="metric"><div class="label">Estimated Raw</div><div class="value">${budget.estimatedRawTokens}</div></div>
        <div class="metric"><div class="label">Compressed</div><div class="value">${budget.compressedTokens}</div></div>
        <div class="metric"><div class="label">Savings</div><div class="value">${budget.estimatedSavingsPercent}%</div></div>
        <div class="metric"><div class="label">Budget Used</div><div class="value">${budget.budgetUsedPercent}%</div></div>
      </div>
    </section>
    <section class="panel">
      <h2>Context Summary</h2>
      <p>summary=${preview.summaryCount}; anchors=${preview.anchorCount}; tokens=${preview.tokenEstimate}; truncated=${preview.truncated}</p>
      <p>L1=${preview.anchorsByLayer.l1}; L2=${preview.anchorsByLayer.l2}; L3=${preview.anchorsByLayer.l3}; max=<code>${budget.maxContextTokens}</code></p>
      <ul>${summaryItems || "<li>No matching context yet.</li>"}</ul>
    </section>
    <section class="panel">
      <h2>Anchors</h2>
      <table><thead><tr><th>Layer</th><th>Type</th><th>ID</th></tr></thead><tbody>${anchorRows || '<tr><td colspan="3">No anchors</td></tr>'}</tbody></table>
    </section>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

export function buildSettingsHtml(settings: GraphFlowSettings, scriptUri: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Settings</title>
  <style>
    body { margin: 0; padding: 16px; font-family: "Segoe UI", sans-serif; color: #1f2937; background: #f4efe6; }
    form { display: grid; gap: 12px; max-width: 980px; }
    .panel { background: #fffaf2; border: 1px solid #d8c9b7; border-radius: 16px; padding: 14px; box-shadow: 0 14px 34px rgba(33,53,71,.08); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; font-size: 12px; color: #6d7f88; }
    input, select { border: 1px solid #d8c9b7; border-radius: 12px; padding: 10px 12px; font: inherit; color: #213547; background: #fff; }
    .checks { display: flex; gap: 16px; flex-wrap: wrap; }
    .checks label { display: flex; flex-direction: row; align-items: center; gap: 8px; }
    button { width: fit-content; border: 0; border-radius: 12px; padding: 10px 18px; background: #116466; color: #fff; cursor: pointer; }
    code { background: #f1e6d9; padding: 2px 6px; border-radius: 6px; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <form id="settings-form">
    <section class="panel">
      <h1>GraphFlow Settings</h1>
      <p>Saved to <code>${escapeHtml(settings.configPath)}</code>. API keys are stored as environment variable placeholders.</p>
    </section>
    <section class="panel grid">
      <label>Provider
        <select id="settings-provider" name="provider">
          ${renderProviderOption("openai", settings.provider)}
          ${renderProviderOption("anthropic", settings.provider)}
          ${renderProviderOption("bailian", settings.provider)}
          ${renderProviderOption("doubao", settings.provider)}
        </select>
      </label>
      <label>API Key Env Var <input id="settings-api-key-env-var" name="apiKeyEnvVar" value="${escapeHtml(settings.apiKeyEnvVar ?? "")}" placeholder="OPENAI_API_KEY" /></label>
      <label>Smart Model <input id="settings-smart-model" name="smartModel" value="${escapeHtml(settings.smartModel)}" /></label>
      <label>Economy Model <input id="settings-economy-model" name="economyModel" value="${escapeHtml(settings.economyModel)}" /></label>
      <label>Base URL <input id="settings-base-url" name="baseUrl" value="${escapeHtml(settings.baseUrl ?? "")}" placeholder="https://api.openai.com/v1" /></label>
      <label>Transport
        <select id="settings-transport" name="transport">
          ${renderTransportOption("file", settings.transport)}
          ${renderTransportOption("sqlite", settings.transport)}
          ${renderTransportOption("memory", settings.transport)}
          ${renderTransportOption("mcp-http", settings.transport)}
        </select>
      </label>
    </section>
    <section class="panel grid">
      <label>Max Context Tokens <input id="settings-max-context-tokens" name="maxContextTokens" type="number" min="1" value="${settings.maxContextTokens}" /></label>
      <label>Graph Store Path <input id="settings-graph-store-path" name="graphStorePath" value="${escapeHtml(settings.graphStorePath)}" /></label>
      <label>L1 Anchors <input id="settings-layer-l1" name="l1" type="number" min="0" value="${settings.layerQuota.l1}" /></label>
      <label>L2 Anchors <input id="settings-layer-l2" name="l2" type="number" min="0" value="${settings.layerQuota.l2}" /></label>
      <label>L3 Anchors <input id="settings-layer-l3" name="l3" type="number" min="0" value="${settings.layerQuota.l3}" /></label>
    </section>
    <section class="panel checks">
      <label><input id="settings-enable-near-lossless" name="enableNearLosslessMode" type="checkbox" ${settings.enableNearLosslessMode ? "checked" : ""} /> Enable near-lossless context</label>
      <label><input id="settings-auto-index-preview" name="autoIndexOnPreview" type="checkbox" ${settings.autoIndexOnPreview ? "checked" : ""} /> Auto index on preview</label>
      <label><input id="settings-auto-index-run" name="autoIndexOnRun" type="checkbox" ${settings.autoIndexOnRun ? "checked" : ""} /> Auto index on run</label>
    </section>
    <button id="settings-save" type="submit">Save Settings</button>
    <p id="settings-status"></p>
  </form>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

const SNAPSHOT_NODE_COLORS: Record<string, string> = {
  File: "#1d4ed8",
  Symbol: "#9333ea",
  Module: "#c2410c",
  TaskRun: "#0f766e",
  Decision: "#b91c1c",
  Skill: "#0f766e",
};

function layoutSnapshotPositions(
  nodes: GraphSnapshotResult["sampleNodes"],
  edges: GraphSnapshotResult["sampleEdges"],
  selectedId?: string
): Map<string, { x: number; y: number }> {
  const width = 1000;
  const height = 560;
  const centerX = width / 2;
  const centerY = height / 2;
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();

  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / nodes.length;
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * 100,
      y: centerY + Math.sin(angle) * 100,
      vx: 0,
      vy: 0,
    });
  });

  const iterations = 150;
  const k = 40;
  const repulsion = 4000;

  for (let i = 0; i < iterations; i++) {
    const temp = 1.0 - i / iterations;

    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const p1 = positions.get(nodes[a].id)!;
        const p2 = positions.get(nodes[b].id)!;
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;

        const force = (repulsion / (dist * dist)) * temp;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        p1.vx += fx; p1.vy += fy;
        p2.vx -= fx; p2.vy -= fy;
      }
    }

    for (const edge of edges) {
      const p1 = positions.get(edge.from);
      const p2 = positions.get(edge.to);
      if (!p1 || !p2) continue;

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const force = ((dist * dist) / (k * k)) * 0.1 * temp;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      p1.vx += fx; p1.vy += fy;
      p2.vx -= fx; p2.vy -= fy;
    }

    for (const node of nodes) {
      const p = positions.get(node.id)!;
      const dx = centerX - p.x;
      const dy = centerY - p.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const gravityForce = 0.05 * temp;
      p.vx += dx * gravityForce;
      p.vy += dy * gravityForce;

      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.5;
      p.vy *= 0.5;
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const scale = Math.min((width - 150) / contentWidth, (height - 100) / contentHeight);

  const result = new Map<string, { x: number; y: number }>();
  for (const [id, p] of positions.entries()) {
    result.set(id, {
      x: centerX + (p.x - centerX) * scale,
      y: centerY + (p.y - centerY) * scale,
    });
  }

  return result;
}

function renderServerSnapshotSvg(
  nodes: GraphSnapshotResult["sampleNodes"],
  edges: GraphSnapshotResult["sampleEdges"]
): string {
  if (nodes.length === 0) {
    return "";
  }

  const positions = layoutSnapshotPositions(nodes, edges);
  const lines: string[] = [];
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) {
      continue;
    }
    lines.push(
      `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#cbbba7" stroke-width="1.2" opacity="0.75" />`
    );
  }

  const shapes: string[] = [];
  nodes.forEach((node, index) => {
    const pos = positions.get(node.id);
    if (!pos) {
      return;
    }
    const isActive = index === 0;
    const fill = SNAPSHOT_NODE_COLORS[node.type] ?? "#64748b";
    const label = node.id.length > 30 ? `${node.id.slice(0, 29)}...` : node.id;
    shapes.push(
      `<circle cx="${pos.x}" cy="${pos.y}" r="${isActive ? 11 : 8}" fill="${fill}" stroke="${isActive ? "#d97d54" : "#fff"}" stroke-width="${isActive ? 3 : 1.5}" />`,
      `<text x="${pos.x + 12}" y="${pos.y + 4}" font-size="${isActive ? 12 : 11}" fill="#334155">${escapeHtml(label)}</text>`
    );
  });

  return `${lines.join("")}${shapes.join("")}`;
}

function renderServerNodeCardsHtml(nodes: GraphSnapshotResult["sampleNodes"]): string {
  if (nodes.length === 0) {
    return '<div class="empty">No sample nodes loaded yet. Reload the panel after indexing.</div>';
  }

  return nodes
    .map(
      (node, index) =>
        `<button type="button" class="node-item${index === 0 ? " active" : ""}" data-node-id="${escapeHtml(node.id)}">` +
        `<div class="node-meta">${escapeHtml(node.type)}</div>` +
        `<div class="node-title">${escapeHtml(node.id)}</div>` +
        `<div class="node-preview">${escapeHtml(node.contentPreview || "(empty)")}</div>` +
        `</button>`
    )
    .join("");
}

function renderServerSkillSummary(skills: SkillInsightsResult["skills"]): string {
  const passCount = skills.filter((skill) => skill.lastOutcome === "pass").length;
  const failCount = skills.filter((skill) => skill.lastOutcome === "fail").length;
  const avgScore = skills.length
    ? (skills.reduce((sum, item) => sum + item.score, 0) / skills.length).toFixed(2)
    : "0.00";

  return [
    ["Visible skills", String(skills.length)],
    ["Pass / Fail", `${passCount} / ${failCount}`],
    ["Average score", avgScore],
  ]
    .map(
      ([label, value]) =>
        `<div class="summary-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`
    )
    .join("");
}

function renderServerSkillTableRows(skills: SkillInsightsResult["skills"]): string {
  if (skills.length === 0) {
    return '<tr><td colspan="5" class="empty">No skills in graph store yet.</td></tr>';
  }

  return skills
    .map((skill) => {
      const scoreClass = skill.score >= 0 ? "score-pass" : "score-fail";
      const updatedAt = skill.updatedAt ? new Date(skill.updatedAt).toLocaleString() : "n/a";
      return (
        `<tr>` +
        `<td><strong>${escapeHtml(skill.name)}</strong><br/><span style="color:#6b7280">${escapeHtml(skill.id)}</span></td>` +
        `<td class="${scoreClass}">${skill.score}</td>` +
        `<td>${skill.uses}</td>` +
        `<td>${escapeHtml(skill.lastOutcome)}</td>` +
        `<td>${escapeHtml(updatedAt)}</td>` +
        `</tr>`
      );
    })
    .join("");
}

function renderProviderOption(provider: string, selected: string): string {
  return `<option value="${escapeHtml(provider)}"${provider === selected ? " selected" : ""}>${escapeHtml(provider)}</option>`;
}

function renderTransportOption(transport: GraphFlowSettings["transport"], selected: string): string {
  return `<option value="${escapeHtml(transport)}"${transport === selected ? " selected" : ""}>${escapeHtml(transport)}</option>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}