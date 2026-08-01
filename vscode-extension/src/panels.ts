export interface GraphSnapshotSampleNode {
  id: string;
  type: string;
  contentPreview: string;
  displayLabel: string;
  displayPath?: string;
  folderGroup?: string;
  sourcePath?: string;
  sourceLine?: number;
  viewLayer: "code" | "learning";
}

export interface GraphSnapshotResult {
  transport: "memory" | "mcp-http" | "file" | "sqlite";
  storePath?: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCount: Record<"File" | "Symbol" | "Module" | "TaskRun" | "Decision" | "Skill", number>;
  topRelations: Array<{ relation: string; count: number }>;
  sampleNodes: GraphSnapshotSampleNode[];
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
  /** Flywheel contribution stats fed from the CLI `getFlywheelReport` computation. */
  flywheel?: FlywheelPanelData;
}

/** Learning-loop contribution data shown in the Skill Insights panel's Flywheel section. */
export interface FlywheelPanelData {
  skills: {
    total: number;
    positive: number;
    neutral: number;
    negative: number;
    /** Most-used skills — what the flywheel actually injects most often. */
    topUsed: Array<{ name: string; score: number; uses: number }>;
  };
  episodes: {
    total: number;
    pass: number;
    fail: number;
    pending: number;
    /** Episodes carrying extracted lessons (flywheel raw material). */
    withLessons: number;
  };
  /** Decision nodes that are not episodes (Six Hats / plan insights). */
  insightDecisions: number;
}

export interface AgentWorkItemView {
  id: string;
  kind: "six-hats" | "five-whys" | "plan-refinement" | string;
  hat?: string;
  prompt: string;
  expectedFormat: string;
}

export interface AgentDelegationPanelResult {
  task: string;
  mode: string;
  agentInstructions?: string;
  agentWorkItems: AgentWorkItemView[];
  plan?: Array<{ id: string; description: string; dependencies: string[] }>;
  executionDescriptor?: {
    action: string;
    task: string;
    context: string;
    retryHints: string[];
    agentMode?: string;
    agentWorkItems?: AgentWorkItemView[];
    insightSummary?: string;
  };
  episodeId?: string;
  tokenBudget?: ContextPreviewResult["tokenBudget"];
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
  smartProvider: string;
  smartApiKey?: string;
  smartModel: string;
  smartBaseUrl?: string;
  economyProvider: string;
  economyApiKey?: string;
  economyModel: string;
  economyBaseUrl?: string;
  provider: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  maxContextTokens: number;
  layerQuota: { l1: number; l2: number; l3: number };
  enableNearLosslessMode: boolean;
  autoIndexOnPreview: boolean;
  autoIndexOnRun: boolean;
  autoIndexOnSave?: boolean;
  autoRunOnIndex: boolean;
  transport: "memory" | "mcp-http" | "file" | "sqlite";
  graphStorePath: string;
}

export interface SettingsPanelStatus {
  extensionVersion: string;
  graphNodeCount: number;
  graphEdgeCount: number;
  graphLastModified: string | null;
  diagnoseSummary: string;
  overlayKeys: string[];
  baseConfigPath: string;
  mcpAgents: Array<{
    agentId: string;
    agentName: string;
    configPath: string;
    scope: "user" | "workspace";
    detected: boolean;
    installed: boolean;
  }>;
}

export function buildGraphSnapshotHtml(snapshot: GraphSnapshotResult, scriptUri: string): string {
  const typeOptions = Object.entries(snapshot.nodeTypeCount)
    .map(([type, count]) => `<option value="${escapeHtml(type)}">${escapeHtml(type)} (${count})</option>`)
    .join("");
  const nodeOptions = snapshot.sampleNodes
    .map(
      (node) =>
        `<option value="${escapeHtml(node.id)}">${escapeHtml(snapshotShortLabel(node))} · ${escapeHtml(node.type)}</option>`
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
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow 知识图谱</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1017;
      --panel: #141b26;
      --panel-soft: #1a2332;
      --ink: #e6edf3;
      --muted: #8b949e;
      --line: #30363d;
      --accent: #3fb950;
      --accent-soft: rgba(63, 185, 80, 0.14);
      --accent-2: #58a6ff;
      --shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(88, 166, 255, 0.12), transparent 24%),
        radial-gradient(circle at top left, rgba(63, 185, 80, 0.1), transparent 30%),
        var(--bg);
    }
    .shell { padding: 16px; display: grid; gap: 14px; }
    .hero {
      background: linear-gradient(135deg, rgba(20, 27, 38, 0.98), rgba(11, 16, 23, 0.96));
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .hero-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    .metric { padding: 12px; }
    .metric .label { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; }
    .metric .value { margin-top: 6px; font-size: 18px; font-weight: 700; }
    .toolbar {
      display: grid;
      grid-template-columns: 1.1fr 0.8fr 0.8fr 1fr auto auto;
      gap: 10px;
      align-items: end;
    }
    .layer-tabs {
      display: inline-flex;
      gap: 6px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel-soft);
    }
    .layer-tab {
      width: auto;
      padding: 8px 12px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 12px;
    }
    .layer-tab.active {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .field { display: grid; gap: 6px; }
    .field label { font-size: 12px; color: var(--muted); }
    input, select, button {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 10px 12px;
      font: inherit;
      background: var(--panel-soft);
      color: var(--ink);
    }
    button {
      width: auto;
      background: var(--accent);
      color: #041007;
      cursor: pointer;
      border: none;
      padding-inline: 18px;
      font-weight: 600;
    }
    .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr) 340px; gap: 12px; }
    .panel { overflow: hidden; }
    .panel h2 { margin: 0; font-size: 14px; letter-spacing: 0.04em; color: var(--muted); }
    .panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); }
    .panel-body { padding: 12px 14px; }
    .node-list { display: grid; gap: 8px; max-height: 540px; overflow: auto; }
    .node-item {
      border: 1px solid var(--line);
      background: var(--panel-soft);
      border-radius: 12px;
      padding: 10px;
      cursor: pointer;
      text-align: left;
    }
    .node-item.active { border-color: var(--accent); background: var(--accent-soft); }
    .node-meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .node-title { font-size: 13px; font-weight: 600; word-break: break-word; }
    .node-subpath { font-size: 11px; color: var(--muted); margin-top: 4px; word-break: break-all; }
    .node-preview { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .canvas-wrap { position: relative; padding: 0; }
    .canvas-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(20, 27, 38, 0.92);
    }
    .canvas-stats { font-size: 12px; color: var(--muted); }
    .canvas-controls { display: flex; gap: 6px; }
    .canvas-controls button {
      padding: 6px 10px;
      font-size: 12px;
      border-radius: 8px;
      background: var(--panel-soft);
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .canvas-controls button.primary { background: var(--accent); color: #041007; border-color: var(--accent); }
    .legend-row { display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 8px 12px 0; }
    .legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
    .legend-dot { width: 10px; height: 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.15); }
    svg.graph-canvas {
      width: 100%;
      height: 620px;
      display: block;
      background:
        radial-gradient(circle at center, rgba(88, 166, 255, 0.06), transparent 42%),
        linear-gradient(180deg, #101722, #0b1017);
      cursor: grab;
      touch-action: none;
    }
    svg.graph-canvas.dragging { cursor: grabbing; }
    .type-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
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
      background: var(--panel-soft);
      font-size: 12px;
    }
    .relation-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .detail-title { font-size: 15px; font-weight: 700; word-break: break-word; margin: 6px 0; }
    .detail-path { font-size: 11px; color: var(--muted); word-break: break-all; font-family: Consolas, monospace; }
    .detail-preview { margin-top: 10px; font-size: 12px; line-height: 1.5; color: var(--ink); white-space: pre-wrap; word-break: break-word; }
    .detail-grid { display: grid; gap: 10px; max-height: 620px; overflow: auto; }
    .detail-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: var(--panel-soft); }
    .detail-card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; color: var(--muted); }
    .detail-actions { display: flex; gap: 8px; margin-top: 10px; }
    .detail-actions button.secondary {
      background: transparent;
      color: var(--accent-2);
      border: 1px solid var(--accent-2);
    }
    .pill-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill { background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .empty { color: var(--muted); font-size: 13px; }
    .empty-guide { padding: 24px; text-align: center; color: var(--muted); line-height: 1.6; }
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
        <div class="metric"><div class="label">全库规模</div><div class="value">${snapshot.nodeCount} 节点 · ${snapshot.edgeCount} 边</div></div>
        <div class="metric"><div class="label">当前样本</div><div class="value">${snapshot.sampleNodes.length} / ${snapshot.nodeCount} 节点</div></div>
        <div class="metric"><div class="label">样本边</div><div class="value">${snapshot.sampleEdges.length} / ${snapshot.edgeCount} 边</div></div>
      </div>
      <div class="legend-row">${typeLegend}</div>
    </section>
    <section class="panel panel-body">
      <div class="toolbar">
        <div class="field">
          <label for="graph-search">搜索</label>
          <input id="graph-search" type="search" placeholder="名称、路径、摘要…" />
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
        <div class="layer-tabs" id="graph-layer-tabs">
          <button type="button" class="layer-tab active" data-layer="all">全部</button>
          <button type="button" class="layer-tab" data-layer="code">代码层</button>
          <button type="button" class="layer-tab" data-layer="learning">学习层</button>
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
          <svg id="graph-canvas" class="graph-canvas" data-role="graph-canvas" viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet">${serverSvgMarkup}</svg>
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
            <div class="detail-actions">
              <button id="graph-open-source" type="button" class="secondary" disabled>打开源文件</button>
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
  const flywheelSection = insights.flywheel ? renderFlywheelSectionHtml(insights.flywheel) : "";

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
    .fw-panel { padding: 14px; }
    .fw-panel h2 { margin: 0 0 12px; font-size: 14px; letter-spacing: 0.04em; color: var(--muted); }
    .fw-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
    .fw-card { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: #fff; }
    .fw-card .label { color: var(--muted); font-size: 12px; }
    .fw-counts { display: flex; gap: 14px; margin-top: 8px; flex-wrap: wrap; }
    .fw-count { display: grid; gap: 2px; }
    .fw-count .num { font-size: 17px; font-weight: 700; }
    .fw-count .num.positive { color: var(--accent); }
    .fw-count .num.fail { color: var(--danger); }
    .fw-count .num.pending { color: var(--warn); }
    .fw-count .num.neutral { color: var(--muted); }
    .fw-count .num.insight { color: #6d28d9; }
    .fw-count .tag { font-size: 11px; color: var(--muted); }
    .fw-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .fw-block { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: #fff; }
    .fw-block-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .fw-top-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
    .fw-top-skill { display: flex; justify-content: space-between; align-items: center; gap: 8px; border: 1px solid #ece2d7; border-radius: 10px; padding: 6px 10px; font-size: 13px; }
    .fw-skill-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fw-skill-meta { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .fw-bar { display: flex; height: 14px; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); background: #f3eadf; }
    .fw-bar-seg.pass { background: var(--accent); }
    .fw-bar-seg.fail { background: var(--danger); }
    .fw-bar-seg.pending { background: var(--warn); }
    .fw-bar-legend { display: flex; gap: 12px; margin-top: 8px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
    .fw-bar-legend .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; margin-right: 4px; }
    .fw-bar-legend .dot.pass { background: var(--accent); }
    .fw-bar-legend .dot.fail { background: var(--danger); }
    .fw-bar-legend .dot.pending { background: var(--warn); }
    .fw-empty { color: var(--muted); font-size: 13px; }
    @media (max-width: 900px) {
      .toolbar, .summary, .fw-grid, .fw-row { grid-template-columns: 1fr; }
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
    ${flywheelSection}
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

export function buildAgentWorkItemsHtml(result: AgentDelegationPanelResult, scriptUri: string): string {
  const modeLabel = result.mode === "agent-delegated" ? "agent-delegated" : escapeHtml(result.mode);
  const workItemCards = result.agentWorkItems
    .map((item, index) => {
      const meta = [item.kind, item.hat ? `hat: ${item.hat}` : null, `format: ${item.expectedFormat}`]
        .filter(Boolean)
        .join(" · ");
      return (
        `<article class="work-item" data-item-id="${escapeHtml(item.id)}">` +
        `<div class="work-item-head">` +
        `<span class="work-item-index">${index + 1}</span>` +
        `<div class="work-item-title">` +
        `<strong>${escapeHtml(item.id)}</strong>` +
        `<span class="work-item-meta">${escapeHtml(meta)}</span>` +
        `</div>` +
        `<button type="button" class="copy-btn" data-copy-target="prompt-${index}">Copy prompt</button>` +
        `</div>` +
        `<details class="prompt-details">` +
        `<summary>Show prompt</summary>` +
        `<pre id="prompt-${index}" class="prompt-block">${escapeHtml(item.prompt)}</pre>` +
        `</details>` +
        `</article>`
      );
    })
    .join("");

  const planSection =
    result.plan && result.plan.length > 0
      ? `<section class="panel">
      <h2>Plan Tasks</h2>
      <ol class="plan-list">${result.plan
        .map(
          (node) =>
            `<li><strong>${escapeHtml(node.id)}</strong>: ${escapeHtml(node.description)}` +
            (node.dependencies.length > 0
              ? `<span class="deps">deps: ${escapeHtml(node.dependencies.join(", "))}</span>`
              : "") +
            `</li>`
        )
        .join("")}</ol>
    </section>`
      : "";

  const instructionsSection = result.agentInstructions
    ? `<section class="panel">
      <h2>Agent Instructions</h2>
      <pre class="instructions-block">${escapeHtml(result.agentInstructions)}</pre>
    </section>`
    : "";

  const episodeLine = result.episodeId
    ? `<p class="episode">Episode: <code>${escapeHtml(result.episodeId)}</code></p>`
    : "";

  const budgetSection = result.tokenBudget
    ? `<section class="panel">
      <h2>Token Budget</h2>
      <div class="grid">
        <div class="metric"><div class="label">Estimated Raw</div><div class="value">${result.tokenBudget.estimatedRawTokens}</div></div>
        <div class="metric"><div class="label">Compressed</div><div class="value">${result.tokenBudget.compressedTokens}</div></div>
        <div class="metric"><div class="label">Savings</div><div class="value">${result.tokenBudget.estimatedSavingsPercent}%</div></div>
        <div class="metric"><div class="label">Budget Used</div><div class="value">${result.tokenBudget.budgetUsedPercent}%</div></div>
      </div>
    </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Agent Work Items</title>
  <style>
    body { margin: 0; padding: 16px; font-family: "Segoe UI", sans-serif; color: #1f2937; background: #f6f1eb; }
    .shell { display: grid; gap: 14px; max-width: 960px; }
    .panel { background: #fffdf8; border: 1px solid #decdbb; border-radius: 16px; padding: 14px; box-shadow: 0 14px 34px rgba(31,41,55,.08); }
    .header-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .badge { background: #d8f1ee; color: #0f766e; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    h1 { margin: 8px 0 0; font-size: 22px; line-height: 1.35; word-break: break-word; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    .reminder { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 12px; padding: 12px 14px; font-size: 13px; line-height: 1.55; }
    .reminder code { background: #fde68a; padding: 2px 6px; border-radius: 6px; }
    .work-item { border: 1px solid #eadccc; border-radius: 12px; padding: 12px; background: #fff; display: grid; gap: 8px; }
    .work-items { display: grid; gap: 10px; }
    .work-item-head { display: flex; align-items: flex-start; gap: 10px; }
    .work-item-index { min-width: 28px; height: 28px; border-radius: 999px; background: #0f766e; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
    .work-item-title { flex: 1; min-width: 0; }
    .work-item-meta { display: block; margin-top: 4px; font-size: 12px; color: #6b7280; }
    .copy-btn { border: 1px solid #0f766e; background: #fff; color: #0f766e; border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .copy-btn.copied { background: #d8f1ee; }
    .prompt-details summary { cursor: pointer; color: #0f766e; font-size: 13px; font-weight: 600; }
    .prompt-block, .instructions-block { margin: 8px 0 0; padding: 10px; background: #f3eadf; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; line-height: 1.5; }
    .plan-list { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
    .plan-list .deps { display: block; font-size: 12px; color: #6b7280; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid #eadccc; border-radius: 12px; padding: 10px; background: #fff; }
    .label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    .value { margin-top: 6px; font-size: 20px; font-weight: 700; color: #0f766e; }
    .episode { margin: 8px 0 0; font-size: 13px; color: #6b7280; }
    code { background: #f3eadf; padding: 2px 5px; border-radius: 6px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel">
      <div class="header-row">
        <span class="badge">${modeLabel}</span>
        <span class="badge" style="background:#ede9fe;color:#6d28d9;">${result.agentWorkItems.length} work items</span>
      </div>
      <h1>${escapeHtml(result.task)}</h1>
      ${episodeLine}
    </section>
    <section class="reminder">
      Complete the prompts below with your connected coding agent model, then close the loop:
      <ul>
        <li>Call <code>graphflow_insight</code> (mode=<code>submit</code>) with your Six Hats / plan-refinement JSON responses, then <code>merge</code>.</li>
        <li>After executing the task, call <code>graphflow_report_outcome</code>${result.episodeId ? ` with episodeId <code>${escapeHtml(result.episodeId)}</code>` : ""}.</li>
      </ul>
    </section>
    ${instructionsSection}
    ${budgetSection}
    <section class="panel">
      <h2>Work Items</h2>
      <div class="work-items">${workItemCards || '<p class="empty">No agent work items.</p>'}</div>
    </section>
    ${planSection}
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

export function buildSettingsHtml(
  settings: GraphFlowSettings,
  scriptUri: string,
  status?: SettingsPanelStatus
): string {
  const diagnoseLines = status?.diagnoseSummary
    ? status.diagnoseSummary.split("; ").map((line) => `<li>${escapeHtml(line)}</li>`).join("")
    : "<li>当前状态：尚未测试</li>";
  const graphModified = status?.graphLastModified
    ? escapeHtml(new Date(status.graphLastModified).toLocaleString())
    : "尚未索引";
  const mcpStatusLines = renderMcpStatusLines(status?.mcpAgents ?? []);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Settings</title>
  <style>
    :root {
      --bg: #f4efe6;
      --panel: #fffaf2;
      --ink: #1f2937;
      --muted: #6d7f88;
      --line: #d8c9b7;
      --accent: #116466;
      --accent-blue: #1d4ed8;
      --accent-green: #047857;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; font-family: "Segoe UI", "PingFang SC", sans-serif; color: var(--ink); background: var(--bg); }
    form { display: grid; gap: 12px; max-width: 980px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 14px; box-shadow: 0 14px 34px rgba(33,53,71,.08); }
    .panel h1, .panel h2 { margin: 0 0 8px; }
    .panel p { margin: 0; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: #fff; }
    .metric .label { font-size: 11px; color: var(--muted); }
    .metric .value { margin-top: 4px; font-weight: 700; font-size: 14px; }
    .flow-box { background: #fdf5eb; border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-top: 10px; }
    .flow-box h3 { margin: 0 0 8px; color: #b45309; font-size: 14px; }
    .flow-box ol { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: #213547; }
    .flow-hint { margin-top: 10px; font-size: 12px; color: var(--muted); }
    .tier-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .tier-card { border-radius: 14px; padding: 12px; display: grid; gap: 10px; }
    .tier-card.smart { background: #faf5ff; border: 1px solid #ddd6fe; }
    .tier-card.economy { background: #f0fdfa; border: 1px solid #99f6e4; }
    .tier-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .tier-badge { font-size: 10px; font-weight: 600; color: #fff; padding: 4px 8px; border-radius: 999px; }
    .tier-badge.smart { background: #7c3aed; }
    .tier-badge.economy { background: #0f766e; }
    .tier-hint { font-size: 11px; color: var(--muted); line-height: 1.4; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; font-size: 12px; color: var(--muted); }
    input, select { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; color: #213547; background: #fff; width: 100%; }
    .checks label { display: flex; flex-direction: row; align-items: center; gap: 8px; color: #213547; font-size: 13px; }
    .checks input[type="checkbox"] { width: auto; }
    .advanced { display: none; gap: 12px; }
    .advanced.open { display: grid; }
    .advanced-toggle { background: none; border: 0; padding: 0; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
    .action-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button { border: 0; border-radius: 12px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; color: #fff; }
    .btn-save { background: var(--accent); }
    .btn-route { background: var(--accent-green); }
    .btn-route:disabled { background: #9ca3af; cursor: not-allowed; }
    .btn-index { background: var(--accent-blue); }
    .btn-index:disabled { background: #9ca3af; cursor: not-allowed; }
    .route-panel { background: #ecfdf5; border-color: #6ee7b7; }
    .route-panel h2 { color: var(--accent-green); }
    .status-list { margin: 0; padding-left: 20px; font-size: 12px; line-height: 1.6; color: #334155; }
    #settings-status { margin: 0; font-size: 12px; color: var(--muted); min-height: 18px; }
    .hidden-legacy { display: none; }
    @media (max-width: 800px) { .metrics, .tier-row, .grid-2 { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <form id="settings-form">
    <section class="panel">
      <h1>GraphFlow 初次配置</h1>
      <p class="flow-hint">配置保存至 <code>${escapeHtml(settings.configPath)}</code> · 一次配置，所有项目可用</p>
      ${
        status
          ? `<div class="metrics" style="margin-top: 12px;">
        <div class="metric"><div class="label">Extension</div><div class="value">v${escapeHtml(status.extensionVersion)}</div></div>
        <div class="metric"><div class="label">图谱规模</div><div class="value">${status.graphNodeCount} 节点 / ${status.graphEdgeCount} 边</div></div>
        <div class="metric"><div class="label">上次索引</div><div class="value">${graphModified}</div></div>
      </div>`
          : ""
      }
      <div class="flow-box">
        <h3>v${escapeHtml(status?.extensionVersion ?? "1.9.2")} 本版亮点</h3>
        <ol>
          <li><strong>Goal 锚点</strong>：intent 五元组固化为图一等公民，每次打包自动注入原始需求——执行全程记得为什么出发。</li>
          <li><strong>低置信度澄清门</strong>：intent <code>confidence &lt; 0.6</code> 不出 plan，先澄清再定稿。</li>
          <li><strong>alignment-check 回检</strong>：执行后对照目标锚点检查产出是否服务 successDefinition、是否触碰 nonGoals。</li>
          <li><strong>deviation 偏离分类</strong>：<code>report_outcome</code> 记录 misread-requirement / scope-creep / tech-drift，飞轮报告聚合可度量。</li>
          <li><strong>Goal 版本链</strong>：需求变更自动版本化 + changedFields diff，pending episodes 标记 staleGoal；ATP/IR 规范升级 v1.1。</li>
        </ol>
        <p class="flow-hint">工具调用请传 <code>rootDir</code>（项目绝对路径）。若 MCP 日志提示 unsafe workspace root from discovery，重新执行「安装 / 更新 MCP」并 Reload Window。</p>
      </div>
      <div class="flow-box">
        <h3>快速上手</h3>
        <ol>
          <li>填写图谱存储路径，点击「建立图谱」—— 无需 LLM 即可索引代码结构。</li>
          <li>（可选）配置 Smart / Economy 两层模型，分别用于规划推理与轻量摘要。</li>
          <li>保存后运行「测试路由」，验证模型连通性并可选语义增强。</li>
        </ol>
        <p class="flow-hint">提示：API Key 可填环境变量名（如 <code>DEEPSEEK_API_KEY</code>）或直接填 <code>sk-...</code></p>
      </div>
    </section>

    <section class="panel">
      <h2>MCP 自动配置</h2>
      <p class="flow-hint" style="margin-bottom: 10px;">安装扩展时会自动将 GraphFlow MCP 写入本机已检测到的 AI Agent / IDE 用户级配置（含 Cursor <code>${"${workspaceFolder}"}</code> 插值）。配置后请<strong>重启对应工具 / Reload Window</strong>以加载 MCP。</p>
      <ul id="settings-mcp-status-list" class="status-list">${mcpStatusLines}</ul>
      <div style="margin-top: 10px;">
        <button id="settings-install-mcp" type="button" class="btn-index">安装 / 更新 MCP 到已检测 Agent</button>
      </div>
      <p id="settings-mcp-action-status" class="flow-hint" style="margin-top: 8px;"></p>
    </section>

    <section class="panel">
      <h2>LLM 配置（可选）</h2>
      <p class="flow-hint" style="margin-bottom: 12px;">Smart 用于规划与复杂推理；Economy 用于语义摘要与轻量任务。两层可独立选择 Provider、API Key 与模型。</p>
      <div class="tier-row">
        ${renderSettingsTierCard("smart", "Smart 层", "规划 / 推理", settings)}
        ${renderSettingsTierCard("economy", "Economy 层", "摘要 / 轻量", settings)}
      </div>
    </section>

    <section class="panel">
      <h2>图谱与索引</h2>
      <p class="flow-hint" style="margin-bottom: 12px;">无需 LLM 即可建立结构图谱。语义摘要依赖 Economy 层配置。</p>
      <div class="grid-2">
        <label>Graph Store Path
          <input id="settings-graph-store-path" name="graphStorePath" value="${escapeHtml(settings.graphStorePath)}" />
        </label>
        <label>Transport
          <select id="settings-transport" name="transport">
            ${renderTransportOption("file", settings.transport)}
            ${renderTransportOption("sqlite", settings.transport)}
            ${renderTransportOption("memory", settings.transport)}
            ${renderTransportOption("mcp-http", settings.transport)}
          </select>
        </label>
      </div>
      <div class="checks" style="margin-top: 10px;">
        <label><input id="settings-auto-index-save" name="autoIndexOnSave" type="checkbox" ${settings.autoIndexOnSave ? "checked" : ""} /> 保存文件后自动索引（防抖）</label>
        <label><input id="settings-auto-run-on-index" name="autoRunOnIndex" type="checkbox" ${settings.autoRunOnIndex ? "checked" : ""} /> 索引完成后自动语义提取（使用 Economy 层）</label>
      </div>
      <button type="button" class="advanced-toggle" id="settings-advanced-toggle" style="margin-top: 10px;">▸ 高级选项：Max Context Tokens · L1/L2/L3 Anchors</button>
      <div class="advanced" id="settings-advanced-panel">
        <div class="grid-2">
          <label>Max Context Tokens <input id="settings-max-context-tokens" name="maxContextTokens" type="number" min="1" value="${settings.maxContextTokens}" /></label>
          <label>L1 Anchors <input id="settings-layer-l1" name="l1" type="number" min="0" value="${settings.layerQuota.l1}" /></label>
          <label>L2 Anchors <input id="settings-layer-l2" name="l2" type="number" min="0" value="${settings.layerQuota.l2}" /></label>
          <label>L3 Anchors <input id="settings-layer-l3" name="l3" type="number" min="0" value="${settings.layerQuota.l3}" /></label>
        </div>
      </div>
      <div style="margin-top: 12px;">
        <button id="settings-index-graph" type="button" class="btn-index">建立图谱（无需 LLM）</button>
      </div>
      <ul id="settings-graph-index-list" class="status-list" style="display: none;"></ul>
    </section>

    <section class="panel route-panel" id="settings-routing-panel">
      <h2>路由连通性测试（可选）</h2>
      <p class="flow-hint" style="margin-bottom: 10px;">配置 Smart / Economy 任一层后，可一键测试模型连通性；通过后自动索引并可选语义增强。</p>
      <ul id="settings-tier-readiness-list" class="status-list"></ul>
      <ul id="settings-diagnose-list" class="status-list">${diagnoseLines}</ul>
      <ul id="settings-route-test-list" class="status-list" style="display: none;"></ul>
    </section>

    <div class="action-row">
      <button id="settings-save" type="submit" class="btn-save">Save Settings</button>
      <button id="settings-test-routing" type="button" class="btn-route" disabled>测试路由</button>
    </div>
    <p id="settings-status"></p>

    <div class="hidden-legacy">
      <input id="settings-enable-near-lossless" name="enableNearLosslessMode" type="checkbox" ${settings.enableNearLosslessMode ? "checked" : ""} />
      <input id="settings-auto-index-preview" name="autoIndexOnPreview" type="checkbox" ${settings.autoIndexOnPreview ? "checked" : ""} />
      <input id="settings-auto-index-run" name="autoIndexOnRun" type="checkbox" ${settings.autoIndexOnRun ? "checked" : ""} />
    </div>
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

function snapshotShortLabel(node: GraphSnapshotSampleNode): string {
  if (node.displayLabel) {
    return node.displayLabel;
  }
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

function normalizeSnapshotPositions(
  positions: Map<string, { x: number; y: number }>,
  width: number,
  height: number,
  pad: number
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of positions.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  if (!Number.isFinite(minX)) {
    return;
  }

  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const innerW = Math.max(width - pad * 2, 1);
  const innerH = Math.max(height - pad * 2, 1);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  for (const point of positions.values()) {
    point.x = width / 2 + (point.x - centerX) * scale;
    point.y = height / 2 + (point.y - centerY) * scale;
  }
}

function layoutSnapshotPositions(
  nodes: GraphSnapshotResult["sampleNodes"],
  edges: GraphSnapshotResult["sampleEdges"]
): Map<string, { x: number; y: number }> {
  const width = 1000;
  const height = 620;
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
  normalizeSnapshotPositions(result, width, height, 72);
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
      `<text x="${pos.x + 12}" y="${pos.y + 4}" font-size="${isActive ? 12 : 11}" fill="#c9d1d9">${escapeHtml(label)}</text>`
    );
  });

  return `${lines.join("")}${shapes.join("")}`;
}

function renderServerNodeCardsHtml(nodes: GraphSnapshotSampleNode[]): string {
  if (nodes.length === 0) {
    return '<div class="empty-guide">暂无图谱数据。<br/>请运行「建立图谱」或保存文件触发自动索引后重新打开。</div>';
  }

  return nodes
    .map(
      (node, index) =>
        `<button type="button" class="node-item${index === 0 ? " active" : ""}" data-node-id="${escapeHtml(node.id)}">` +
        `<span class="type-badge" style="background:${(SNAPSHOT_NODE_COLORS[node.type] ?? "#64748b")}22;color:${SNAPSHOT_NODE_COLORS[node.type] ?? "#64748b"}">${escapeHtml(node.type)}</span>` +
        `<div class="node-title">${escapeHtml(snapshotShortLabel(node))}</div>` +
        (node.displayPath ? `<div class="node-subpath">${escapeHtml(node.displayPath)}</div>` : `<div class="node-subpath">${escapeHtml(node.id)}</div>`) +
        (node.folderGroup ? `<div class="node-meta">目录组 · ${escapeHtml(node.folderGroup)}</div>` : "") +
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

function renderFlywheelSectionHtml(flywheel: FlywheelPanelData): string {
  const { skills, episodes, insightDecisions } = flywheel;
  const totalSegments = Math.max(episodes.total, 1);
  const passPct = Math.round((episodes.pass / totalSegments) * 100);
  const failPct = Math.round((episodes.fail / totalSegments) * 100);
  const pendingPct = Math.max(100 - passPct - failPct, 0);

  const topUsedRows = skills.topUsed
    .map(
      (item) =>
        `<li class="fw-top-skill"><span class="fw-skill-name">${escapeHtml(item.name)}</span>` +
        `<span class="fw-skill-meta">score ${item.score} · ${item.uses} uses</span></li>`
    )
    .join("");

  return `<section class="fw-panel panel">
    <h2>Flywheel · 学习飞轮贡献</h2>
    <div class="fw-grid">
      <div class="fw-card">
        <div class="label">Skill distribution</div>
        <div class="fw-counts">
          <div class="fw-count"><span class="num positive">${skills.positive}</span><span class="tag">positive</span></div>
          <div class="fw-count"><span class="num neutral">${skills.neutral}</span><span class="tag">neutral</span></div>
          <div class="fw-count"><span class="num fail">${skills.negative}</span><span class="tag">negative</span></div>
          <div class="fw-count"><span class="num">${skills.total}</span><span class="tag">total</span></div>
        </div>
      </div>
      <div class="fw-card">
        <div class="label">Episodes</div>
        <div class="fw-counts">
          <div class="fw-count"><span class="num positive">${episodes.pass}</span><span class="tag">pass</span></div>
          <div class="fw-count"><span class="num fail">${episodes.fail}</span><span class="tag">fail</span></div>
          <div class="fw-count"><span class="num pending">${episodes.pending}</span><span class="tag">pending</span></div>
          <div class="fw-count"><span class="num">${episodes.withLessons}</span><span class="tag">with lessons</span></div>
        </div>
      </div>
      <div class="fw-card">
        <div class="label">Insight decisions</div>
        <div class="fw-counts">
          <div class="fw-count"><span class="num insight">${insightDecisions}</span><span class="tag">non-episode decisions</span></div>
        </div>
      </div>
    </div>
    <div class="fw-row">
      <div class="fw-block">
        <div class="fw-block-label">Top used skills</div>
        ${
          skills.topUsed.length > 0
            ? `<ul class="fw-top-list">${topUsedRows}</ul>`
            : '<div class="fw-empty">No skills used yet — run some tasks to spin the flywheel.</div>'
        }
      </div>
      <div class="fw-block">
        <div class="fw-block-label">Episode outcomes</div>
        <div class="fw-bar">
          <div class="fw-bar-seg pass" style="width:${passPct}%"></div>
          <div class="fw-bar-seg fail" style="width:${failPct}%"></div>
          <div class="fw-bar-seg pending" style="width:${pendingPct}%"></div>
        </div>
        <div class="fw-bar-legend">
          <span><span class="dot pass"></span>pass ${episodes.pass}</span>
          <span><span class="dot fail"></span>fail ${episodes.fail}</span>
          <span><span class="dot pending"></span>pending ${episodes.pending}</span>
        </div>
      </div>
    </div>
  </section>`;
}

function renderSettingsTierCard(
  tier: "smart" | "economy",
  title: string,
  badge: string,
  settings: GraphFlowSettings
): string {
  const provider = tier === "smart" ? settings.smartProvider : settings.economyProvider;
  const apiKey = tier === "smart" ? settings.smartApiKey : settings.economyApiKey;
  const model = tier === "smart" ? settings.smartModel : settings.economyModel;
  const baseUrl = tier === "smart" ? settings.smartBaseUrl : settings.economyBaseUrl;
  const prefix = tier === "smart" ? "smart" : "economy";

  return `<div class="tier-card ${tier}">
    <div class="tier-head">
      <strong>${escapeHtml(title)}</strong>
      <span class="tier-badge ${tier}">${escapeHtml(badge)}</span>
    </div>
    <label>Provider
      <select id="settings-${prefix}-provider" name="${prefix}Provider">
        ${renderProviderOption("openai", provider)}
        ${renderProviderOption("deepseek", provider)}
        ${renderProviderOption("anthropic", provider)}
        ${renderProviderOption("bailian", provider)}
        ${renderProviderOption("doubao", provider)}
      </select>
    </label>
    <label>API Key
      <input id="settings-${prefix}-api-key" name="${prefix}ApiKey" value="${escapeHtml(apiKey ?? "")}" placeholder="sk-... or DEEPSEEK_API_KEY" />
    </label>
    <label>Base URL
      <input id="settings-${prefix}-base-url" name="${prefix}BaseUrl" value="${escapeHtml(baseUrl ?? "")}" placeholder="${provider === "deepseek" ? "https://api.deepseek.com（可空）" : "https://api.openai.com/v1"}" />
    </label>
    <label>Model
      <input id="settings-${prefix}-model" name="${prefix}Model" value="${escapeHtml(model)}" placeholder="${tier === "smart" ? "deepseek-v4-pro" : "deepseek-v4-flash"}" />
    </label>
    <p class="tier-hint">推荐选择 <strong>deepseek</strong> 并填写 API Key；Base URL 默认为 https://api.deepseek.com。旧配置若用 openai + DeepSeek URL，请迁移到 deepseek provider。</p>
  </div>`;
}

function renderMcpStatusLines(
  agents: SettingsPanelStatus["mcpAgents"]
): string {
  if (agents.length === 0) {
    return '<li style="color: #b45309;">未检测到本机 AI Agent / IDE。可手动运行命令面板中的「GraphFlow: Install MCP to Agents」。</li>';
  }

  return agents
    .map((agent) => {
      const state = agent.installed
        ? `<span style="color: #047857;">已安装</span>`
        : `<span style="color: #b45309;">未安装</span>`;
      return `<li>${state} · ${escapeHtml(agent.agentName)} · <code>${escapeHtml(agent.configPath)}</code></li>`;
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