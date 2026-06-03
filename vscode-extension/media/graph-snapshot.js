(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  let allNodes = [];
  let allEdges = [];
  let selectedId = "";

  const searchInput = document.getElementById("graph-search");
  const typeFilter = document.getElementById("graph-type-filter");
  const nodeList = document.getElementById("graph-node-list");
  const nodeCards = document.getElementById("graph-node-cards");
  const graphSelection = document.getElementById("graph-selection");
  const graphFilterState = document.getElementById("graph-filter-state");
  const svg = document.getElementById("graph-canvas");
  const colors = {
    File: "#1d4ed8",
    Symbol: "#9333ea",
    Module: "#c2410c",
    TaskRun: "#0f766e",
    Decision: "#b91c1c",
    Skill: "#0f766e",
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getVisibleNodes() {
    const term = String(searchInput.value || "")
      .trim()
      .toLowerCase();
    const type = String(typeFilter.value || "all");
    return allNodes.filter((node) => {
      const matchesType = type === "all" || node.type === type;
      const haystack = (node.id + " " + node.type + " " + node.contentPreview).toLowerCase();
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
    nodeCards.innerHTML = "";
    if (visibleNodes.length === 0) {
      nodeCards.innerHTML = '<div class="empty">No nodes match the current filter.</div>';
      return;
    }

    visibleNodes.forEach((node) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "node-item" + (node.id === selectedId ? " active" : "");
      button.innerHTML =
        '<div class="node-meta">' +
        escapeHtml(node.type) +
        "</div>" +
        '<div class="node-title">' +
        escapeHtml(node.id) +
        "</div>" +
        '<div class="node-preview">' +
        escapeHtml(node.contentPreview || "(empty)") +
        "</div>";
      button.addEventListener("click", () => {
        selectedId = node.id;
        nodeList.value = node.id;
        render();
      });
      nodeCards.appendChild(button);
    });
  }

  function renderGraph(visibleNodes, visibleEdges) {
    svg.innerHTML = "";
    const width = 1000;
    const height = 560;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.34;
    const total = Math.max(1, visibleNodes.length);
    const positions = new Map();

    visibleNodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / visibleNodes.length;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * 100 + (Math.random() - 0.5) * 40,
        y: centerY + Math.sin(angle) * 100 + (Math.random() - 0.5) * 40,
        vx: 0,
        vy: 0,
      });
    });

    const iterations = 150;
    const k = 40;
    const repulsion = 4000;

    for (let i = 0; i < iterations; i++) {
      const temp = 1.0 - i / iterations;

      for (let a = 0; a < visibleNodes.length; a++) {
        for (let b = a + 1; b < visibleNodes.length; b++) {
          const p1 = positions.get(visibleNodes[a].id);
          const p2 = positions.get(visibleNodes[b].id);
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

      visibleEdges.forEach((edge) => {
        const p1 = positions.get(edge.from);
        const p2 = positions.get(edge.to);
        if (!p1 || !p2) return;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;

        const force = ((dist * dist) / (k * k)) * 0.1 * temp;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        p1.vx += fx; p1.vy += fy;
        p2.vx -= fx; p2.vy -= fy;
      });

      visibleNodes.forEach((node) => {
        const p = positions.get(node.id);
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
      });
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

    for (const [id, p] of positions.entries()) {
      p.x = centerX + (p.x - centerX) * scale;
      p.y = centerY + (p.y - centerY) * scale;
    }

    visibleEdges.forEach((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return;
      const isActive = selectedId && (edge.from === selectedId || edge.to === selectedId);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(to.x));
      line.setAttribute("y2", String(to.y));
      line.setAttribute("stroke", isActive ? "#d97d54" : "#cbbba7");
      line.setAttribute("stroke-width", isActive ? "2.6" : "1.2");
      line.setAttribute("opacity", isActive ? "1" : "0.75");
      svg.appendChild(line);
    });

    visibleNodes.forEach((node) => {
      const pos = positions.get(node.id);
      if (!pos) return;
      const isActive = node.id === selectedId;
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(pos.x));
      circle.setAttribute("cy", String(pos.y));
      circle.setAttribute("r", isActive ? "11" : "8");
      circle.setAttribute("fill", colors[node.type] || "#64748b");
      circle.setAttribute("stroke", isActive ? "#d97d54" : "#fff");
      circle.setAttribute("stroke-width", isActive ? "3" : "1.5");
      circle.style.cursor = "pointer";
      circle.addEventListener("click", () => {
        selectedId = node.id;
        nodeList.value = node.id;
        render();
      });
      svg.appendChild(circle);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(pos.x + 12));
      text.setAttribute("y", String(pos.y + 4));
      text.setAttribute("font-size", isActive ? "12" : "11");
      text.setAttribute("fill", "#334155");
      text.textContent = node.id.length > 30 ? node.id.slice(0, 29) + "..." : node.id;
      svg.appendChild(text);
    });
  }

  function renderDetail(visibleNodes, visibleEdges) {
    const fallbackNode = visibleNodes[0];
    const activeNode = visibleNodes.find((node) => node.id === selectedId) || fallbackNode;
    if (!activeNode) {
      graphSelection.textContent = "No nodes match the current filter.";
      return;
    }

    if (!selectedId) {
      selectedId = activeNode.id;
      nodeList.value = activeNode.id;
    }

    const relatedEdges = visibleEdges.filter(
      (edge) => edge.from === activeNode.id || edge.to === activeNode.id
    );
    graphSelection.textContent = [
      "node=" + activeNode.id,
      "type=" + activeNode.type,
      "preview=" + (activeNode.contentPreview || "(empty)"),
      "neighbors=" + relatedEdges.length,
      relatedEdges.map((edge) => edge.from + " --" + edge.relation + "--> " + edge.to).join("\n") ||
        "neighbors=(none)",
    ].join("\n");
  }

  function render() {
    const { visibleNodes, visibleEdges } = getRenderable();
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    if (selectedId && !visibleIds.has(selectedId)) {
      selectedId = "";
    }
    graphFilterState.textContent =
      "type=" + typeFilter.value + "\nsearch=" + (searchInput.value || "(none)");
    renderNodeCards(visibleNodes);
    renderGraph(visibleNodes, visibleEdges);
    renderDetail(visibleNodes, visibleEdges);
  }

  searchInput.addEventListener("input", render);
  typeFilter.addEventListener("change", render);
  nodeList.addEventListener("change", () => {
    selectedId = String(nodeList.value || "");
    render();
  });
  document.getElementById("graph-reset").addEventListener("click", () => {
    searchInput.value = "";
    typeFilter.value = "all";
    nodeList.value = "";
    selectedId = "";
    render();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "snapshot" || !message.payload) {
      return;
    }
    allNodes = message.payload.nodes || [];
    allEdges = message.payload.edges || [];
    selectedId = "";
    render();
  });

  if (vscode) {
    vscode.postMessage({ type: "ready" });
  }
})();
