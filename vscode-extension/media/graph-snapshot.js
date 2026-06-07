(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  let allNodes = [];
  let allEdges = [];
  let meta = { nodeCount: 0, edgeCount: 0 };
  let selectedId = "";
  let viewBox = { x: 0, y: 0, w: 1000, h: 580 };
  let fitViewBox = { x: 0, y: 0, w: 1000, h: 580 };
  let dragState = null;
  let lastLayoutKey = "";
  let cachedLayout = null;

  const searchInput = document.getElementById("graph-search");
  const typeFilter = document.getElementById("graph-type-filter");
  const relationFilter = document.getElementById("graph-relation-filter");
  const nodeList = document.getElementById("graph-node-list");
  const nodeCards = document.getElementById("graph-node-cards");
  const detailBody = document.getElementById("graph-detail-body");
  const neighborList = document.getElementById("graph-neighbors");
  const graphFilterState = document.getElementById("graph-filter-state");
  const canvasStats = document.getElementById("graph-canvas-stats");
  const svg = document.getElementById("graph-canvas");

  const nodeColors = {
    File: "#1d4ed8",
    Symbol: "#9333ea",
    Module: "#c2410c",
    TaskRun: "#0f766e",
    Decision: "#b91c1c",
    Skill: "#059669",
  };

  const relationColors = {
    references: "#64748b",
    defines: "#9333ea",
    imports: "#2563eb",
    depends_on: "#c2410c",
    co_occurs: "#0f766e",
    improves: "#16a34a",
    prerequisite: "#b45309",
    changes: "#dc2626",
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function shortLabel(node) {
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
      if (beforeAt) return beforeAt.length > 28 ? beforeAt.slice(0, 27) + "…" : beforeAt;
    }
    return id.length > 28 ? id.slice(0, 27) + "…" : id;
  }

  function typeBadgeStyle(type) {
    const color = nodeColors[type] || "#64748b";
    return `background:${color}22;color:${color};border:1px solid ${color}55`;
  }

  function relationStyle(relation) {
    const color = relationColors[relation] || "#94a3b8";
    return `background:${color}22;color:${color};border:1px solid ${color}55`;
  }

  function getVisibleNodes() {
    const term = String(searchInput.value || "").trim().toLowerCase();
    const type = String(typeFilter.value || "all");
    return allNodes.filter((node) => {
      const matchesType = type === "all" || node.type === type;
      const haystack = (node.id + " " + node.type + " " + node.contentPreview + " " + shortLabel(node)).toLowerCase();
      const matchesSearch = !term || haystack.includes(term);
      return matchesType && matchesSearch;
    });
  }

  function getRenderable() {
    const visibleNodes = getVisibleNodes();
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const relation = String(relationFilter?.value || "all");
    const visibleEdges = allEdges.filter((edge) => {
      if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) return false;
      if (relation !== "all" && edge.relation !== relation) return false;
      return true;
    });
    return { visibleNodes, visibleEdges };
  }

  function layoutGraph(visibleNodes, visibleEdges) {
    const width = 1000;
    const height = 580;
    const centerX = width / 2;
    const centerY = height / 2;
    const positions = new Map();
    const typeOrder = ["File", "Module", "Symbol", "Skill", "Decision", "TaskRun"];
    const groups = new Map();
    visibleNodes.forEach((node) => {
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
        const jitter = (hashString(node.id) % 100) / 100 - 0.5;
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
      for (let a = 0; a < visibleNodes.length; a += 1) {
        for (let b = a + 1; b < visibleNodes.length; b += 1) {
          const p1 = positions.get(visibleNodes[a].id);
          const p2 = positions.get(visibleNodes[b].id);
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
      visibleEdges.forEach((edge) => {
        const p1 = positions.get(edge.from);
        const p2 = positions.get(edge.to);
        if (!p1 || !p2) return;
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
      });
      visibleNodes.forEach((node) => {
        const p = positions.get(node.id);
        p.vx += (centerX - p.x) * 0.04 * temp;
        p.vy += (centerY - p.y) * 0.04 * temp;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.52;
        p.vy *= 0.52;
      });
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = 70;
    return {
      positions,
      bounds: {
        x: minX - pad,
        y: minY - pad,
        w: Math.max(maxX - minX + pad * 2, 1),
        h: Math.max(maxY - minY + pad * 2, 1),
      },
    };
  }

  function applyViewBox() {
    svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  }

  function fitToBounds(bounds) {
    fitViewBox = { ...bounds };
    viewBox = { ...bounds };
    applyViewBox();
  }

  function renderNodeCards(visibleNodes) {
    nodeCards.innerHTML = "";
    if (visibleNodes.length === 0) {
      nodeCards.innerHTML = '<div class="empty">当前筛选条件下没有节点。</div>';
      return;
    }
    visibleNodes.forEach((node) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "node-item" + (node.id === selectedId ? " active" : "");
      button.innerHTML =
        `<span class="type-badge" style="${typeBadgeStyle(node.type)}">${escapeHtml(node.type)}</span>` +
        `<div class="node-title">${escapeHtml(shortLabel(node))}</div>` +
        `<div class="detail-path">${escapeHtml(node.id)}</div>` +
        `<div class="node-preview">${escapeHtml(node.contentPreview || "(empty)")}</div>`;
      button.addEventListener("click", () => {
        selectedId = node.id;
        nodeList.value = node.id;
        render(false);
      });
      nodeCards.appendChild(button);
    });
  }

  function renderGraph(visibleNodes, visibleEdges, preserveView) {
    const layoutKey =
      visibleNodes
        .map((node) => node.id)
        .sort()
        .join("|") +
      "||" +
      visibleEdges
        .map((edge) => `${edge.from}>${edge.to}:${edge.relation}`)
        .sort()
        .join("|");
    if (!cachedLayout || layoutKey !== lastLayoutKey) {
      cachedLayout = layoutGraph(visibleNodes, visibleEdges);
      lastLayoutKey = layoutKey;
      if (!preserveView) {
        fitToBounds(cachedLayout.bounds);
      }
    }
    const positions = cachedLayout.positions;

    svg.innerHTML = "";
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML =
      '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path></marker>';
    svg.appendChild(defs);

    const world = document.createElementNS("http://www.w3.org/2000/svg", "g");
    world.setAttribute("id", "graph-world");

    visibleEdges.forEach((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return;
      const active = selectedId && (edge.from === selectedId || edge.to === selectedId);
      const color = relationColors[edge.relation] || "#cbbba7";
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
      line.setAttribute("stroke", active ? "#d97d54" : color);
      line.setAttribute("stroke-width", active ? "2.4" : "1.4");
      line.setAttribute("opacity", active ? "0.95" : "0.62");
      line.setAttribute("marker-end", "url(#arrow)");
      world.appendChild(line);
    });

    visibleNodes.forEach((node) => {
      const pos = positions.get(node.id);
      if (!pos) return;
      const active = node.id === selectedId;
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.style.cursor = "pointer";
      group.addEventListener("click", () => {
        selectedId = node.id;
        nodeList.value = node.id;
        render(false);
      });

      if (active) {
        const glow = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        glow.setAttribute("cx", String(pos.x));
        glow.setAttribute("cy", String(pos.y));
        glow.setAttribute("r", "18");
        glow.setAttribute("fill", nodeColors[node.type] || "#64748b");
        glow.setAttribute("opacity", "0.18");
        group.appendChild(glow);
      }

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(pos.x));
      circle.setAttribute("cy", String(pos.y));
      circle.setAttribute("r", String(active ? 11 : 8));
      circle.setAttribute("fill", nodeColors[node.type] || "#64748b");
      circle.setAttribute("stroke", active ? "#d97d54" : "#ffffff");
      circle.setAttribute("stroke-width", active ? "3" : "1.8");
      group.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(pos.x + 13));
      label.setAttribute("y", String(pos.y + 4));
      label.setAttribute("font-size", active ? "12.5" : "11");
      label.setAttribute("font-weight", active ? "700" : "500");
      label.setAttribute("fill", "#1e293b");
      label.textContent = shortLabel(node);
      group.appendChild(label);

      world.appendChild(group);
    });

    svg.appendChild(world);
  }

  function renderDetail(visibleNodes, visibleEdges) {
    const fallbackNode = visibleNodes[0];
    const activeNode = visibleNodes.find((node) => node.id === selectedId) || fallbackNode;
    if (!activeNode) {
      detailBody.innerHTML = '<div class="empty">当前筛选条件下没有节点。</div>';
      neighborList.innerHTML = '<div class="empty">暂无邻接边</div>';
      return;
    }
    if (!selectedId) {
      selectedId = activeNode.id;
      nodeList.value = activeNode.id;
    }

    detailBody.innerHTML =
      `<span class="type-badge" style="${typeBadgeStyle(activeNode.type)}">${escapeHtml(activeNode.type)}</span>` +
      `<div class="detail-title">${escapeHtml(shortLabel(activeNode))}</div>` +
      `<div class="detail-path">${escapeHtml(activeNode.id)}</div>` +
      `<div class="detail-preview">${escapeHtml(activeNode.contentPreview || "(empty)")}</div>`;

    const relatedEdges = visibleEdges.filter(
      (edge) => edge.from === activeNode.id || edge.to === activeNode.id
    );
    if (relatedEdges.length === 0) {
      neighborList.innerHTML = '<div class="empty">当前节点没有可见邻接边。</div>';
      return;
    }

    neighborList.innerHTML = relatedEdges
      .slice(0, 40)
      .map((edge) => {
        const otherId = edge.from === activeNode.id ? edge.to : edge.from;
        const otherNode = allNodes.find((node) => node.id === otherId);
        const direction = edge.from === activeNode.id ? "→" : "←";
        return (
          `<div class="neighbor-item">` +
          `<span class="relation-tag" style="${relationStyle(edge.relation)}">${escapeHtml(edge.relation)} ${direction}</span>` +
          `<div><div class="node-title">${escapeHtml(otherNode ? shortLabel(otherNode) : otherId)}</div>` +
          `<div class="detail-path">${escapeHtml(otherId)}</div></div>` +
          `</div>`
        );
      })
      .join("");
  }

  function render(preserveView) {
    const { visibleNodes, visibleEdges } = getRenderable();
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    if (selectedId && !visibleIds.has(selectedId)) selectedId = "";

    graphFilterState.textContent =
      "type=" +
      typeFilter.value +
      "\nrelation=" +
      (relationFilter?.value || "all") +
      "\nsearch=" +
      (searchInput.value || "(none)") +
      "\nvisible=" +
      visibleNodes.length +
      "/" +
      allNodes.length;

    canvasStats.textContent =
      `全库 ${meta.nodeCount || allNodes.length} 节点 · ${meta.edgeCount || allEdges.length} 边 · ` +
      `当前展示 ${visibleNodes.length} 节点 · ${visibleEdges.length} 边`;

    renderNodeCards(visibleNodes);
    renderGraph(visibleNodes, visibleEdges, preserveView === true);
    renderDetail(visibleNodes, visibleEdges);
  }

  function zoom(factor, anchorX, anchorY) {
    const rect = svg.getBoundingClientRect();
    const px = anchorX ?? rect.width / 2;
    const py = anchorY ?? rect.height / 2;
    const sx = viewBox.x + (px / rect.width) * viewBox.w;
    const sy = viewBox.y + (py / rect.height) * viewBox.h;
    viewBox.w *= factor;
    viewBox.h *= factor;
    viewBox.x = sx - (px / rect.width) * viewBox.w;
    viewBox.y = sy - (py / rect.height) * viewBox.h;
    applyViewBox();
  }

  searchInput.addEventListener("input", () => render(false));
  typeFilter.addEventListener("change", () => render(false));
  relationFilter?.addEventListener("change", () => render(false));
  nodeList.addEventListener("change", () => {
    selectedId = String(nodeList.value || "");
    render(true);
  });
  document.getElementById("graph-reset").addEventListener("click", () => {
    searchInput.value = "";
    typeFilter.value = "all";
    if (relationFilter) relationFilter.value = "all";
    nodeList.value = "";
    selectedId = "";
    lastLayoutKey = "";
    cachedLayout = null;
    render(false);
  });
  document.getElementById("graph-zoom-in").addEventListener("click", () => zoom(0.82));
  document.getElementById("graph-zoom-out").addEventListener("click", () => zoom(1.18));
  document.getElementById("graph-zoom-fit").addEventListener("click", () => {
    viewBox = { ...fitViewBox };
    applyViewBox();
  });

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoom(event.deltaY > 0 ? 1.08 : 0.92, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  svg.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    dragState = { startX: event.clientX, startY: event.clientY, viewBox: { ...viewBox } };
    svg.classList.add("dragging");
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragState) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - dragState.startX) / rect.width) * dragState.viewBox.w;
    const dy = ((event.clientY - dragState.startY) / rect.height) * dragState.viewBox.h;
    viewBox.x = dragState.viewBox.x - dx;
    viewBox.y = dragState.viewBox.y - dy;
    applyViewBox();
  });
  window.addEventListener("mouseup", () => {
    dragState = null;
    svg.classList.remove("dragging");
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "snapshot" || !message.payload) return;
    allNodes = message.payload.nodes || [];
    allEdges = message.payload.edges || [];
    meta = message.payload.meta || { nodeCount: allNodes.length, edgeCount: allEdges.length };
    selectedId = "";
    lastLayoutKey = "";
    cachedLayout = null;
    render(false);
  });

  if (vscode) {
    vscode.postMessage({ type: "ready" });
  }
})();
