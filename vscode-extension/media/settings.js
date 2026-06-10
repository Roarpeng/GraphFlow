(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  const form = document.getElementById("settings-form");
  const status = document.getElementById("settings-status");
  const networkFields = document.getElementById("settings-enrichment-network-fields");
  const backendSelect = document.getElementById("settings-enrichment-backend");

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

  function syncEnrichmentFields() {
    if (!networkFields || !backendSelect) {
      return;
    }
    networkFields.style.display = backendSelect.value === "local" ? "none" : "grid";
  }

  backendSelect?.addEventListener("change", syncEnrichmentFields);
  syncEnrichmentFields();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!vscode) {
      status.textContent = "VS Code API unavailable.";
      return;
    }

    status.textContent = "Saving...";
    vscode.postMessage({
      type: "saveSettings",
      payload: {
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
        transport: getString("settings-transport"),
        graphStorePath: getString("settings-graph-store-path"),
      },
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "settingsSaved") {
      status.textContent = "Saved.";
    }
    if (message?.type === "settingsError") {
      status.textContent = "Error: " + message.payload;
    }
  });
})();
