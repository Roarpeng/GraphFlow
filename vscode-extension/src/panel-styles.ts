/**
 * Shared webview panel styles — Emil Kowalski design-eng principles:
 * ease-out press feedback, property-specific transitions, soft elevation,
 * reduced-motion respect, hover gated to fine pointers.
 */

export const PANEL_EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
export const PANEL_EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

/** Tokens + interaction polish injected into every GraphFlow webview. */
export function sharedPanelCss(theme: "dark" | "light"): string {
  const tokens =
    theme === "dark"
      ? `
    color-scheme: dark;
    --bg: #0b1017;
    --panel: #141b26;
    --panel-soft: #1a2332;
    --ink: #e6edf3;
    --muted: #8b949e;
    --line: rgba(230, 237, 243, 0.1);
    --accent: #3fb950;
    --accent-soft: rgba(63, 185, 80, 0.14);
    --accent-2: #58a6ff;
    --danger: #f85149;
    --warn: #d29922;
    --shadow: 0 1px 0 rgba(255,255,255,0.04), 0 16px 40px rgba(0, 0, 0, 0.35);
    --radius: 14px;
  `
      : `
    color-scheme: light;
    --bg: #f4f6f8;
    --panel: #ffffff;
    --panel-soft: #f8fafc;
    --ink: #0f172a;
    --muted: #64748b;
    --line: rgba(15, 23, 42, 0.1);
    --accent: #0d9488;
    --accent-soft: rgba(13, 148, 136, 0.12);
    --accent-2: #2563eb;
    --danger: #dc2626;
    --warn: #b45309;
    --shadow: 0 1px 0 rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.08);
    --radius: 14px;
  `;

  return `
    :root {
      ${tokens}
      --ease-out: ${PANEL_EASE_OUT};
      --ease-in-out: ${PANEL_EASE_IN_OUT};
      --duration-press: 160ms;
      --duration-ui: 200ms;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif;
      color: var(--ink);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
    }
    button, .pressable, .node-item, .layer-tab, .copy-btn, .advanced-toggle, .work-item summary {
      transition:
        transform var(--duration-press) var(--ease-out),
        background-color var(--duration-ui) ease,
        border-color var(--duration-ui) ease,
        color var(--duration-ui) ease,
        box-shadow var(--duration-ui) ease,
        filter var(--duration-ui) ease,
        opacity var(--duration-ui) var(--ease-out);
    }
    button:active:not(:disabled),
    .pressable:active,
    .node-item:active,
    .layer-tab:active,
    .copy-btn:active {
      transform: scale(0.97);
    }
    @media (hover: hover) and (pointer: fine) {
      button:hover:not(:disabled) { filter: brightness(1.06); }
      .node-item:hover {
        border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
        box-shadow: var(--shadow);
      }
      tbody tr:hover { background: var(--panel-soft); }
    }
    .shell > .panel,
    .shell > .hero,
    .shell > .meta,
    .shell > .toolbar,
    form > .panel {
      transition: opacity var(--duration-ui) var(--ease-out), transform var(--duration-ui) var(--ease-out);
    }
    @supports (transition-behavior: allow-discrete) {
      .shell > .panel,
      .shell > .hero,
      .shell > .meta,
      form > .panel {
        @starting-style {
          opacity: 0;
          transform: scale(0.98);
        }
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
      button:active:not(:disabled),
      .node-item:active,
      .layer-tab:active,
      .copy-btn:active {
        transform: none;
      }
    }
  `;
}
