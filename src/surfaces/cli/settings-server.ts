import http from "node:http";
import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { getGraphFlowSettings, saveGraphFlowSettings } from "./runtime/settings.js";
import { getSettingsPanelStatus } from "./runtime/panel.js";
import type { GraphFlowSettingsInput } from "./runtime/types.js";

export const DEFAULT_SETTINGS_PORT = 5240;
export const DEFAULT_SETTINGS_HOST = "127.0.0.1";

export interface SettingsServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  configPath?: string | undefined;
  openBrowser?: boolean | undefined;
}

export interface SettingsServerInstance {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  stop: () => Promise<void>;
}

let activeServerInstance: SettingsServerInstance | null = null;

/**
 * Cross-platform helper to launch the user's default browser.
 */
export function openBrowser(url: string): void {
  const isCi = process.env.CI === "true" || process.env.CI === "1";
  if (isCi) return;

  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Gracefully ignore failures in headless environments
  }
}

/**
 * Escapes HTML characters for safe template interpolation.
 */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders the standalone modern dark-themed HTML settings web page.
 */
export function renderSettingsHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFlow Settings</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1017;
      --panel: #141b26;
      --panel-soft: #1a2332;
      --ink: #e6edf3;
      --muted: #8b949e;
      --line: rgba(230, 237, 243, 0.12);
      --accent: #3fb950;
      --accent-soft: rgba(63, 185, 80, 0.14);
      --accent-2: #58a6ff;
      --accent-2-soft: rgba(88, 166, 255, 0.14);
      --purple: #bc8cff;
      --purple-soft: rgba(188, 140, 255, 0.14);
      --danger: #f85149;
      --warn: #d29922;
      --shadow: 0 1px 0 rgba(255, 255, 255, 0.04), 0 12px 32px rgba(0, 0, 0, 0.4);
      --radius: 12px;
      --radius-sm: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.5;
      padding: 24px 16px 80px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 820px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    header.hero {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 20px 24px;
      box-shadow: var(--shadow);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--accent-2), var(--purple));
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(88, 166, 255, 0.3);
    }
    .logo-icon svg {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: #ffffff;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -0.02em;
    }
    .subtitle {
      font-size: 13px;
      color: var(--muted);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid rgba(63, 185, 80, 0.25);
      padding: 4px 10px;
      border-radius: 999px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px var(--accent);
    }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      margin-top: 10px;
    }
    .meta-pill {
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 10px;
    }
    .meta-pill strong {
      color: var(--ink);
      font-weight: 600;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 20px 24px;
      box-shadow: var(--shadow);
      display: grid;
      gap: 16px;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px;
      margin-bottom: 4px;
    }
    .panel-header h2 {
      font-size: 16px;
      font-weight: 600;
      color: var(--ink);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .panel-desc {
      font-size: 12px;
      color: var(--muted);
    }
    .tier-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    @media (max-width: 720px) {
      .tier-grid { grid-template-columns: 1fr; }
    }
    .tier-card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 16px;
      background: var(--panel-soft);
      display: grid;
      gap: 12px;
      position: relative;
    }
    .tier-card.smart {
      border-color: rgba(88, 166, 255, 0.3);
      background: linear-gradient(180deg, rgba(88, 166, 255, 0.04), var(--panel-soft));
    }
    .tier-card.economy {
      border-color: rgba(63, 185, 80, 0.3);
      background: linear-gradient(180deg, rgba(63, 185, 80, 0.04), var(--panel-soft));
    }
    .tier-card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tier-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--ink);
    }
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
    }
    .badge.smart {
      background: var(--accent-2);
      color: #0b1017;
    }
    .badge.economy {
      background: var(--accent);
      color: #0b1017;
    }
    .badge.purple {
      background: var(--purple);
      color: #0b1017;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 600px) {
      .grid-2 { grid-template-columns: 1fr; }
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 600px) {
      .grid-3 { grid-template-columns: 1fr; }
    }
    .field {
      display: grid;
      gap: 6px;
    }
    label {
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .field-hint {
      font-size: 11px;
      color: var(--muted);
      margin-top: 2px;
    }
    input[type="text"],
    input[type="password"],
    input[type="number"],
    select {
      width: 100%;
      background: #090d14;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      color: var(--ink);
      font-family: inherit;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input:focus, select:focus {
      border-color: var(--accent-2);
      box-shadow: 0 0 0 3px var(--accent-2-soft);
    }
    .input-with-button {
      display: flex;
      gap: 6px;
    }
    .input-with-button input {
      flex: 1;
    }
    .toggle-group {
      display: grid;
      gap: 10px;
    }
    .switch-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease;
    }
    .switch-label:hover {
      background: rgba(255, 255, 255, 0.03);
    }
    .switch-info {
      display: grid;
      gap: 2px;
    }
    .switch-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--ink);
    }
    .switch-desc {
      font-size: 11px;
      color: var(--muted);
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 40px;
      height: 22px;
      flex-shrink: 0;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #21262d;
      transition: .2s;
      border-radius: 22px;
      border: 1px solid var(--line);
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 2px;
      bottom: 2px;
      background-color: #8b949e;
      transition: .2s;
      border-radius: 50%;
    }
    input:checked + .slider {
      background-color: var(--accent);
      border-color: var(--accent);
    }
    input:checked + .slider:before {
      transform: translateX(18px);
      background-color: #0b1017;
    }
    .radio-cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .radio-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      background: var(--panel-soft);
      cursor: pointer;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .radio-card:hover {
      background: rgba(255, 255, 255, 0.03);
    }
    .radio-card.active {
      border-color: var(--purple);
      background: var(--purple-soft);
    }
    .radio-card input[type="radio"] {
      margin-top: 3px;
    }
    .radio-card-content {
      display: grid;
      gap: 2px;
    }
    .radio-card-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--ink);
    }
    .radio-card-desc {
      font-size: 11px;
      color: var(--muted);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:active {
      transform: scale(0.98);
    }
    .btn-primary {
      background: var(--accent);
      color: #0b1017;
    }
    .btn-primary:hover {
      filter: brightness(1.1);
    }
    .btn-secondary {
      background: var(--panel-soft);
      border-color: var(--line);
      color: var(--ink);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .btn-danger {
      background: transparent;
      border-color: rgba(248, 81, 73, 0.4);
      color: var(--danger);
    }
    .btn-danger:hover {
      background: rgba(248, 81, 73, 0.1);
    }
    .btn-sm {
      padding: 4px 10px;
      font-size: 12px;
    }
    /* Fixed action bar at bottom */
    .bottom-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(20, 27, 38, 0.85);
      backdrop-filter: blur(12px);
      border-top: 1px solid var(--line);
      padding: 12px 24px;
      z-index: 100;
    }
    .bottom-bar-inner {
      max-width: 820px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .toast {
      position: fixed;
      top: 24px;
      right: 24px;
      padding: 12px 18px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      box-shadow: var(--shadow);
      z-index: 1000;
      transform: translateY(-50px);
      opacity: 0;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
    .toast.success {
      background: #1f6feb;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .toast.error {
      background: var(--danger);
      color: #ffffff;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="hero">
      <div class="brand">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24">
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="12" cy="18" r="3" />
            <path d="M8.5 7.5l7 0M7.5 8.5l3.5 7M16.5 8.5l-3.5 7" />
          </svg>
        </div>
        <div>
          <h1>GraphFlow Settings</h1>
          <p class="subtitle">本地知识图谱与上下文编排服务控制台</p>
          <div class="meta-bar">
            <span class="meta-pill">配置路径: <strong id="val-config-path">加载中...</strong></span>
            <span class="meta-pill" id="val-graph-stats">图谱: 0 节点 / 0 边</span>
          </div>
        </div>
      </div>
      <div class="header-actions">
        <div class="status-badge">
          <span class="status-dot"></span>
          <span id="server-status-label">已连接</span>
        </div>
        <button type="button" class="btn btn-danger btn-sm" id="btn-stop-server">停止服务</button>
      </div>
    </header>

    <form id="settings-form">
      <!-- 1. LLM Provider Configuration -->
      <section class="panel">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><path d="M12 6v6l4 2"/></svg>
            LLM Provider 配置
          </h2>
          <span class="panel-desc">Smart 负责复杂规划与综合，Economy 负责快速上下文切片与摘要</span>
        </div>

        <div class="tier-grid">
          <!-- Smart Tier -->
          <div class="tier-card smart">
            <div class="tier-card-head">
              <span class="tier-title">Smart Tier（规划层）</span>
              <span class="badge smart">Smart</span>
            </div>
            <div class="field">
              <label for="smartProvider">Provider</label>
              <select id="smartProvider" name="smartProvider">
                <option value="deepseek">deepseek（推荐）</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="gemini">gemini</option>
                <option value="bailian">bailian（阿里百炼）</option>
                <option value="doubao">doubao（火山方舟）</option>
                <option value="ollama">ollama（本地开源）</option>
              </select>
            </div>
            <div class="field">
              <label for="smartModel">Model</label>
              <input type="text" id="smartModel" name="smartModel" placeholder="deepseek-chat 或 claude-3-7-sonnet" />
            </div>
            <div class="field">
              <label for="smartApiKey">API Key</label>
              <div class="input-with-button">
                <input type="password" id="smartApiKey" name="smartApiKey" placeholder="sk-... 或 \${DEEPSEEK_API_KEY}" />
                <button type="button" class="btn btn-secondary btn-sm" onclick="togglePasswordVisibility('smartApiKey')">显示</button>
              </div>
              <div class="field-hint" id="smartApiKeyStatus"></div>
            </div>
            <div class="field">
              <label for="smartBaseUrl">Base URL（可选）</label>
              <input type="text" id="smartBaseUrl" name="smartBaseUrl" placeholder="https://api.deepseek.com/v1" />
            </div>
          </div>

          <!-- Economy Tier -->
          <div class="tier-card economy">
            <div class="tier-card-head">
              <span class="tier-title">Economy Tier（摘要层）</span>
              <span class="badge economy">Economy</span>
            </div>
            <div class="field">
              <label for="economyProvider">Provider</label>
              <select id="economyProvider" name="economyProvider">
                <option value="deepseek">deepseek（推荐）</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="gemini">gemini</option>
                <option value="bailian">bailian</option>
                <option value="doubao">doubao</option>
                <option value="ollama">ollama</option>
              </select>
            </div>
            <div class="field">
              <label for="economyModel">Model</label>
              <input type="text" id="economyModel" name="economyModel" placeholder="deepseek-chat 或 gpt-4o-mini" />
            </div>
            <div class="field">
              <label for="economyApiKey">API Key</label>
              <div class="input-with-button">
                <input type="password" id="economyApiKey" name="economyApiKey" placeholder="sk-... 或 \${DEEPSEEK_API_KEY}" />
                <button type="button" class="btn btn-secondary btn-sm" onclick="togglePasswordVisibility('economyApiKey')">显示</button>
              </div>
              <div class="field-hint" id="economyApiKeyStatus"></div>
            </div>
            <div class="field">
              <label for="economyBaseUrl">Base URL（可选）</label>
              <input type="text" id="economyBaseUrl" name="economyBaseUrl" placeholder="https://api.deepseek.com/v1" />
            </div>
          </div>
        </div>
      </section>

      <!-- 2. Worker Agent Policy (TypeSafe-JEV & Local-Command) -->
      <section class="panel">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Worker Agent 执行策略
          </h2>
          <span class="panel-desc">配置代码执行 Worker（TypeSafe-JEV 沙箱或本地命令执行器）</span>
        </div>

        <div class="field">
          <label>Worker 类型（Worker Type）</label>
          <div class="radio-cards">
            <label class="radio-card" id="card-worker-local">
              <input type="radio" name="workerType" value="local-command" id="worker-type-local" onchange="updateWorkerTypeUi()" />
              <div class="radio-card-content">
                <div class="radio-card-title">本地命令（local-command）</div>
                <div class="radio-card-desc">在当前环境通过本地命令行安全调用执行</div>
              </div>
            </label>
            <label class="radio-card" id="card-worker-typesafe">
              <input type="radio" name="workerType" value="typesafe-jev" id="worker-type-typesafe" onchange="updateWorkerTypeUi()" />
              <div class="radio-card-content">
                <div class="radio-card-title">TypeSafe-JEV（typesafe-jev）</div>
                <div class="radio-card-desc">TypeSafe-JEV 隔离沙箱与特定模型服务</div>
              </div>
            </label>
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label for="workerProvider">Worker Provider</label>
            <input type="text" id="workerProvider" name="workerProvider" placeholder="openai" />
          </div>
          <div class="field">
            <label for="workerModel">Worker Model</label>
            <input type="text" id="workerModel" name="workerModel" placeholder="jev-latest" />
          </div>
          <div class="field">
            <label for="workerBaseUrl">Worker Base URL</label>
            <input type="text" id="workerBaseUrl" name="workerBaseUrl" placeholder="https://api.typesafe.ai" />
          </div>
          <div class="field">
            <label for="workerApiKey">Worker API Key（可选）</label>
            <input type="password" id="workerApiKey" name="workerApiKey" placeholder="直接填 Key，或填环境变量名（如 TYPESAFE_API_KEY）" />
            <div class="field-hint" id="workerApiKeyStatus"></div>
          </div>
          <div class="field">
            <label for="workerTimeoutMs">Worker 超时（毫秒）</label>
            <input type="number" id="workerTimeoutMs" name="workerTimeoutMs" placeholder="120000" min="1000" />
          </div>
        </div>
      </section>

      <!-- 3. Graph Policy & Context Indexing -->
      <section class="panel">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
            图谱策略与上下文预算
          </h2>
          <span class="panel-desc">控制代码图谱存储、索引范围与 Token 压缩额度</span>
        </div>

        <div class="grid-2">
          <div class="field">
            <label for="maxContextTokens">Max Context Tokens（最大上下文预算）</label>
            <input type="number" id="maxContextTokens" name="maxContextTokens" min="500" placeholder="16000" />
          </div>
          <div class="field">
            <label for="embeddingProvider">向量检索后端（Embedding Provider）</label>
            <select id="embeddingProvider" name="embeddingProvider">
              <option value="fnv">FNV-1a Hash（纯离线，零成本，默认推荐）</option>
              <option value="transformers">transformers（本地语义 Embedding）</option>
            </select>
          </div>
        </div>

        <div class="grid-3">
          <div class="field">
            <label for="layerQuotaL1">L1 锚点配额（核心上下文）</label>
            <input type="number" id="layerQuotaL1" name="layerQuotaL1" min="0" placeholder="6" />
          </div>
          <div class="field">
            <label for="layerQuotaL2">L2 锚点配额（扩展依赖）</label>
            <input type="number" id="layerQuotaL2" name="layerQuotaL2" min="0" placeholder="4" />
          </div>
          <div class="field">
            <label for="layerQuotaL3">L3 锚点配额（概念图谱）</label>
            <input type="number" id="layerQuotaL3" name="layerQuotaL3" min="0" placeholder="3" />
          </div>
        </div>

        <div class="field">
          <label for="graphStorePath">图存储持久化路径（Graph Store Path）</label>
          <input type="text" id="graphStorePath" name="graphStorePath" placeholder="graphflow-out/graphflow-graph.json" />
        </div>

        <div class="toggle-group">
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">索引 Markdown 文件（.md）</div>
              <div class="switch-desc">提取仓库内的文档、规范与架构说明接入图谱</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="indexMarkdown" name="indexMarkdown" />
              <span class="slider"></span>
            </div>
          </label>
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">索引 Office / PDF 文档（anydoc 解析）</div>
              <div class="switch-desc">解析 Word/Excel/PPT/PDF 转化为图谱概念节点</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="indexOfficeDocs" name="indexOfficeDocs" />
              <span class="slider"></span>
            </div>
          </label>
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">保存时自动更新索引（Auto Index on Save）</div>
              <div class="switch-desc">文件保存变更时即时增量索引对应符号</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="autoIndexOnSave" name="autoIndexOnSave" />
              <span class="slider"></span>
            </div>
          </label>
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">近无损上下文压缩模式（Near-Lossless Mode）</div>
              <div class="switch-desc">更高保真度的上下文骨架保留策略</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="enableNearLosslessMode" name="enableNearLosslessMode" />
              <span class="slider"></span>
            </div>
          </label>
        </div>
      </section>

      <!-- 4. Efficiency Policy (SoL-Pi Mechanisms) -->
      <section class="panel">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            SoL-Pi 效率机制
          </h2>
          <span class="panel-desc">深度上下文减负策略，默认建议全部开启</span>
        </div>

        <div class="toggle-group">
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">大输出归档句柄化（Observation Pack）</div>
              <div class="switch-desc">超长工具输出自动封装为轻量 handle，防 prompt 爆炸</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="observationsEnabled" name="observationsEnabled" />
              <span class="slider"></span>
            </div>
          </label>
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">证据保留压缩（Observation Reducer）</div>
              <div class="switch-desc">日志流提炼核心凭据收据，保留可核验状态</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="observationReduceEnabled" name="observationReduceEnabled" />
              <span class="slider"></span>
            </div>
          </label>
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">上下文压力感知与压缩建议（Context Pressure）</div>
              <div class="switch-desc">监控活跃 turn 的 token 压力并自动自适应紧凑策略</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="contextPressureEnabled" name="contextPressureEnabled" />
              <span class="slider"></span>
            </div>
          </label>
          <label class="switch-label">
            <div class="switch-info">
              <div class="switch-title">动作融合（Action Fusion）</div>
              <div class="switch-desc">合并「修改文件 + 执行测试」为单步骤闭环</div>
            </div>
            <div class="switch">
              <input type="checkbox" id="actionFusionEnabled" name="actionFusionEnabled" />
              <span class="slider"></span>
            </div>
          </label>
        </div>
      </section>
    </form>
  </div>

  <!-- Bottom action bar -->
  <div class="bottom-bar">
    <div class="bottom-bar-inner">
      <div style="font-size: 12px; color: var(--muted);" id="save-hint">
        按 <kbd style="background:#21262d;padding:2px 6px;border-radius:4px;border:1px solid var(--line);color:var(--ink);">Ctrl+S</kbd> 或点击保存
      </div>
      <div style="display:flex;gap:10px;">
        <button type="button" class="btn btn-secondary" id="btn-reload">重新加载</button>
        <button type="button" class="btn btn-primary" id="btn-save">保存配置</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let currentSettings = null;

    function showToast(message, type = "success") {
      const toast = document.getElementById("toast");
      toast.textContent = message;
      toast.className = "toast " + type + " show";
      setTimeout(() => {
        toast.className = "toast " + type;
      }, 3500);
    }

    function togglePasswordVisibility(id) {
      const input = document.getElementById(id);
      if (input.type === "password") {
        input.type = "text";
      } else {
        input.type = "password";
      }
    }

    function updateWorkerTypeUi() {
      const isTypesafe = document.getElementById("worker-type-typesafe").checked;
      const cardLocal = document.getElementById("card-worker-local");
      const cardTypesafe = document.getElementById("card-worker-typesafe");
      if (isTypesafe) {
        cardTypesafe.classList.add("active");
        cardLocal.classList.remove("active");
      } else {
        cardLocal.classList.add("active");
        cardTypesafe.classList.remove("active");
      }
    }

    async function loadData() {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        currentSettings = data;

        document.getElementById("val-config-path").textContent = data.configPath || "graphflow.config.json";

        // Providers
        document.getElementById("smartProvider").value = data.smartProvider || data.provider || "deepseek";
        document.getElementById("smartModel").value = data.smartModel || "";
        document.getElementById("smartApiKey").value = data.smartApiKey || data.apiKeyEnvVar || "";
        document.getElementById("smartBaseUrl").value = data.smartBaseUrl || data.baseUrl || "";

        document.getElementById("economyProvider").value = data.economyProvider || data.provider || "deepseek";
        document.getElementById("economyModel").value = data.economyModel || "";
        document.getElementById("economyApiKey").value = data.economyApiKey || data.apiKeyEnvVar || "";
        document.getElementById("economyBaseUrl").value = data.economyBaseUrl || data.baseUrl || "";

        // Worker
        const workerType = data.workerType === "typesafe-jev" ? "typesafe-jev" : "local-command";
        if (workerType === "typesafe-jev") {
          document.getElementById("worker-type-typesafe").checked = true;
        } else {
          document.getElementById("worker-type-local").checked = true;
        }
        updateWorkerTypeUi();
        document.getElementById("workerProvider").value = data.workerProvider || "openai";
        document.getElementById("workerModel").value = data.workerModel || "jev-latest";
        document.getElementById("workerBaseUrl").value = data.workerBaseUrl || "https://api.typesafe.ai";
        document.getElementById("workerApiKey").value = data.workerApiKey || "";
        document.getElementById("workerTimeoutMs").value = data.workerTimeoutMs || 120000;
        renderApiKeyStatus(data.apiKeyStatus || {});

        // Graph policy
        document.getElementById("maxContextTokens").value = data.maxContextTokens || 16000;
        document.getElementById("embeddingProvider").value = data.embeddingProvider || "fnv";
        document.getElementById("layerQuotaL1").value = data.layerQuota?.l1 ?? 6;
        document.getElementById("layerQuotaL2").value = data.layerQuota?.l2 ?? 4;
        document.getElementById("layerQuotaL3").value = data.layerQuota?.l3 ?? 3;
        document.getElementById("graphStorePath").value = data.graphStorePath || "graphflow-out/graphflow-graph.json";

        document.getElementById("indexMarkdown").checked = data.indexMarkdown !== false;
        document.getElementById("indexOfficeDocs").checked = Boolean(data.indexOfficeDocs);
        document.getElementById("autoIndexOnSave").checked = data.autoIndexOnSave !== false;
        document.getElementById("enableNearLosslessMode").checked = Boolean(data.enableNearLosslessMode);

        // Efficiency policy
        document.getElementById("observationsEnabled").checked = data.observationsEnabled !== false;
        document.getElementById("observationReduceEnabled").checked = data.observationReduceEnabled !== false;
        document.getElementById("contextPressureEnabled").checked = data.contextPressureEnabled !== false;
        document.getElementById("actionFusionEnabled").checked = data.actionFusionEnabled !== false;
      } catch (err) {
        showToast("加载配置失败: " + err.message, "error");
      }

      // Optionally fetch status
      try {
        const statusRes = await fetch("/api/status");
        if (statusRes.ok) {
          const status = await statusRes.json();
          document.getElementById("val-graph-stats").textContent =
            "图谱: " + (status.graphNodeCount || 0) + " 节点 / " + (status.graphEdgeCount || 0) + " 边";
        }
      } catch {
        // Status is best-effort
      }
    }

    function renderApiKeyStatus(statuses) {
      const targets = { smart: "smartApiKeyStatus", economy: "economyApiKeyStatus", worker: "workerApiKeyStatus" };
      for (const [tier, id] of Object.entries(targets)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const status = statuses[tier];
        if (!status || status.kind === "empty") {
          el.textContent = "";
        } else if (status.kind === "literal") {
          el.textContent = "已保存明文 Key";
          el.style.color = "";
        } else if (status.resolved) {
          el.textContent = "✓ 已从环境变量 " + status.name + " 读取到 Key";
          el.style.color = "var(--success, #16a34a)";
        } else {
          el.textContent = "✗ 环境变量 " + status.name + " 未读取到值：请检查变量名，或确认已设置在用户/系统环境变量中";
          el.style.color = "var(--danger, #dc2626)";
        }
      }
    }

    async function saveForm() {
      const btn = document.getElementById("btn-save");
      btn.disabled = true;
      btn.textContent = "保存中...";

      try {
        const workerType = document.getElementById("worker-type-typesafe").checked ? "typesafe-jev" : "local-command";
        const payload = {
          smartProvider: document.getElementById("smartProvider").value.trim(),
          smartModel: document.getElementById("smartModel").value.trim(),
          smartApiKey: document.getElementById("smartApiKey").value.trim(),
          smartBaseUrl: document.getElementById("smartBaseUrl").value.trim(),

          economyProvider: document.getElementById("economyProvider").value.trim(),
          economyModel: document.getElementById("economyModel").value.trim(),
          economyApiKey: document.getElementById("economyApiKey").value.trim(),
          economyBaseUrl: document.getElementById("economyBaseUrl").value.trim(),

          workerType: workerType,
          workerProvider: document.getElementById("workerProvider").value.trim(),
          workerModel: document.getElementById("workerModel").value.trim(),
          workerBaseUrl: document.getElementById("workerBaseUrl").value.trim(),
          workerApiKey: document.getElementById("workerApiKey").value.trim(),
          workerTimeoutMs: Number(document.getElementById("workerTimeoutMs").value) || 120000,

          maxContextTokens: Number(document.getElementById("maxContextTokens").value) || 16000,
          embeddingProvider: document.getElementById("embeddingProvider").value,
          layerQuota: {
            l1: Number(document.getElementById("layerQuotaL1").value) || 6,
            l2: Number(document.getElementById("layerQuotaL2").value) || 4,
            l3: Number(document.getElementById("layerQuotaL3").value) || 3,
          },
          graphStorePath: document.getElementById("graphStorePath").value.trim(),

          indexMarkdown: document.getElementById("indexMarkdown").checked,
          indexOfficeDocs: document.getElementById("indexOfficeDocs").checked,
          autoIndexOnSave: document.getElementById("autoIndexOnSave").checked,
          enableNearLosslessMode: document.getElementById("enableNearLosslessMode").checked,

          observationsEnabled: document.getElementById("observationsEnabled").checked,
          observationReduceEnabled: document.getElementById("observationReduceEnabled").checked,
          contextPressureEnabled: document.getElementById("contextPressureEnabled").checked,
          actionFusionEnabled: document.getElementById("actionFusionEnabled").checked,
        };

        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || ("HTTP " + res.status));
        }

        showToast("✓ 配置已保存成功！");
        await loadData();
      } catch (err) {
        showToast("保存失败: " + err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "保存配置";
      }
    }

    async function stopServer() {
      if (!confirm("确定要停止 GraphFlow 配置服务吗？")) return;
      try {
        await fetch("/api/shutdown", { method: "POST" });
        showToast("服务已停止，您可以关闭此网页", "success");
        document.getElementById("server-status-label").textContent = "已停止";
        document.getElementById("server-status-label").style.color = "var(--muted)";
        document.getElementById("btn-stop-server").disabled = true;
      } catch {
        showToast("服务已停止", "success");
      }
    }

    document.getElementById("btn-save").addEventListener("click", saveForm);
    document.getElementById("btn-reload").addEventListener("click", loadData);
    document.getElementById("btn-stop-server").addEventListener("click", stopServer);
    document.getElementById("settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      saveForm();
    });

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveForm();
      }
    });

    document.addEventListener("DOMContentLoaded", loadData);
  </script>
</body>
</html>`;
}

/**
 * Starts the lightweight settings web server.
 * Handles automatic port incrementation (default 5240 -> 5241+),
 * endpoints for HTML UI and JSON settings API, and graceful shutdown.
 */
export async function startSettingsServer(
  options: SettingsServerOptions = {}
): Promise<SettingsServerInstance> {
  const startPort = options.port ?? DEFAULT_SETTINGS_PORT;
  const host = options.host ?? DEFAULT_SETTINGS_HOST;
  const configPath = options.configPath;

  const sockets = new Set<Socket>();

  const requestListener: http.RequestListener = (req, res) => {
    const rawUrl = req.url || "/";
    const parsedUrl = new URL(rawUrl, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // GET /: Modern dark-mode HTML configuration page
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = renderSettingsHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(html);
      return;
    }

    // GET /api/settings: Return current GraphFlow settings
    if (req.method === "GET" && pathname === "/api/settings") {
      try {
        const settings = getGraphFlowSettings(configPath);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(settings));
      } catch (err: unknown) {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to retrieve settings" }));
      }
      return;
    }

    // GET /api/status: Return live index and MCP status
    if (req.method === "GET" && pathname === "/api/status") {
      getSettingsPanelStatus(configPath)
        .then((status) => {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(status));
        })
        .catch((err: unknown) => {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to retrieve status" }));
        });
      return;
    }

    // POST /api/settings: Save submitted JSON settings
    if (req.method === "POST" && pathname === "/api/settings") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) {
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const current = getGraphFlowSettings(configPath);
          const merged: GraphFlowSettingsInput = {
            ...current,
            ...parsed,
            layerQuota: {
              l1: Number(parsed.layerQuota?.l1 ?? current.layerQuota?.l1 ?? 6),
              l2: Number(parsed.layerQuota?.l2 ?? current.layerQuota?.l2 ?? 4),
              l3: Number(parsed.layerQuota?.l3 ?? current.layerQuota?.l3 ?? 3),
            },
            maxContextTokens: Number(parsed.maxContextTokens ?? current.maxContextTokens ?? 16000),
          };
          if (parsed.workerTimeoutMs !== undefined) {
            merged.workerTimeoutMs = Number(parsed.workerTimeoutMs);
          }

          const saved = saveGraphFlowSettings(merged, configPath);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(
            JSON.stringify({
              ok: true,
              message: "Settings saved successfully",
              settings: saved,
              ...saved,
            })
          );
        } catch (err: unknown) {
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Failed to save settings" }));
        }
      });
      return;
    }

    // POST /api/shutdown or /api/stop: Graceful API exit
    if (req.method === "POST" && (pathname === "/api/shutdown" || pathname === "/api/stop")) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: true, message: "Server shutting down" }));
      setTimeout(() => {
        void stopServer(activeInstance);
      }, 50);
      return;
    }

    // Fallback 404
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  };

  // Port search with automatic increment on EADDRINUSE
  let currentPort = startPort;
  let server: http.Server | null = null;
  const maxAttempts = 50;

  while (currentPort < startPort + maxAttempts) {
    const candidateServer = http.createServer(requestListener);
    candidateServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    const bound = await new Promise<boolean>((resolve, reject) => {
      candidateServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          resolve(false);
        } else {
          reject(err);
        }
      });
      candidateServer.listen(currentPort, host, () => {
        resolve(true);
      });
    });

    if (bound) {
      server = candidateServer;
      break;
    }
    currentPort++;
  }

  if (!server) {
    throw new Error(
      `Unable to bind settings server to any port from ${startPort} to ${currentPort}`
    );
  }

  const resolvedPort = currentPort;
  const url = `http://${host}:${resolvedPort}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // Ignore socket destroy errors during shutdown
      }
    }
    sockets.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (activeServerInstance === activeInstance) {
      activeServerInstance = null;
    }
  };

  const activeInstance: SettingsServerInstance = {
    server,
    port: resolvedPort,
    host,
    url,
    stop,
  };

  activeServerInstance = activeInstance;

  // Signal handlers for interactive terminal Ctrl+C
  const onSigint = () => {
    void stop().then(() => {
      process.exit(0);
    });
  };
  const onSigterm = () => {
    void stop().then(() => {
      process.exit(0);
    });
  };

  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }

  // Open default browser if requested (default true when not CI)
  const shouldOpenBrowser =
    options.openBrowser ??
    (process.env.CI !== "true" && process.env.CI !== "1");

  if (shouldOpenBrowser) {
    openBrowser(url);
  }

  return activeInstance;
}

/**
 * Gracefully stops the active settings server instance and releases port.
 */
export async function stopServer(instance?: SettingsServerInstance): Promise<void> {
  const target = instance ?? activeServerInstance;
  if (target) {
    await target.stop();
    if (activeServerInstance === target) {
      activeServerInstance = null;
    }
  }
}
