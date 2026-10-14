(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  let skills = [];

  const searchInput = document.getElementById("skill-search");
  const outcomeFilter = document.getElementById("skill-outcome-filter");
  const sortSelect = document.getElementById("skill-sort");
  const tableBody = document.getElementById("skill-table-body");
  const summary = document.getElementById("skill-summary");

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function filteredSkills() {
    const term = String(searchInput.value || "")
      .trim()
      .toLowerCase();
    const outcome = String(outcomeFilter.value || "all");
    const sortBy = String(sortSelect.value || "score");
    return skills
      .filter((skill) => {
        const matchesOutcome = outcome === "all" || skill.lastOutcome === outcome;
        const matchesSearch = !term || (skill.name + " " + skill.id).toLowerCase().includes(term);
        return matchesOutcome && matchesSearch;
      })
      .slice()
      .sort((left, right) => {
        if (sortBy === "uses") return right.uses - left.uses || right.score - left.score;
        if (sortBy === "updatedAt") return right.updatedAt - left.updatedAt;
        if (sortBy === "name") return left.name.localeCompare(right.name);
        return right.score - left.score || right.uses - left.uses;
      });
  }

  function renderSummary(items) {
    const passCount = items.filter((skill) => skill.lastOutcome === "pass").length;
    const failCount = items.filter((skill) => skill.lastOutcome === "fail").length;
    const avgScore = items.length
      ? (items.reduce((sum, item) => sum + item.score, 0) / items.length).toFixed(2)
      : "0.00";
    summary.innerHTML = [
      ["Visible skills", String(items.length)],
      ["Pass / Fail", passCount + " / " + failCount],
      ["Average score", avgScore],
    ]
      .map(
        ([label, value]) =>
          '<div class="summary-card"><div class="label">' +
          label +
          '</div><div class="value">' +
          value +
          "</div></div>"
      )
      .join("");
  }

  function renderTable() {
    const items = filteredSkills();
    renderSummary(items);
    if (items.length === 0) {
      tableBody.innerHTML =
        '<tr><td colspan="5" class="empty">No skills match the current filters.</td></tr>';
      return;
    }
    tableBody.innerHTML = items
      .map((skill) => {
        const scoreClass = skill.score >= 0 ? "score-pass" : "score-fail";
        const updatedAt = skill.updatedAt ? new Date(skill.updatedAt).toLocaleString() : "n/a";
        return (
          "<tr>" +
          '<td><strong>' +
          escapeHtml(skill.name) +
          '</strong><br/><span style="color:#6b7280">' +
          escapeHtml(skill.id) +
          "</span></td>" +
          '<td class="' +
          scoreClass +
          '">' +
          skill.score +
          "</td>" +
          "<td>" +
          skill.uses +
          "</td>" +
          "<td>" +
          escapeHtml(skill.lastOutcome) +
          "</td>" +
          "<td>" +
          escapeHtml(updatedAt) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  searchInput.addEventListener("input", renderTable);
  outcomeFilter.addEventListener("change", renderTable);
  sortSelect.addEventListener("change", renderTable);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "skills" || !message.payload) {
      return;
    }
    skills = message.payload.skills || [];
    renderTable();
  });

  if (vscode) {
    vscode.postMessage({ type: "ready" });
  }
})();
