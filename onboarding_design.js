// Pencil batch_design — GraphFlow Settings (simplified onboarding v2)
// Dual-provider LLM: Smart tier + Economy tier, each with Provider / API Key / Model

pos = FindEmptySpace({ width: 980, height: 1850, direction: "bottom", padding: 80 })
screen = Insert(document, {
  type: "frame",
  name: "GraphFlow Settings Onboarding",
  x: pos.x,
  y: pos.y,
  width: 980,
  height: 1850,
  layout: "vertical",
  fill: "#f4efe6",
  padding: 16,
  gap: 12,
  clip: true,
  placeholder: true,
})

// Header
header = Insert(screen, {
  type: "frame",
  name: "Header Panel",
  layout: "vertical",
  width: "fill_container",
  fill: "#fffaf2",
  padding: 14,
  cornerRadius: 16,
  stroke: "#d8c9b7",
  strokeWidth: 1,
  gap: 10,
})
Insert(header, { type: "text", name: "Title", content: "GraphFlow 初次配置", fontSize: 22, fontWeight: "700", fill: "#1f2937" })
Insert(header, {
  type: "text",
  name: "Config Path",
  content: "配置保存至 ~/.graphflow.config.json · 一次配置，所有项目可用",
  fontSize: 12,
  fill: "#6d7f88",
  textGrowth: "fixed-width",
  width: "fill_container",
})
metrics = Insert(header, { type: "frame", name: "Status Metrics", layout: "horizontal", width: "fill_container", gap: 10 })
for (const m of [
  { l: "Extension", v: "v0.6.9" },
  { l: "图谱规模", v: "0 节点 / 0 边" },
  { l: "上次索引", v: "尚未索引" },
]) {
  card = Insert(metrics, {
    type: "frame",
    name: m.l,
    layout: "vertical",
    fill: "#ffffff",
    padding: 10,
    cornerRadius: 12,
    stroke: "#d8c9b7",
    strokeWidth: 1,
    width: "fill_container",
  })
  Insert(card, { type: "text", name: "Label", content: m.l, fontSize: 11, fill: "#6d7f88" })
  Insert(card, { type: "text", name: "Value", content: m.v, fontSize: 14, fontWeight: "700", fill: "#1f2937" })
}
flowBox = Insert(header, {
  type: "frame",
  name: "Setup Flow",
  layout: "vertical",
  width: "fill_container",
  fill: "#fdf5eb",
  padding: 14,
  cornerRadius: 12,
  stroke: "#d8c9b7",
  strokeWidth: 1,
  gap: 8,
})
Insert(flowBox, { type: "text", name: "Title", content: "快速上手", fontSize: 14, fontWeight: "700", fill: "#b45309" })
for (const step of [
  "1. 填写图谱存储路径，点击「建立图谱」—— 无需 LLM 即可索引代码结构。",
  "2. （可选）配置 Smart / Economy 两层模型，分别用于规划推理与轻量摘要。",
  "3. 保存后运行「测试路由」，验证模型连通性并可选语义增强。",
]) {
  Insert(flowBox, { type: "text", name: "Step", content: step, fontSize: 13, fill: "#213547", textGrowth: "fixed-width", width: "fill_container" })
}
Insert(flowBox, {
  type: "text",
  name: "MCP Hint",
  content: "提示：API Key 可填环境变量名（如 DEEPSEEK_API_KEY）或直接填 sk-...",
  fontSize: 12,
  fill: "#6d7f88",
  textGrowth: "fixed-width",
  width: "fill_container",
})

// Dual-tier LLM
llmPanel = Insert(screen, {
  type: "frame",
  name: "LLM Config Panel",
  layout: "vertical",
  width: "fill_container",
  fill: "#fffaf2",
  padding: 14,
  cornerRadius: 16,
  stroke: "#d8c9b7",
  strokeWidth: 1,
  gap: 12,
})
Insert(llmPanel, { type: "text", name: "Title", content: "LLM 配置（可选）", fontSize: 16, fontWeight: "700", fill: "#1f2937" })
Insert(llmPanel, {
  type: "text",
  name: "Desc",
  content: "Smart 用于规划与复杂推理；Economy 用于语义摘要与轻量任务。两层可独立选择 Provider、API Key 与模型。",
  fontSize: 12,
  fill: "#6d7f88",
  textGrowth: "fixed-width",
  width: "fill_container",
})
tierRow = Insert(llmPanel, { type: "frame", name: "Tier Row", layout: "horizontal", width: "fill_container", gap: 12 })
for (const tier of [
  {
    name: "Smart 层",
    badge: "规划 / 推理",
    provider: "openai",
    key: "DEEPSEEK_API_KEY",
    model: "deepseek-reasoner",
    accent: "#7c3aed",
    bg: "#faf5ff",
    border: "#ddd6fe",
  },
  {
    name: "Economy 层",
    badge: "摘要 / 轻量",
    provider: "openai",
    key: "DEEPSEEK_API_KEY",
    model: "deepseek-chat",
    accent: "#0f766e",
    bg: "#f0fdfa",
    border: "#99f6e4",
  },
]) {
  card = Insert(tierRow, {
    type: "frame",
    name: tier.name,
    layout: "vertical",
    width: "fill_container",
    fill: tier.bg,
    padding: 12,
    cornerRadius: 14,
    stroke: tier.border,
    strokeWidth: 1,
    gap: 10,
  })
  head = Insert(card, { type: "frame", name: "Header", layout: "horizontal", width: "fill_container", justifyContent: "space_between", alignItems: "center" })
  Insert(head, { type: "text", name: "Title", content: tier.name, fontSize: 14, fontWeight: "700", fill: "#1f2937" })
  badge = Insert(head, { type: "frame", name: "Badge", padding: 4, cornerRadius: 999, fill: tier.accent })
  Insert(badge, { type: "text", name: "Text", content: tier.badge, fontSize: 10, fontWeight: "600", fill: "#ffffff" })
  for (const f of [
    { l: "Provider", v: tier.provider },
    { l: "API Key", v: tier.key },
    { l: "Model", v: tier.model },
  ]) {
    field = Insert(card, { type: "frame", name: f.l, layout: "vertical", gap: 6, width: "fill_container" })
    Insert(field, { type: "text", name: "Label", content: f.l, fontSize: 12, fill: "#6d7f88" })
    input = Insert(field, {
      type: "frame",
      name: "Input",
      height: 36,
      fill: "#ffffff",
      stroke: "#d8c9b7",
      strokeWidth: 1,
      cornerRadius: 10,
      width: "fill_container",
      padding: 10,
      justifyContent: "center",
    })
    Insert(input, { type: "text", name: "Value", content: f.v, fontSize: 14, fill: "#213547" })
  }
  Insert(card, {
    type: "text",
    name: "Hint",
    content: "Base URL 随 Provider 自动填充，可在高级选项中覆盖",
    fontSize: 11,
    fill: "#6d7f88",
    textGrowth: "fixed-width",
    width: "fill_container",
  })
}

// Graph + index
graphPanel = Insert(screen, {
  type: "frame",
  name: "Graph and Index Panel",
  layout: "vertical",
  width: "fill_container",
  fill: "#fffaf2",
  padding: 14,
  cornerRadius: 16,
  stroke: "#d8c9b7",
  strokeWidth: 1,
  gap: 10,
})
Insert(graphPanel, { type: "text", name: "Title", content: "图谱与索引", fontSize: 16, fontWeight: "700", fill: "#1f2937" })
Insert(graphPanel, {
  type: "text",
  name: "Desc",
  content: "无需 LLM 即可建立结构图谱。语义摘要依赖 Economy 层配置。",
  fontSize: 12,
  fill: "#6d7f88",
  textGrowth: "fixed-width",
  width: "fill_container",
})
grid = Insert(graphPanel, { type: "frame", name: "Graph Grid", layout: "horizontal", width: "fill_container", gap: 12 })
col1 = Insert(grid, { type: "frame", name: "Col 1", layout: "vertical", width: "fill_container", gap: 12 })
col2 = Insert(grid, { type: "frame", name: "Col 2", layout: "vertical", width: "fill_container", gap: 12 })
for (const pair of [
  [col1, [{ l: "Graph Store Path", v: "./.graphflow/graph.db" }]],
  [col2, [{ l: "Transport", v: "file" }]],
]) {
  col = pair[0]
  for (const f of pair[1]) {
    field = Insert(col, { type: "frame", name: f.l, layout: "vertical", gap: 6, width: "fill_container" })
    Insert(field, { type: "text", name: "Label", content: f.l, fontSize: 12, fill: "#6d7f88" })
    input = Insert(field, {
      type: "frame",
      name: "Input",
      height: 36,
      fill: "#ffffff",
      stroke: "#d8c9b7",
      strokeWidth: 1,
      cornerRadius: 10,
      width: "fill_container",
      padding: 10,
      justifyContent: "center",
    })
    Insert(input, { type: "text", name: "Value", content: f.v, fontSize: 14, fill: "#213547" })
  }
}
opts = Insert(graphPanel, { type: "frame", name: "Index Options", layout: "vertical", width: "fill_container", gap: 8 })
for (const c of ["保存文件后自动索引（防抖）", "索引完成后自动语义提取（使用 Economy 层）"]) {
  row = Insert(opts, { type: "frame", name: c, layout: "horizontal", gap: 8, alignItems: "center", width: "fill_container" })
  Insert(row, { type: "rectangle", name: "Checkbox", width: 16, height: 16, cornerRadius: 4, stroke: "#d8c9b7", strokeWidth: 1, fill: "#ffffff" })
  Insert(row, { type: "text", name: "Label", content: c, fontSize: 13, fill: "#213547" })
}
adv = Insert(graphPanel, { type: "frame", name: "Advanced Toggle", layout: "horizontal", gap: 6, alignItems: "center" })
Insert(adv, {
  type: "text",
  name: "Link",
  content: "▸ 高级选项：Max Context Tokens · L1/L2/L3 Anchors · Base URL 覆盖",
  fontSize: 12,
  fill: "#6d7f88",
})
indexBtn = Insert(graphPanel, {
  type: "frame",
  name: "Index Button",
  fill: "#1d4ed8",
  padding: 10,
  cornerRadius: 12,
  justifyContent: "center",
  alignItems: "center",
  width: 180,
})
Insert(indexBtn, { type: "text", name: "Label", content: "建立图谱（无需 LLM）", fontSize: 14, fontWeight: "600", fill: "#ffffff" })

// Routing status
routePanel = Insert(screen, {
  type: "frame",
  name: "Routing Test Panel",
  layout: "vertical",
  width: "fill_container",
  fill: "#ecfdf5",
  padding: 14,
  cornerRadius: 16,
  stroke: "#6ee7b7",
  strokeWidth: 1,
  gap: 10,
})
Insert(routePanel, { type: "text", name: "Title", content: "路由连通性测试（可选）", fontSize: 16, fontWeight: "700", fill: "#047857" })
Insert(routePanel, {
  type: "text",
  name: "Desc",
  content: "配置 Smart / Economy 任一层后，可一键测试模型连通性；通过后自动索引并可选语义增强。",
  fontSize: 12,
  fill: "#334155",
  textGrowth: "fixed-width",
  width: "fill_container",
})
Insert(routePanel, { type: "text", name: "Snapshot", content: "当前状态：尚未测试", fontSize: 11, fill: "#6d7f88" })
for (const item of ["○ Smart 层：未配置", "○ Economy 层：未配置", "✓ 图谱路径：已填写"]) {
  Insert(routePanel, { type: "text", name: "Check", content: item, fontSize: 12, fill: "#334155" })
}

// Bottom actions
actionRow = Insert(screen, { type: "frame", name: "Action Row", layout: "horizontal", width: "fill_container", gap: 10, alignItems: "center" })
saveBtn = Insert(actionRow, {
  type: "frame",
  name: "Save Button",
  fill: "#116466",
  padding: 10,
  cornerRadius: 12,
  justifyContent: "center",
  alignItems: "center",
  width: 140,
})
Insert(saveBtn, { type: "text", name: "Label", content: "Save Settings", fontSize: 14, fontWeight: "600", fill: "#ffffff" })
routeBtn = Insert(actionRow, {
  type: "frame",
  name: "Route Button",
  fill: "#047857",
  padding: 10,
  cornerRadius: 12,
  justifyContent: "center",
  alignItems: "center",
  width: 120,
})
Insert(routeBtn, { type: "text", name: "Label", content: "测试路由", fontSize: 14, fontWeight: "600", fill: "#ffffff" })

Update(screen, { placeholder: false })
