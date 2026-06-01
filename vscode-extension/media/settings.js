(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  const form = document.getElementById("settings-form");
  const status = document.getElementById("settings-status");

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
