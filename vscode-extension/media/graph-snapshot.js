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
