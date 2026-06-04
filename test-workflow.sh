#!/bin/bash

# GraphFlow 完整功能测试流程
# 测试场景：知识库建立 + context token 节省 + 技能融合 + 任务编排

set -e

echo "=== GraphFlow 完整功能测试 ==="
echo ""

# 先编译
echo "⚙️  编译 GraphFlow..."
npm run build
echo ""

# 1. 建立知识库（图索引）
echo "📘 第一步：建立知识库（图索引）..."
npx graphflow graph index .
echo "✓ 知识库建立完成，查看: tmp/graphflow-graph.json"
echo ""

# 2. 展示 Token 节省效果
echo "📊 第二步：Context 预览（展示 Token 节省）..."
npx graphflow context preview "refactor planner module and add comprehensive error handling"
echo "✓ Context 预览完成，查看 Token 预算和节省百分比"
echo ""

# 3. 语义增强（enrichment）
echo "🧠 第三步：语义增强（后台静默补充 Symbol 摘要）..."
npx graphflow graph enrich
echo "✓ 语义增强完成，Symbol 节点已添加中文摘要"
echo ""

# 4. 技能演化验证
echo "🔧 第四步：技能融合与演化验证..."
npx graphflow learn nightly
echo "✓ 技能演化完成，查看: tmp/learning-summary.json"
echo ""

# 5. 任务编排（Plan & Brainstorm）
echo "🎯 第五步：任务编排（Planner 生成计划）..."
npx graphflow plan "optimize token compression for large codebases"
echo "✓ 任务编排完成"
echo ""

# 6. 最终验证：图快照
echo "📈 第六步：图检查（Graph Inspection）..."
npx graphflow graph inspect
echo "✓ 图检查完成"
echo ""

echo "=== 所有测试完成 ==="
echo ""
echo "输出文件位置："
echo "- 知识库: tmp/graphflow-graph.json"
echo "- 学习报告: tmp/learning-summary.json"
echo "- 学习事件: tmp/learning-events.jsonl"
echo ""
echo "接下来可以做的："
echo "1. 打开 VS Code GraphFlow 扩展命令面板"
echo "2. 运行 'GraphFlow: Enrich Graph Semantics' - 手动触发语义增强"
echo "3. 运行 'GraphFlow: Run Task' - 演示端到端任务执行"
echo "4. Chat 中用 @graphflow /context 或 /plan 命令"
