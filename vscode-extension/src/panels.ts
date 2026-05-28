export interface GraphSnapshotResult {
  transport: "memory" | "mcp-http" | "file";
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
  transport: "memory" | "mcp-http" | "file";
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

export function buildGraphSnapshotHtml(snapshot: GraphSnapshotResult): string {
  const graphData = {
    nodes: snapshot.sampleNodes,
    edges: snapshot.sampleEdges,
  };
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
        <div class="panel-body"><div id="graph-node-cards" class="node-list"></div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Graph Canvas</h2></div>
        <div class="canvas-wrap"><svg id="graph-canvas" data-role="graph-canvas" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet"></svg></div>
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
  <script>
    const snapshot = ${JSON.stringify(graphData)};
    const allNodes = snapshot.nodes;
    const allEdges = snapshot.edges;
    const searchInput = document.getElementById('graph-search');
    const typeFilter = document.getElementById('graph-type-filter');
    const nodeList = document.getElementById('graph-node-list');
    const nodeCards = document.getElementById('graph-node-cards');
    const graphSelection = document.getElementById('graph-selection');
    const graphFilterState = document.getElementById('graph-filter-state');
    const svg = document.getElementById('graph-canvas');
    const colors = {
      File: '#1d4ed8', Symbol: '#9333ea', Module: '#c2410c', TaskRun: '#0f766e', Decision: '#b91c1c', Skill: '#0f766e'
    };

    let selectedId = '';

    function getVisibleNodes() {
      const term = String(searchInput.value || '').trim().toLowerCase();
      const type = String(typeFilter.value || 'all');
      return allNodes.filter((node) => {
        const matchesType = type === 'all' || node.type === type;
        const haystack = (node.id + ' ' + node.type + ' ' + node.contentPreview).toLowerCase();
        const matchesSearch = !term || haystack.includes(term);
        return matchesType && matchesSearch;
      });
    }

    function getRenderable() {
      const visibleNodes = getVisibleNodes();
      const visibleIds = new Set(visibleNodes.map((node) => node.id));
      const visibleEdges = allEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
      return { visibleNodes, visibleEdges };
    }

    function renderNodeCards(visibleNodes) {
      nodeCards.innerHTML = '';
      if (visibleNodes.length === 0) {
        nodeCards.innerHTML = '<div class="empty">No nodes match the current filter.</div>';
        return;
      }

      visibleNodes.forEach((node) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'node-item' + (node.id === selectedId ? ' active' : '');
        button.innerHTML = '<div class="node-meta">' + escapeHtml(node.type) + '</div>' +
          '<div class="node-title">' + escapeHtml(node.id) + '</div>' +
          '<div class="node-preview">' + escapeHtml(node.contentPreview || '(empty)') + '</div>';
        button.addEventListener('click', () => {
          selectedId = node.id;
          nodeList.value = node.id;
          render();
        });
        nodeCards.appendChild(button);
      });
    }

    function renderGraph(visibleNodes, visibleEdges) {
      svg.innerHTML = '';
      const width = 1000;
      const height = 560;
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) * 0.34;
      const total = Math.max(1, visibleNodes.length);
      const positions = new Map();

      visibleNodes.forEach((node, index) => {
        const isFocused = selectedId ? node.id === selectedId : index === 0;
        const angle = (Math.PI * 2 * index) / total;
        const radial = isFocused ? radius * 0.4 : radius;
        positions.set(node.id, {
          x: centerX + radial * Math.cos(angle),
          y: centerY + radial * Math.sin(angle),
        });
      });

      visibleEdges.forEach((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return;
        const isActive = selectedId && (edge.from === selectedId || edge.to === selectedId);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('stroke', isActive ? '#d97d54' : '#cbbba7');
        line.setAttribute('stroke-width', isActive ? '2.6' : '1.2');
        line.setAttribute('opacity', isActive ? '1' : '0.75');
        svg.appendChild(line);
      });

      visibleNodes.forEach((node) => {
        const pos = positions.get(node.id);
        if (!pos) return;
        const isActive = node.id === selectedId;
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(pos.x));
        circle.setAttribute('cy', String(pos.y));
        circle.setAttribute('r', isActive ? '11' : '8');
        circle.setAttribute('fill', colors[node.type] || '#64748b');
        circle.setAttribute('stroke', isActive ? '#d97d54' : '#fff');
        circle.setAttribute('stroke-width', isActive ? '3' : '1.5');
        circle.style.cursor = 'pointer';
        circle.addEventListener('click', () => {
          selectedId = node.id;
          nodeList.value = node.id;
          render();
        });
        svg.appendChild(circle);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(pos.x + 12));
        text.setAttribute('y', String(pos.y + 4));
        text.setAttribute('font-size', isActive ? '12' : '11');
        text.setAttribute('fill', '#334155');
        text.textContent = node.id.length > 30 ? node.id.slice(0, 29) + '...' : node.id;
        svg.appendChild(text);
      });
    }

    function renderDetail(visibleNodes, visibleEdges) {
      const fallbackNode = visibleNodes[0];
      const activeNode = visibleNodes.find((node) => node.id === selectedId) || fallbackNode;
      if (!activeNode) {
        graphSelection.textContent = 'No nodes match the current filter.';
        return;
      }

      if (!selectedId) {
        selectedId = activeNode.id;
        nodeList.value = activeNode.id;
      }

      const relatedEdges = visibleEdges.filter((edge) => edge.from === activeNode.id || edge.to === activeNode.id);
      graphSelection.textContent = [
        'node=' + activeNode.id,
        'type=' + activeNode.type,
        'preview=' + (activeNode.contentPreview || '(empty)'),
        'neighbors=' + relatedEdges.length,
        relatedEdges.map((edge) => edge.from + ' --' + edge.relation + '--> ' + edge.to).join('\n') || 'neighbors=(none)'
      ].join('\n');
    }

    function render() {
      const { visibleNodes, visibleEdges } = getRenderable();
      const visibleIds = new Set(visibleNodes.map((node) => node.id));
      if (selectedId && !visibleIds.has(selectedId)) {
        selectedId = '';
      }
      graphFilterState.textContent = 'type=' + typeFilter.value + '\nsearch=' + (searchInput.value || '(none)');
      renderNodeCards(visibleNodes);
      renderGraph(visibleNodes, visibleEdges);
      renderDetail(visibleNodes, visibleEdges);
    }

    searchInput.addEventListener('input', render);
    typeFilter.addEventListener('change', render);
    nodeList.addEventListener('change', () => {
      selectedId = String(nodeList.value || '');
      render();
    });
    document.getElementById('graph-reset').addEventListener('click', () => {
      searchInput.value = '';
      typeFilter.value = 'all';
      nodeList.value = '';
      selectedId = '';
      render();
    });

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    render();
  </script>
</body>
</html>`;
}

export function buildSkillInsightsHtml(insights: SkillInsightsResult): string {
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
    <section class="summary" id="skill-summary"></section>
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
        <tbody id="skill-table-body"></tbody>
      </table>
    </section>
  </div>
  <script>
    const skills = ${JSON.stringify(insights.skills)};
    const searchInput = document.getElementById('skill-search');
    const outcomeFilter = document.getElementById('skill-outcome-filter');
    const sortSelect = document.getElementById('skill-sort');
    const tableBody = document.getElementById('skill-table-body');
    const summary = document.getElementById('skill-summary');

    function filteredSkills() {
      const term = String(searchInput.value || '').trim().toLowerCase();
      const outcome = String(outcomeFilter.value || 'all');
      const sortBy = String(sortSelect.value || 'score');
      return skills
        .filter((skill) => {
          const matchesOutcome = outcome === 'all' || skill.lastOutcome === outcome;
          const matchesSearch = !term || (skill.name + ' ' + skill.id).toLowerCase().includes(term);
          return matchesOutcome && matchesSearch;
        })
        .slice()
        .sort((left, right) => {
          if (sortBy === 'uses') return right.uses - left.uses || right.score - left.score;
          if (sortBy === 'updatedAt') return right.updatedAt - left.updatedAt;
          if (sortBy === 'name') return left.name.localeCompare(right.name);
          return right.score - left.score || right.uses - left.uses;
        });
    }

    function renderSummary(items) {
      const passCount = items.filter((skill) => skill.lastOutcome === 'pass').length;
      const failCount = items.filter((skill) => skill.lastOutcome === 'fail').length;
      const avgScore = items.length ? (items.reduce((sum, item) => sum + item.score, 0) / items.length).toFixed(2) : '0.00';
      summary.innerHTML = [
        ['Visible skills', String(items.length)],
        ['Pass / Fail', passCount + ' / ' + failCount],
        ['Average score', avgScore],
      ].map(([label, value]) => '<div class="summary-card"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>').join('');
    }

    function renderTable() {
      const items = filteredSkills();
      renderSummary(items);
      if (items.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="empty">No skills match the current filters.</td></tr>';
        return;
      }
      tableBody.innerHTML = items.map((skill) => {
        const scoreClass = skill.score >= 0 ? 'score-pass' : 'score-fail';
        const updatedAt = skill.updatedAt ? new Date(skill.updatedAt).toLocaleString() : 'n/a';
        return '<tr>' +
          '<td><strong>' + escapeHtml(skill.name) + '</strong><br/><span style="color:#6b7280">' + escapeHtml(skill.id) + '</span></td>' +
          '<td class="' + scoreClass + '">' + skill.score + '</td>' +
          '<td>' + skill.uses + '</td>' +
          '<td>' + escapeHtml(skill.lastOutcome) + '</td>' +
          '<td>' + escapeHtml(updatedAt) + '</td>' +
        '</tr>';
      }).join('');
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    searchInput.addEventListener('input', renderTable);
    outcomeFilter.addEventListener('change', renderTable);
    sortSelect.addEventListener('change', renderTable);
    renderTable();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}