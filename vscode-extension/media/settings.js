(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  const form = document.getElementById("settings-form");
  const status = document.getElementById("settings-status");
  const tierReadinessList = document.getElementById("settings-tier-readiness-list");
  const diagnoseList = document.getElementById("settings-diagnose-list");
  const routeTestList = document.getElementById("settings-route-test-list");
  const testRoutingButton = document.getElementById("settings-test-routing");
  const graphIndexList = document.getElementById("settings-graph-index-list");
  const indexGraphButton = document.getElementById("settings-index-graph");
  const advancedToggle = document.getElementById("settings-advanced-toggle");
  const advancedPanel = document.getElementById("settings-advanced-panel");

  function getNumber(id) {
    const value = Number(document.getElementById(id).value);
    return Number.isFinite(value) ? value : 0;
  }

  function getString(id) {
    const element = document.getElementById(id);
    if (!element) {
      return "";
    }
    return String(element.value || "").trim();
  }

  function getChecked(id) {
    const element = document.getElementById(id);
    return element ? Boolean(element.checked) : false;
  }

  function collectPayload() {
    const smartProvider = getString("settings-smart-provider");
    const economyProvider = getString("settings-economy-provider");
    const smartApiKey = getString("settings-smart-api-key");
    const economyApiKey = getString("settings-economy-api-key");
    const smartModel = getString("settings-smart-model");
    const economyModel = getString("settings-economy-model");
    const smartBaseUrl = getString("settings-smart-base-url");
    const economyBaseUrl = getString("settings-economy-base-url");

    return {
      smartProvider,
      smartApiKey,
      smartModel,
      smartBaseUrl,
      economyProvider,
      economyApiKey,
      economyModel,
      economyBaseUrl,
      provider: smartProvider,
      apiKeyEnvVar: smartApiKey,
      baseUrl: smartBaseUrl,
      enrichmentBackend: getString("settings-enrichment-backend") || "inherit",
      enrichmentProvider: getString("settings-enrichment-provider"),
      enrichmentModel: getString("settings-enrichment-model"),
      enrichmentApiKey: getString("settings-enrichment-api-key"),
      enrichmentBaseUrl: getString("settings-enrichment-base-url"),
      openbmbMode: getString("settings-openbmb-mode") || "embedded",
      openbmbEngine: getString("settings-openbmb-engine") || "command",
      openbmbModel: getString("settings-openbmb-model"),
      openbmbBaseUrl: getString("settings-openbmb-base-url"),
      openbmbModelPath: getString("settings-openbmb-model-path"),
      openbmbCommandPath: getString("settings-openbmb-command-path"),
      openbmbAutoDownload: getChecked("settings-openbmb-auto-download"),
      openbmbModelUrl: getString("settings-openbmb-model-url"),
      openbmbModelSha256: getString("settings-openbmb-model-sha256"),
      maxContextTokens: getNumber("settings-max-context-tokens"),
      layerQuota: {
        l1: getNumber("settings-layer-l1"),
        l2: getNumber("settings-layer-l2"),
        l3: getNumber("settings-layer-l3"),
      },
      enableNearLosslessMode: getChecked("settings-enable-near-lossless"),
      autoIndexOnPreview: getChecked("settings-auto-index-preview"),
      autoIndexOnRun: getChecked("settings-auto-index-run"),
      autoIndexOnSave: getChecked("settings-auto-index-save"),
      autoRunOnIndex: getChecked("settings-auto-run-on-index"),
      transport: getString("settings-transport"),
      graphStorePath: getString("settings-graph-store-path"),
    };
  }

  function hasResolvableApiKey(value) {
    if (!value) {
      return false;
    }
    if (/^sk-[A-Za-z0-9_-]{8,}$/.test(value)) {
      return true;
    }
    return /^[A-Z][A-Z0-9_]*$/.test(value);
  }

  function tierSnapshot(tier) {
    const prefix = tier === "smart" ? "smart" : "economy";
    return {
      provider: getString(`settings-${prefix}-provider`),
      apiKey: getString(`settings-${prefix}-api-key`),
      model: getString(`settings-${prefix}-model`),
      baseUrl: getString(`settings-${prefix}-base-url`),
      label: tier === "smart" ? "Smart" : "Economy",
    };
  }

  function tierIsConfigured(tier) {
    return Boolean(tier.provider && tier.model);
  }

  function collectGraphIndexIssues(payload) {
    const issues = [];
    if (!payload.graphStorePath) {
      issues.push({ field: "graphStorePath", message: "请填写图谱存储路径" });
    }
    return issues;
  }

  function collectTierIssues(tier, payload) {
    const issues = [];
    const prefix = tier === "smart" ? "smart" : "economy";
    const snapshot = tierSnapshot(tier);
    const label = snapshot.label;

    if (!snapshot.provider) {
      if (snapshot.apiKey || snapshot.model) {
        issues.push({ field: `${prefix}Provider`, message: `请为 ${label} 层选择 Provider` });
      }
      return issues;
    }

    if (!snapshot.model) {
      if (snapshot.provider || snapshot.apiKey) {
        issues.push({ field: `${prefix}Model`, message: `请填写 ${label} 层模型` });
      }
      return issues;
    }

    if (snapshot.provider === "openbmb") {
      if (payload.openbmbMode === "embedded" && !payload.openbmbModelPath && !payload.openbmbAutoDownload) {
        issues.push({ field: "openbmbModelPath", message: `${label} 层使用 OpenBMB 时需填写模型路径或勾选自动下载` });
      }
      if (
        (payload.openbmbMode === "ollama" || payload.openbmbMode === "openai-compat") &&
        !payload.openbmbBaseUrl
      ) {
        issues.push({ field: "openbmbBaseUrl", message: `${label} 层 OpenBMB 手动模式需填写 Base URL` });
      }
      return issues;
    }

    if (!hasResolvableApiKey(snapshot.apiKey)) {
      issues.push({ field: `${prefix}ApiKey`, message: `请为 ${label} 层填写可用的 API Key 或环境变量名` });
    }

    if (snapshot.provider === "openai" && !snapshot.baseUrl) {
      issues.push({
        field: `${prefix}BaseUrl`,
        message: `${label} 层 OpenAI 兼容接口需填写 Base URL（可在高级选项中覆盖）`,
      });
    }

    return issues;
  }

  function collectValidationIssues(payload) {
    const issues = [
      ...collectTierIssues("smart", payload),
      ...collectTierIssues("economy", payload),
    ];

    if (!tierIsConfigured(tierSnapshot("smart")) && !tierIsConfigured(tierSnapshot("economy"))) {
      issues.push({
        field: "smartProvider",
        message: "请至少完整配置 Smart 或 Economy 一层（Provider、API Key、Model）",
      });
    }

    if (!payload.graphStorePath) {
      issues.push({ field: "graphStorePath", message: "请填写图谱存储路径" });
    }
    if (!payload.enableNearLosslessMode) {
      issues.push({ field: "enableNearLosslessMode", message: "请开启 near-lossless 上下文压缩" });
    }
    if (!payload.autoIndexOnPreview) {
      issues.push({ field: "autoIndexOnPreview", message: "请开启 Auto index on preview" });
    }
    if (!payload.autoIndexOnRun) {
      issues.push({ field: "autoIndexOnRun", message: "请开启 Auto index on run" });
    }
    if (!payload.autoIndexOnSave) {
      issues.push({ field: "autoIndexOnSave", message: "请开启 Auto index on file save" });
    }

    return issues;
  }

  function renderTierReadiness() {
    if (!tierReadinessList) {
      return;
    }

    const payload = collectPayload();
    const lines = [];
    for (const tier of ["smart", "economy"]) {
      const snapshot = tierSnapshot(tier);
      if (tierIsConfigured(snapshot) && hasResolvableApiKey(snapshot.apiKey)) {
        lines.push(`<li style="color: #047857;">✓ ${snapshot.label} 层：${snapshot.provider} / ${snapshot.model}</li>`);
      } else if (snapshot.provider || snapshot.model || snapshot.apiKey) {
        lines.push(`<li style="color: #b45309;">○ ${snapshot.label} 层：未完成配置</li>`);
      } else {
        lines.push(`<li>○ ${snapshot.label} 层：未配置</li>`);
      }
    }

    if (payload.graphStorePath) {
      lines.push('<li style="color: #047857;">✓ 图谱路径：已填写</li>');
    } else {
      lines.push('<li style="color: #b45309;">○ 图谱路径：未填写</li>');
    }

    tierReadinessList.innerHTML = lines.join("");
  }

  function renderReadiness() {
    renderTierReadiness();

    if (!testRoutingButton) {
      return;
    }

    const issues = collectValidationIssues(collectPayload());
    testRoutingButton.disabled = issues.length > 0;

    if (indexGraphButton) {
      const graphIssues = collectGraphIndexIssues(collectPayload());
      indexGraphButton.disabled = graphIssues.length > 0;
    }
  }

  advancedToggle?.addEventListener("click", () => {
    if (!advancedPanel || !advancedToggle) {
      return;
    }
    const open = advancedPanel.classList.toggle("open");
    advancedToggle.textContent = open
      ? "▾ 高级选项：Max Context Tokens · L1/L2/L3 Anchors · Base URL 覆盖"
      : "▸ 高级选项：Max Context Tokens · L1/L2/L3 Anchors · Base URL 覆盖";
  });

  form?.addEventListener("input", renderReadiness);
  form?.addEventListener("change", renderReadiness);
  renderReadiness();

  indexGraphButton?.addEventListener("click", () => {
    if (!vscode) {
      status.textContent = "VS Code API unavailable.";
      return;
    }

    const issues = collectGraphIndexIssues(collectPayload());
    if (issues.length > 0) {
      status.textContent = "请先填写图谱存储路径。";
      renderReadiness();
      return;
    }

    status.textContent = "正在建立知识图谱（结构索引，无需 LLM）...";
    indexGraphButton.disabled = true;
    if (graphIndexList) {
      graphIndexList.style.display = "none";
      graphIndexList.innerHTML = "";
    }
    vscode.postMessage({ type: "indexGraphOnly", payload: collectPayload() });
  });

  testRoutingButton?.addEventListener("click", () => {
    if (!vscode) {
      status.textContent = "VS Code API unavailable.";
      return;
    }

    const issues = collectValidationIssues(collectPayload());
    if (issues.length > 0) {
      status.textContent = "请先完成必填配置。";
      renderReadiness();
      return;
    }

    status.textContent = "正在测试路由连通性并建立图谱...";
    testRoutingButton.disabled = true;
    if (routeTestList) {
      routeTestList.style.display = "none";
      routeTestList.innerHTML = "";
    }
    vscode.postMessage({ type: "testRoutingAndIndex", payload: collectPayload() });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!vscode) {
      status.textContent = "VS Code API unavailable.";
      return;
    }

    status.textContent = "Saving...";
    vscode.postMessage({
      type: "saveSettings",
      payload: collectPayload(),
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;

    if (message?.type === "graphIndexResult") {
      const result = message.payload || {};
      indexGraphButton.disabled = false;
      renderReadiness();

      if (graphIndexList) {
        graphIndexList.style.display = "block";
        const lines = [];
        if (result.graphIndex) {
          lines.push(
            "<li>✓ 结构图谱索引完成：files=" +
              result.graphIndex.indexedFiles +
              "; symbols=" +
              result.graphIndex.indexedSymbols +
              "</li>"
          );
        }
        if (result.graphSnapshot) {
          lines.push(
            "<li>✓ 图谱规模：" +
              result.graphSnapshot.nodeCount +
              " 节点 / " +
              result.graphSnapshot.edgeCount +
              " 边</li>"
          );
        }
        if (lines.length === 0 && result.validationIssues?.length) {
          for (const issue of result.validationIssues) {
            lines.push("<li>✗ " + issue.message + "</li>");
          }
        }
        graphIndexList.innerHTML = lines.join("");
      }

      status.textContent = result.ok
        ? "知识图谱已建立（结构索引）。配置 LLM 后可启用语义提取以增强效果。"
        : "建立图谱失败，请检查图谱存储路径与写入权限。";
    }

    if (message?.type === "routingTestResult") {
      const result = message.payload || {};
      testRoutingButton.disabled = false;
      renderReadiness();

      if (result.diagnosisSummary && diagnoseList) {
        diagnoseList.innerHTML = String(result.diagnosisSummary)
          .split("; ")
          .map((line) => "<li>" + line + "</li>")
          .join("");
      }

      if (routeTestList) {
        routeTestList.style.display = "block";
        const lines = [];
        for (const probe of result.probes || []) {
          const mark = probe.ok ? "✓" : "✗";
          const latency = probe.latencyMs !== undefined ? probe.latencyMs + "ms" : "";
          const detail = probe.ok ? probe.sample || "ok" : probe.error || "failed";
          lines.push(
            "<li>" +
              mark +
              " " +
              probe.role +
              " " +
              probe.provider +
              "/" +
              probe.model +
              " " +
              latency +
              " — " +
              detail +
              "</li>"
          );
        }
        if (result.graphIndex) {
          lines.push(
            "<li>✓ 图谱索引完成：files=" +
              result.graphIndex.indexedFiles +
              "; symbols=" +
              result.graphIndex.indexedSymbols +
              "</li>"
          );
        }
        if (result.graphSnapshot) {
          lines.push(
            "<li>✓ 图谱规模：" +
              result.graphSnapshot.nodeCount +
              " 节点 / " +
              result.graphSnapshot.edgeCount +
              " 边</li>"
          );
        }
        routeTestList.innerHTML = lines.join("");
      }

      status.textContent = result.ok
        ? "路由连通性 OK，知识图谱已建立。"
        : "路由测试未通过，请检查配置与 API Key。";
    }

    if (message?.type === "settingsSaved") {
      status.textContent = "已保存。可点击「建立图谱」或「测试路由」。";
      renderReadiness();
    }
    if (message?.type === "settingsError") {
      status.textContent = "Error: " + message.payload;
      testRoutingButton.disabled = false;
      indexGraphButton.disabled = false;
      renderReadiness();
    }
  });
})();
