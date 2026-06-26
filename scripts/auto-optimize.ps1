# GraphFlow 自动优化脚本
# 执行时间检查、GraphFlow 分析和前置验证

param(
    [switch]$SkipTimeCheck
)

# 设置编码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

# 1. 时间检查（北京时间）
if (-not $SkipTimeCheck) {
    $now = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, "China Standard Time")
    if ($now.Hour -ge 10) {
        Write-Host "[跳过] 当前时间 $($now.ToString('yyyy-MM-dd HH:mm'))，已超过10点，停止执行。" -ForegroundColor Yellow
        exit 0
    }
    Write-Host "[通过] 当前时间 $($now.ToString('yyyy-MM-dd HH:mm'))，在允许执行时段内。" -ForegroundColor Green
}

# 2. 检查工作区状态（防止并发冲突）
$gitStatus = git status --porcelain 2>$null
if ($gitStatus) {
    Write-Host "[警告] 工作区存在未提交更改，可能上一个任务仍在运行。" -ForegroundColor Yellow
    Write-Host $gitStatus
    Write-Host "[跳过] 本次执行取消，等待工作区清理。" -ForegroundColor Yellow
    exit 0
}
Write-Host "[通过] 工作区干净，无未提交更改。" -ForegroundColor Green

# 3. 确保输出目录存在
New-Item -ItemType Directory -Force -Path "tmp" | Out-Null

# 4. 运行 GraphFlow 上下文分析
Write-Host "`n=== 运行 GraphFlow 上下文分析 ===" -ForegroundColor Cyan
$ctxResult = node dist/surfaces/cli/index.js context preview "项目整体架构、代码质量、潜在改进点和测试覆盖率" --json 2>&1
$ctxResult | Out-File -Encoding UTF8 -FilePath "tmp/graphflow-context.json"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[成功] GraphFlow 上下文分析完成，结果保存至 tmp/graphflow-context.json" -ForegroundColor Green
} else {
    Write-Host "[失败] GraphFlow 上下文分析出错：$ctxResult" -ForegroundColor Red
}

# 5. 运行 GraphFlow 图结构检查
Write-Host "`n=== 运行 GraphFlow 图结构检查 ===" -ForegroundColor Cyan
$graphResult = node dist/surfaces/cli/index.js graph inspect --json 2>&1
$graphResult | Out-File -Encoding UTF8 -FilePath "tmp/graphflow-inspect.json"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[成功] GraphFlow 图结构检查完成，结果保存至 tmp/graphflow-inspect.json" -ForegroundColor Green
} else {
    Write-Host "[失败] GraphFlow 图结构检查出错：$graphResult" -ForegroundColor Red
}

# 6. 运行 ESLint 检查
Write-Host "`n=== 运行 ESLint 代码质量检查 ===" -ForegroundColor Cyan
$lintResult = npm run lint 2>&1
$lintResult | Out-File -Encoding UTF8 -FilePath "tmp/eslint-report.txt"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[成功] ESLint 检查通过，无代码质量问题。" -ForegroundColor Green
} else {
    Write-Host "[发现] ESLint 发现问题，详情见 tmp/eslint-report.txt" -ForegroundColor Yellow
}

# 7. 构建验证
Write-Host "`n=== 运行构建验证 ===" -ForegroundColor Cyan
$buildResult = npm run build 2>&1
$buildResult | Out-File -Encoding UTF8 -FilePath "tmp/build-report.txt"
if ($LASTEXITCODE -eq 0) {
    Write-Host "[成功] 构建通过。" -ForegroundColor Green
} else {
    Write-Host "[失败] 构建失败，详情见 tmp/build-report.txt" -ForegroundColor Red
}

Write-Host "`n[完成] 分析阶段结束，结果保存在 tmp/ 目录。" -ForegroundColor Green
Write-Host "接下来请根据分析结果执行代码改进。" -ForegroundColor Cyan
