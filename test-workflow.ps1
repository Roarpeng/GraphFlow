# GraphFlow 完整功能测试流程 (PowerShell)
# 测试场景：知识库建立 + context token 节省 + 技能融合 + 任务编排

Write-Host "=== GraphFlow 完整功能测试 ===" -ForegroundColor Cyan
Write-Host ""

# 先编译
Write-Host "⚙️  编译 GraphFlow..." -ForegroundColor Gray
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ 编译失败，退出" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 1. 建立知识库（图索引）
Write-Host "📘 第一步：建立知识库（图索引）..." -ForegroundColor Yellow
npx graphflow graph index .
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 知识库建立完成，查看: tmp/graphflow-graph.json" -ForegroundColor Green
} else {
    Write-Host "✗ 知识库建立失败，退出" -ForegroundColor Red
    exit 1
}
Write-Host ""

# 2. 展示 Token 节省效果
Write-Host "📊 第二步：Context 预览（展示 Token 节省）..." -ForegroundColor Yellow
npx graphflow context preview "refactor planner module and add comprehensive error handling"
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Context 预览完成，查看 Token 预算和节省百分比" -ForegroundColor Green
}
Write-Host ""

# 3. 语义增强（enrichment）
Write-Host "🧠 第三步：语义增强（后台静默补充 Symbol 摘要）..." -ForegroundColor Yellow
npx graphflow graph enrich
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 语义增强完成，Symbol 节点已添加中文摘要" -ForegroundColor Green
}
Write-Host ""

# 4. 技能演化验证
Write-Host "🔧 第四步：技能融合与演化验证..." -ForegroundColor Yellow
npx graphflow learn nightly
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 技能演化完成，查看: tmp/learning-summary.json" -ForegroundColor Green
}
Write-Host ""

# 5. 任务编排（Plan & Brainstorm）
Write-Host "🎯 第五步：任务编排（Planner 生成计划）..." -ForegroundColor Yellow
npx graphflow plan "optimize token compression for large codebases"
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 任务编排完成" -ForegroundColor Green
}
Write-Host ""

# 6. 最终验证：图快照
Write-Host "📈 第六步：图检查（Graph Inspection）..." -ForegroundColor Yellow
npx graphflow graph inspect
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ 图检查完成" -ForegroundColor Green
}
Write-Host ""

Write-Host "=== 所有测试完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "输出文件位置：" -ForegroundColor Cyan
Write-Host "- 知识库: tmp/graphflow-graph.json"
Write-Host "- 学习报告: tmp/learning-summary.json"
Write-Host "- 学习事件: tmp/learning-events.jsonl"
Write-Host ""
Write-Host "接下来可以做的：" -ForegroundColor Cyan
Write-Host "1. 打开 VS Code GraphFlow 扩展命令面板"
Write-Host "2. 运行 'GraphFlow: Enrich Graph Semantics' - 手动触发语义增强"
Write-Host "3. 运行 'GraphFlow: Run Task' - 演示端到端任务执行"
Write-Host "4. Chat 中用 @graphflow /context 或 /plan 命令"
