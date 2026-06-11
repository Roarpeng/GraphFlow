(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  const form = document.getElementById("settings-form");
  const status = document.getElementById("settings-status");
  const networkFields = document.getElementById("settings-enrichment-network-fields");
  const backendSelect = document.getElementById("settings-enrichment-backend");
  const diagnoseList = document.getElementById("settings-diagnose-list");
  const readinessList = document.getElementById("settings-readiness-list");
  const routeTestList = document.getElementById("settings-route-test-list");
  const testRoutingButton = document.getElementById("settings-test-routing");
  const graphReadinessList = document.getElementById("settings-graph-readiness-list");
  const graphIndexList = document.getElementById("settings-graph-index-list");
  const indexGraphButton = document.getElementById("settings-index-graph");

  function getNumber(id) {
    const value = Number(document.getElementById(id).value);
    return Number.isFinite(value) ? value : 0;
  }

  function getString(id) {
    return String(document.getElementById(id).value || "").trim();
  }

  function getChecked(id) {
    return Boolean(document.getElementById(id).checked);
  }

  function collectPayload() {
    return {
      provider: getString("settings-provider"),
      smartModel: getString("settings-smart-model"),
      economyModel: getString("settings-economy-model"),
      apiKeyEnvVar: getString("settings-api-key-env-var"),
      baseUrl: getString("settings-base-url"),
      enrichmentBackend: getString("settings-enrichment-backend") || "inherit",
      enrichmentProvider: getString("settings-enrichment-provider"),
      enrichmentModel: getString("settings-enrichment-model"),
      enrichmentApiKey: getString("settings-enrichment-api-key"),
      enrichmentBaseUrl: getString("settings-enrichment-base-url"),
      openbmbMode: getString("settings-openbmb-mode"),
      openbmbEngine: getString("settings-openbmb-engine"),
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

  function collectGraphIndexIssues(payload) {
    const issues = [];
    if (!payload.graphStorePath) {
      issues.push({ field: "graphStorePath", message: "请填写图谱存储路径" });
    }
    return issues;
  }

  function collectValidationIssues(payload) {
    const issues = [];
    const provider = payload.provider;

    if (!provider) {
      issues.push({ field: "provider", message: "请选择 LLM Provider" });
    }

    if (provider === "openbmb") {
      if (payload.openbmbMode === "embedded" && !payload.openbmbModelPath && !payload.openbmbAutoDownload) {
        issues.push({ field: "openbmbModelPath", message: "本地 OpenBMB 需填写模型路径或勾选自动下载" });
      }
      if (
        (payload.openbmbMode === "ollama" || payload.openbmbMode === "openai-compat") &&
        !payload.openbmbBaseUrl
      ) {
        issues.push({ field: "openbmbBaseUrl", message: "OpenBMB 手动模式需填写 Base URL" });
      }
    } else if (!hasResolvableApiKey(payload.apiKeyEnvVar)) {
      issues.push({ field: "apiKeyEnvVar", message: "请填写可用的 API Key 或环境变量名" });
    }

    if (provider === "openai" && !payload.baseUrl) {
      issues.push({ field: "baseUrl", message: "OpenAI 兼容接口需填写 Base URL" });
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

    return issues;
  }

  function renderGraphReadiness() {
    if (!graphReadinessList || !indexGraphButton) {
      return;
    }

    const issues = collectGraphIndexIssues(collectPayload());
    if (issues.length === 0) {
      graphReadinessList.innerHTML = '<li style="color: #1d4ed8;">✓ 可建立结构图谱（无需 LLM）</li>';
      indexGraphButton.disabled = false;
      return;
    }

    graphReadinessList.innerHTML = issues
      .map((issue) => '<li style="color: #b45309;">✗ ' + issue.message + "</li>")
      .join("");
    indexGraphButton.disabled = true;
  }

  function renderReadiness() {
    renderGraphReadiness();

    if (!readinessList || !testRoutingButton) {
      return;
    }

    const issues = collectValidationIssues(collectPayload());
    if (issues.length === 0) {
      readinessList.innerHTML = '<li style="color: #047857;">✓ 必填项已就绪，可进行路由测试</li>';
      testRoutingButton.disabled = false;
      return;
    }

    readinessList.innerHTML = issues
      .map((issue) => '<li style="color: #b45309;">✗ ' + issue.message + "</li>")
      .join("");
    testRoutingButton.disabled = true;
  }

  function syncEnrichmentFields() {
    if (!networkFields || !backendSelect) {
      return;
    }
    networkFields.style.display = backendSelect.value === "local" ? "none" : "grid";
  }

  backendSelect?.addEventListener("change", () => {
    syncEnrichmentFields();
    renderReadiness();
  });
  syncEnrichmentFields();

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
      status.textContent = "Saved. 可点击下方「建立图谱」或「测试路由并建立图谱」。";
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
