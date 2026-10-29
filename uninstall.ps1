#Requires -Version 5.1
<#
    codebuddy-conversation-branch  卸载（Windows）
      1. 用 backup/ 里最新的备份恢复 CodeBuddy 的 genie 扩展
      2. 删除本地扩展
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }

# ---------- 1. 恢复补丁 ----------
Write-Step '恢复 CodeBuddy 原始文件'
$target = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js'),
    (Join-Path $env:ProgramFiles   'CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js'),
    (Join-Path ${env:ProgramFiles(x86)} 'CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$bak = Get-ChildItem -Path (Join-Path $root 'backup') -Filter 'genie-index-*.js' -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $target) {
    Write-Host '找不到 CodeBuddy 安装目录，跳过恢复。' -ForegroundColor Yellow
} elseif (-not $bak) {
    Write-Host '找不到备份文件（backup\genie-index-*.js），无法自动恢复。' -ForegroundColor Yellow
    Write-Host '请手动重装 CodeBuddy，或从你自己的备份恢复。' -ForegroundColor Yellow
} else {
    Copy-Item -LiteralPath $bak.FullName -Destination $target -Force
    Write-Ok ('已从 ' + $bak.Name + ' 恢复')
}

# ---------- 2. 删除扩展 ----------
Write-Step '删除扩展'
$extDir = Join-Path $env:USERPROFILE '.codebuddycn\extensions\local.codebuddy-branch-0.1.0'
if (Test-Path -LiteralPath $extDir) {
    Remove-Item -LiteralPath $extDir -Recurse -Force
    Write-Ok '已删除 ' + $extDir
} else {
    Write-Ok '扩展目录不存在，跳过'
}

Write-Host ''
Write-Host '卸载完成，请重新启动 CodeBuddy。' -ForegroundColor Green
