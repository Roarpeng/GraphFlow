(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  let allNodes = [];
  let allEdges = [];
  let meta = { nodeCount: 0, edgeCount: 0 };
  let selectedId = "";
  let layerFilter = "all";
  let viewBox = { x: 0, y: 0, w: 1000, h: 620 };
  let fitViewBox = { x: 0, y: 0, w: 1000, h: 620 };
  let dragState = null;
  let lastLayoutKey = "";
  let cachedLayout = null;

  const searchInput = document.getElementById("graph-search");
  const typeFilter = document.getElementById("graph-type-filter");
  const relationFilter = document.getElementById("graph-relation-filter");
  const nodeList = document.getElementById("graph-node-list");
  const nodeCards = document.getElementById("graph-node-cards");
  const detailBody = document.getElementById("graph-detail-body");
  const openSourceButton = document.getElementById("graph-open-source");
  const neighborList = document.getElementById("graph-neighbors");
  const graphFilterState = document.getElementById("graph-filter-state");
  const canvasStats = document.getElementById("graph-canvas-stats");
  const layerTabs = document.getElementById("graph-layer-tabs");
  const svg = document.getElementById("graph-canvas");

  const TYPE_LABELS = {
    File: "文件",
    Symbol: "符号",
    Module: "模块",
    TaskRun: "任务运行",
    Decision: "决策",
    Skill: "技能",
  };

  const RELATION_LABELS = {
    references: "引用",
    defines: "定义",
    imports: "导入",
    depends_on: "依赖",
    co_occurs: "共现",
    improves: "改进",
    prerequisite: "前置",
    changes: "变更",
    validates: "校验",
    conflicts_with: "冲突",
  };

  const nodeColors = {
    File: "#58a6ff",
    Symbol: "#bc8cff",
    Module: "#f0883e",
    TaskRun: "#3fb950",
    Decision: "#f85149",
    Skill: "#39d353",
  };

  const relationColors = {
    references: "#8b949e",
    defines: "#bc8cff",
    imports: "#58a6ff",
    depends_on: "#f0883e",
    co_occurs: "#3fb950",
    improves: "#39d353",
    prerequisite: "#d29922",
    changes: "#f85149",
    validates: "#a5d6ff",
    conflicts_with: "#ff7b72",
  };

  const relationDash = {
    imports: "6 4",
    depends_on: "2 4",
    co_occurs: "4 3",
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

  function nodeLabel(node) {
    return node.displayLabel || node.id;
  }

  function folderColor(folderGroup) {
    const key = folderGroup || "其他";
    const hue = hashString(key) % 360;
    return `hsl(${hue} 58% 52%)`;
  }

  function typeBadgeStyle(type) {
    const color = nodeColors[type] || "#64748b";
    return `background:${color}22;color:${color};border:1px solid ${color}55`;
  }

  function relationStyle(relation) {
    const color = relationColors[relation] || "#94a3b8";
    return `background:${color}22;color:${color};border:1px solid ${color}55`;
  }

  function relationLabel(relation) {
    return RELATION_LABELS[relation] || relation;
  }

  function typeLabel(type) {
    return TYPE_LABELS[type] || type;
  }

  function getVisibleNodes() {
    const term = String(searchInput.value || "").trim().toLowerCase();
    const type = String(typeFilter.value || "all");
    return allNodes.filter((node) => {
      const matchesLayer =
        layerFilter === "all" ||
        node.viewLayer === layerFilter ||
        (!node.viewLayer && layerFilter === "code" && ["File", "Module", "Symbol"].includes(node.type));
      const matchesType = type === "all" || node.type === type;
      const haystack = (
        node.id +
        " " +
        node.type +
        " " +
        node.contentPreview +
        " " +
        nodeLabel(node) +
        " " +
        (node.displayPath || "") +
        " " +
        (node.folderGroup || "")
      ).toLowerCase();
      const matchesSearch = !term || haystack.includes(term);
      return matchesLayer && matchesType && matchesSearch;
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
    const height = 620;
    const centerX = width / 2;
    const centerY = height / 2;
    const positions = new Map();

    const folderGroups = new Map();
    visibleNodes.forEach((node) => {
      const group = node.folderGroup || (node.viewLayer === "learning" ? "learning" : "其他");
      const bucket = folderGroups.get(group) || [];
      bucket.push(node);
      folderGroups.set(group, bucket);
    });

    const groups = Array.from(folderGroups.entries());
    groups.forEach(([groupName, bucket], groupIndex) => {
      const groupAngle = (Math.PI * 2 * groupIndex) / Math.max(1, groups.length);
      const groupRadius = Math.min(width, height) * (groups.length > 6 ? 0.28 : 0.24);
      const typeOrder = ["File", "Module", "Symbol", "Skill", "Decision", "TaskRun"];
      bucket.sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));

      bucket.forEach((node, index) => {
        const localAngle = (Math.PI * 2 * index) / Math.max(1, bucket.length);
        const jitter = (hashString(node.id) % 100) / 100 - 0.5;
        positions.set(node.id, {
          x: centerX + Math.cos(groupAngle + localAngle * 0.42) * groupRadius + jitter * 22,
          y: centerY + Math.sin(groupAngle + localAngle * 0.42) * groupRadius + jitter * 22,
          vx: 0,
          vy: 0,
          folderGroup: groupName,
        });
      });
    });

    const iterations = 200;
    const k = 48;
    const repulsion = 6200;
    for (let i = 0; i < iterations; i += 1) {
      const temp = 1 - i / iterations;
      for (let a = 0; a < visibleNodes.length; a += 1) {
        for (let b = a + 1; b < visibleNodes.length; b += 1) {
          const p1 = positions.get(visibleNodes[a].id);
          const p2 = positions.get(visibleNodes[b].id);
          const dx = p1.x - p2.x;
          const dy = p1.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const sameFolder = p1.folderGroup === p2.folderGroup ? 0.85 : 1;
          const force = ((repulsion * sameFolder) / (dist * dist)) * temp;
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
        const force = ((dist * dist) / (k * k)) * 0.14 * temp;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        p1.vx += fx;
        p1.vy += fy;
        p2.vx -= fx;
        p2.vy -= fy;
      });
      visibleNodes.forEach((node) => {
        const p = positions.get(node.id);
        p.vx += (centerX - p.x) * 0.035 * temp;
        p.vy += (centerY - p.y) * 0.035 * temp;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.5;
        p.vy *= 0.5;
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
    const pad = 80;
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

  function openSourceForNode(node) {
    if (!vscode || !node?.sourcePath) return;
    vscode.postMessage({
      type: "openSource",
      path: node.sourcePath,
      line: node.sourceLine || 1,
    });
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
        `<span class="type-badge" style="${typeBadgeStyle(node.type)}">${escapeHtml(typeLabel(node.type))}</span>` +
        `<div class="node-title">${escapeHtml(nodeLabel(node))}</div>` +
        (node.displayPath
          ? `<div class="node-subpath">${escapeHtml(node.displayPath)}</div>`
          : `<div class="node-subpath">${escapeHtml(node.id)}</div>`) +
        (node.folderGroup ? `<div class="node-meta">目录组 · ${escapeHtml(node.folderGroup)}</div>` : "") +
        `<div class="node-preview">${escapeHtml(node.contentPreview || "(empty)")}</div>`;
      button.addEventListener("click", () => {
        selectedId = node.id;
        nodeList.value = node.id;
        render(false);
      });
      button.addEventListener("dblclick", () => openSourceForNode(node));
      nodeCards.appendChild(button);
    });
  }

  function renderGraph(visibleNodes, visibleEdges, preserveView) {
    const layoutKey =
      layerFilter +
      "|" +
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
      const color = relationColors[edge.relation] || "#8b949e";
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
      line.setAttribute("stroke", active ? "#58a6ff" : color);
      line.setAttribute("stroke-width", active ? "2.6" : "1.5");
      line.setAttribute("opacity", active ? "0.95" : "0.55");
      if (relationDash[edge.relation]) {
        line.setAttribute("stroke-dasharray", relationDash[edge.relation]);
      }
      line.setAttribute("marker-end", "url(#arrow)");
      world.appendChild(line);
    });

    visibleNodes.forEach((node) => {
      const pos = positions.get(node.id);
      if (!pos) return;
      const active = node.id === selectedId;
      const fill = node.folderGroup ? folderColor(node.folderGroup) : nodeColors[node.type] || "#64748b";
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.style.cursor = "pointer";
      group.addEventListener("click", () => {
        selectedId = node.id;
        nodeList.value = node.id;
        render(false);
      });
      group.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        openSourceForNode(node);
      });

      if (active) {
        const glow = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        glow.setAttribute("cx", String(pos.x));
        glow.setAttribute("cy", String(pos.y));
        glow.setAttribute("r", "20");
        glow.setAttribute("fill", fill);
        glow.setAttribute("opacity", "0.22");
        group.appendChild(glow);
      }

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(pos.x));
      circle.setAttribute("cy", String(pos.y));
      circle.setAttribute("r", String(active ? 12 : 9));
      circle.setAttribute("fill", fill);
      circle.setAttribute("stroke", active ? "#58a6ff" : nodeColors[node.type] || "#64748b");
      circle.setAttribute("stroke-width", active ? "3" : "2");
      group.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(pos.x + 14));
      label.setAttribute("y", String(pos.y + 4));
      label.setAttribute("font-size", active ? "12.5" : "11");
      label.setAttribute("font-weight", active ? "700" : "500");
      label.setAttribute("fill", "#c9d1d9");
      label.textContent = nodeLabel(node);
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
      if (openSourceButton) {
        openSourceButton.disabled = true;
      }
      return;
    }
    if (!selectedId) {
      selectedId = activeNode.id;
      nodeList.value = activeNode.id;
    }

    if (openSourceButton) {
      openSourceButton.disabled = !activeNode.sourcePath;
    }

    detailBody.innerHTML =
      `<span class="type-badge" style="${typeBadgeStyle(activeNode.type)}">${escapeHtml(typeLabel(activeNode.type))}</span>` +
      `<div class="detail-title">${escapeHtml(nodeLabel(activeNode))}</div>` +
      (activeNode.displayPath
        ? `<div class="detail-path">${escapeHtml(activeNode.displayPath)}${activeNode.sourceLine ? `:${activeNode.sourceLine}` : ""}</div>`
        : `<div class="detail-path">${escapeHtml(activeNode.id)}</div>`) +
      (activeNode.folderGroup ? `<div class="detail-path">目录组 · ${escapeHtml(activeNode.folderGroup)}</div>` : "") +
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
          `<span class="relation-tag" style="${relationStyle(edge.relation)}">${escapeHtml(relationLabel(edge.relation))} ${direction}</span>` +
          `<div><div class="node-title">${escapeHtml(otherNode ? nodeLabel(otherNode) : otherId)}</div>` +
          `<div class="detail-path">${escapeHtml(otherNode?.displayPath || otherId)}</div></div>` +
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
      "layer=" +
      layerFilter +
      "\ntype=" +
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
      `样本 ${allNodes.length} 节点 · 当前展示 ${visibleNodes.length} 节点 · ${visibleEdges.length} 边`;

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

  if (layerTabs) {
    layerTabs.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("layer-tab")) return;
      layerFilter = target.getAttribute("data-layer") || "all";
      layerTabs.querySelectorAll(".layer-tab").forEach((tab) => tab.classList.remove("active"));
      target.classList.add("active");
      lastLayoutKey = "";
      cachedLayout = null;
      render(false);
    });
  }

  if (openSourceButton) {
    openSourceButton.addEventListener("click", () => {
      const activeNode = allNodes.find((node) => node.id === selectedId);
      openSourceForNode(activeNode);
    });
  }

  document.getElementById("graph-reset").addEventListener("click", () => {
    searchInput.value = "";
    typeFilter.value = "all";
    if (relationFilter) relationFilter.value = "all";
    nodeList.value = "";
    selectedId = "";
    layerFilter = "all";
    if (layerTabs) {
      layerTabs.querySelectorAll(".layer-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.getAttribute("data-layer") === "all");
      });
    }
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
