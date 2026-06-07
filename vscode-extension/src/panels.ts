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
  openbmbMode: "embedded" | "ollama" | "openai-compat";
  openbmbEngine: "command" | "node-llama-cpp";
  openbmbModel: string;
  openbmbBaseUrl?: string;
  openbmbModelPath?: string;
  openbmbCommandPath?: string;
  openbmbAutoDownload: boolean;
  openbmbModelUrl?: string;
  openbmbModelSha256?: string;
}

export function buildGraphSnapshotHtml(snapshot: GraphSnapshotResult, scriptUri: string): string {
  const typeOptions = Object.entries(snapshot.nodeTypeCount)
    .map(([type, count]) => `<option value="${escapeHtml(type)}">${escapeHtml(type)} (${count})</option>`)
    .join("");
  const nodeOptions = snapshot.sampleNodes
    .map(
      (node) =>
        `<option value="${escapeHtml(node.id)}">${escapeHtml(snapshotShortLabel(node))} [${escapeHtml(node.type)}]</option>`
    )
    .join("");
  const relationOptions = snapshot.topRelations
    .map((item) => `<option value="${escapeHtml(item.relation)}">${escapeHtml(item.relation)} (${item.count})</option>`)
    .join("");
  const relationPills = snapshot.topRelations
    .map((item) => `<span class="pill">${escapeHtml(item.relation)}: ${item.count}</span>`)
    .join("");
  const typeLegend = Object.entries(snapshot.nodeTypeCount)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => {
      const color = SNAPSHOT_NODE_COLORS[type] ?? "#64748b";
      return `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${escapeHtml(type)} (${count})</span>`;
    })
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
      grid-template-columns: 1.2fr 0.85fr 0.85fr 1fr auto;
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
    .canvas-wrap { position: relative; padding: 0; }
    .canvas-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.72);
    }
    .canvas-stats { font-size: 12px; color: var(--muted); }
    .canvas-controls { display: flex; gap: 6px; }
    .canvas-controls button {
      padding: 6px 10px;
      font-size: 12px;
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .canvas-controls button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .legend-row { display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 8px 12px 0; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
    .legend-dot { width: 10px; height: 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.08); }
    svg.graph-canvas {
      width: 100%;
      height: 580px;
      display: block;
      background:
        radial-gradient(circle at center, rgba(17, 100, 102, 0.05), transparent 42%),
        linear-gradient(180deg, #fff, #f8f4ed);
      cursor: grab;
      touch-action: none;
    }
    svg.graph-canvas.dragging { cursor: grabbing; }
    .type-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      margin-bottom: 6px;
    }
    .neighbor-list { display: grid; gap: 6px; max-height: 220px; overflow: auto; margin-top: 8px; }
    .neighbor-item {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px;
      align-items: start;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      font-size: 12px;
    }
    .relation-tag {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .detail-title { font-size: 15px; font-weight: 700; word-break: break-all; margin: 6px 0; }
    .detail-path { font-size: 11px; color: var(--muted); word-break: break-all; font-family: Consolas, monospace; }
    .detail-preview { margin-top: 10px; font-size: 12px; line-height: 1.5; color: var(--ink); white-space: pre-wrap; word-break: break-word; }
    .detail-grid { display: grid; gap: 10px; max-height: 620px; overflow: auto; }
    .detail-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: #fff; }
    .detail-card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; }
    .pill-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill { background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .empty { color: var(--muted); font-size: 13px; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .toolbar, .hero-grid { grid-template-columns: 1fr; }
      svg.graph-canvas { height: 440px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-grid">
        <div class="metric"><div class="label">存储后端</div><div class="value">${escapeHtml(snapshot.transport)}</div></div>
        <div class="metric"><div class="label">节点 / 边</div><div class="value">${snapshot.nodeCount} / ${snapshot.edgeCount}</div></div>
        <div class="metric"><div class="label">样本展示</div><div class="value">${snapshot.sampleNodes.length} 节点 · ${snapshot.sampleEdges.length} 边</div></div>
      </div>
      <div class="legend-row">${typeLegend}</div>
    </section>
    <section class="panel panel-body">
      <div class="toolbar">
        <div class="field">
          <label for="graph-search">搜索节点</label>
          <input id="graph-search" type="search" placeholder="按 ID、类型、摘要搜索" />
        </div>
        <div class="field">
          <label for="graph-type-filter">节点类型</label>
          <select id="graph-type-filter"><option value="all">全部类型</option>${typeOptions}</select>
        </div>
        <div class="field">
          <label for="graph-relation-filter">关系类型</label>
          <select id="graph-relation-filter"><option value="all">全部关系</option>${relationOptions}</select>
        </div>
        <div class="field">
          <label for="graph-node-list">聚焦节点</label>
          <select id="graph-node-list"><option value="">自动选择</option>${nodeOptions}</select>
        </div>
        <button id="graph-reset" type="button">重置</button>
      </div>
    </section>
    <div class="layout">
      <section class="panel">
        <div class="panel-head"><h2>节点列表</h2></div>
        <div class="panel-body"><div id="graph-node-cards" class="node-list">${serverNodeCards}</div></div>
      </section>
      <section class="panel">
        <div class="canvas-toolbar">
          <div class="canvas-stats" id="graph-canvas-stats">加载图谱中…</div>
          <div class="canvas-controls">
            <button id="graph-zoom-out" type="button" title="缩小">−</button>
            <button id="graph-zoom-in" type="button" title="放大">+</button>
            <button id="graph-zoom-fit" type="button" class="primary" title="适应画布">适应</button>
          </div>
        </div>
        <div class="canvas-wrap">
          <svg id="graph-canvas" class="graph-canvas" data-role="graph-canvas" viewBox="0 0 1000 580" preserveAspectRatio="xMidYMid meet">${serverSvgMarkup}</svg>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>节点详情</h2></div>
        <div class="panel-body detail-grid" id="graph-detail">
          <div class="detail-card">
            <strong>当前选中</strong>
            <div id="graph-detail-body">
              <div class="empty">点击左侧节点或画布中的圆点查看详情。</div>
            </div>
          </div>
          <div class="detail-card">
            <strong>邻接关系</strong>
            <div id="graph-neighbors" class="neighbor-list"><div class="empty">暂无邻接边</div></div>
          </div>
          <div class="detail-card">
            <strong>筛选状态</strong>
            <pre id="graph-filter-state">type=all\nrelation=all\nsearch=(none)</pre>
          </div>
          <div class="detail-card">
            <strong>关系统计</strong>
            <div class="pill-row">${relationPills || '<span class="empty">暂无关系数据</span>'}</div>
          </div>
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
          ${renderProviderOption("openbmb", settings.provider)}
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
      <label>OpenBMB Model Name <input id="settings-openbmb-model" name="openbmbModel" value="${escapeHtml(settings.openbmbModel)}" placeholder="minicpm-1b" /></label>
      <label>OpenBMB Mode
        <select id="settings-openbmb-mode" name="openbmbMode">
          <option value="embedded" ${settings.openbmbMode === "embedded" ? "selected" : ""}>embedded (local)</option>
          <option value="ollama" ${settings.openbmbMode === "ollama" ? "selected" : ""}>ollama (manual baseUrl)</option>
          <option value="openai-compat" ${settings.openbmbMode === "openai-compat" ? "selected" : ""}>openai-compat (manual baseUrl)</option>
        </select>
      </label>
      <label>OpenBMB Engine
        <select id="settings-openbmb-engine" name="openbmbEngine">
          <option value="command" ${settings.openbmbEngine === "command" ? "selected" : ""}>command</option>
          <option value="node-llama-cpp" ${settings.openbmbEngine === "node-llama-cpp" ? "selected" : ""}>node-llama-cpp</option>
        </select>
      </label>
      <label>OpenBMB Base URL (manual mode) <input id="settings-openbmb-base-url" name="openbmbBaseUrl" value="${escapeHtml(settings.openbmbBaseUrl ?? "")}" placeholder="http://localhost:11434" /></label>
      <label>OpenBMB Model Path (embedded) <input id="settings-openbmb-model-path" name="openbmbModelPath" value="${escapeHtml(settings.openbmbModelPath ?? "")}" placeholder="C:/models/minicpm-1b.gguf" /></label>
      <label>OpenBMB Command Path (command engine) <input id="settings-openbmb-command-path" name="openbmbCommandPath" value="${escapeHtml(settings.openbmbCommandPath ?? "")}" placeholder="C:/tools/minicpm.exe" /></label>
      <label>Auto Download URL <input id="settings-openbmb-model-url" name="openbmbModelUrl" value="${escapeHtml(settings.openbmbModelUrl ?? "")}" placeholder="https://.../minicpm-1b.gguf" /></label>
      <label>Auto Download SHA256 <input id="settings-openbmb-model-sha256" name="openbmbModelSha256" value="${escapeHtml(settings.openbmbModelSha256 ?? "")}" placeholder="optional" /></label>
    </section>
    <section class="panel checks">
      <label><input id="settings-openbmb-auto-download" name="openbmbAutoDownload" type="checkbox" ${settings.openbmbAutoDownload ? "checked" : ""} /> Auto download model and apply on save</label>
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

const SNAPSHOT_RELATION_COLORS: Record<string, string> = {
  references: "#64748b",
  defines: "#9333ea",
  imports: "#2563eb",
  depends_on: "#c2410c",
  co_occurs: "#0f766e",
  improves: "#16a34a",
  prerequisite: "#b45309",
  changes: "#dc2626",
};

function hashSnapshotString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function snapshotShortLabel(node: GraphSnapshotResult["sampleNodes"][number]): string {
  const id = node.id || "";
  if (id.startsWith("file:")) {
    const path = id.slice(5);
    return path.split(/[/\\]/).pop() || path;
  }
  if (id.startsWith("module:")) {
    const path = id.slice(7);
    return path.split(/[/\\]/).pop() || path;
  }
  if (id.startsWith("symbol:")) {
    const preview = node.contentPreview || "";
    const named = preview.match(/^(function|class|interface|type|method|variable|const|let|enum)\s+([A-Za-z0-9_$]+)/);
    if (named) return named[2];
    const beforeAt = preview.split("@")[0]?.trim();
    if (beforeAt) return beforeAt.length > 28 ? `${beforeAt.slice(0, 27)}…` : beforeAt;
  }
  return id.length > 28 ? `${id.slice(0, 27)}…` : id;
}

function layoutSnapshotPositions(
  nodes: GraphSnapshotResult["sampleNodes"],
  edges: GraphSnapshotResult["sampleEdges"]
): Map<string, { x: number; y: number }> {
  const width = 1000;
  const height = 580;
  const centerX = width / 2;
  const centerY = height / 2;
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
  const typeOrder = ["File", "Module", "Symbol", "Skill", "Decision", "TaskRun"];
  const groups = new Map<string, GraphSnapshotResult["sampleNodes"]>();

  nodes.forEach((node) => {
    const bucket = groups.get(node.type) || [];
    bucket.push(node);
    groups.set(node.type, bucket);
  });

  typeOrder.forEach((type, groupIndex) => {
    const bucket = groups.get(type) || [];
    const groupAngle = (Math.PI * 2 * groupIndex) / typeOrder.length;
    const groupRadius = Math.min(width, height) * 0.22;
    bucket.forEach((node, index) => {
      const localAngle = (Math.PI * 2 * index) / Math.max(1, bucket.length);
      const jitter = (hashSnapshotString(node.id) % 100) / 100 - 0.5;
      positions.set(node.id, {
        x: centerX + Math.cos(groupAngle + localAngle * 0.35) * groupRadius + jitter * 18,
        y: centerY + Math.sin(groupAngle + localAngle * 0.35) * groupRadius + jitter * 18,
        vx: 0,
        vy: 0,
      });
    });
  });

  const iterations = 180;
  const k = 42;
  const repulsion = 5200;

  for (let i = 0; i < iterations; i += 1) {
    const temp = 1 - i / iterations;
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        const p1 = positions.get(nodes[a].id)!;
        const p2 = positions.get(nodes[b].id)!;
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (repulsion / (dist * dist)) * temp;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        p1.vx += fx;
        p1.vy += fy;
        p2.vx -= fx;
        p2.vy -= fy;
      }
    }
    for (const edge of edges) {
      const p1 = positions.get(edge.from);
      const p2 = positions.get(edge.to);
      if (!p1 || !p2) continue;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = ((dist * dist) / (k * k)) * 0.12 * temp;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      p1.vx += fx;
      p1.vy += fy;
      p2.vx -= fx;
      p2.vy -= fy;
    }
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      p.vx += (centerX - p.x) * 0.04 * temp;
      p.vy += (centerY - p.y) * 0.04 * temp;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.52;
      p.vy *= 0.52;
    }
  }

  const result = new Map<string, { x: number; y: number }>();
  for (const [id, p] of positions.entries()) {
    result.set(id, { x: p.x, y: p.y });
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
  const lines: string[] = [
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path></marker></defs>',
  ];
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const color = SNAPSHOT_RELATION_COLORS[edge.relation] ?? "#cbbba7";
    lines.push(
      `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${color}" stroke-width="1.4" opacity="0.62" marker-end="url(#arrow)" />`
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
    const label = snapshotShortLabel(node);
    shapes.push(
      `<circle cx="${pos.x}" cy="${pos.y}" r="${isActive ? 11 : 8}" fill="${fill}" stroke="${isActive ? "#d97d54" : "#fff"}" stroke-width="${isActive ? 3 : 1.5}" />`,
      `<text x="${pos.x + 12}" y="${pos.y + 4}" font-size="${isActive ? 12 : 11}" fill="#334155">${escapeHtml(label)}</text>`
    );
  });

  return `${lines.join("")}${shapes.join("")}`;
}

function renderServerNodeCardsHtml(nodes: GraphSnapshotResult["sampleNodes"]): string {
  if (nodes.length === 0) {
    return '<div class="empty">暂无样本节点，请先索引后重新打开面板。</div>';
  }

  return nodes
    .map(
      (node, index) =>
        `<button type="button" class="node-item${index === 0 ? " active" : ""}" data-node-id="${escapeHtml(node.id)}">` +
        `<span class="type-badge" style="background:${(SNAPSHOT_NODE_COLORS[node.type] ?? "#64748b")}22;color:${SNAPSHOT_NODE_COLORS[node.type] ?? "#64748b"}">${escapeHtml(node.type)}</span>` +
        `<div class="node-title">${escapeHtml(snapshotShortLabel(node))}</div>` +
        `<div class="detail-path">${escapeHtml(node.id)}</div>` +
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

function escapeHtml(value: string | undefined | null): string {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}