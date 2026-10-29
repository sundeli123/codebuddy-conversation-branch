#Requires -Version 5.1
<#
    codebuddy-conversation-branch  一键安装（Windows）

    做三件事：
      1. 给 CodeBuddy IDE 自带的 genie 扩展打一个小补丁（让它能自动导入"待导入归档"）
      2. 把本地扩展复制到 CodeBuddy 的扩展目录
      3. 提示重启

    用法：
      powershell -ExecutionPolicy Bypass -File .\install.ps1
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backupDir = Join-Path $root 'backup'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }

# ---------- 1. 定位 CodeBuddy 的 genie 扩展 ----------
Write-Step '定位 CodeBuddy IDE 安装目录'
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js'),
    (Join-Path $env:ProgramFiles   'CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js'),
    (Join-Path ${env:ProgramFiles(x86)} 'CodeBuddy CN\resources\app\extensions\genie\out\extension\index.js')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $candidates) {
    Write-Host ''
    Write-Host '找不到 CodeBuddy IDE 的 extensions\genie\out\extension\index.js' -ForegroundColor Red
    Write-Host '请确认你安装的是 CodeBuddy IDE（不是 VS Code 里的 CodeBuddy 插件）。' -ForegroundColor Red
    exit 1
}

$target = @($candidates)[0]
Write-Ok $target

# ---------- 2. 读文件、检查锚点 ----------
Write-Step '检查补丁锚点'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)

if ($text.Contains('__cbbSvc')) {
    Write-Warn2 '补丁已存在，跳过打补丁（如需重打，请先运行 uninstall.ps1）'
} else {
    $anchors = @(
        'async getConversationsWithState(){',
        'async importArchiveFromJsonText(ir){',
        'async function doActivate(ir,ar){'
    )
    foreach ($a in $anchors) {
        $n = ([regex]::Matches($text, [regex]::Escape($a))).Count
        if ($n -ne 1) {
            Write-Host ''
            Write-Host "锚点出现 $n 次（应为 1 次）：$a" -ForegroundColor Red
            Write-Host '你的 CodeBuddy 版本可能和本工具适配的版本不同，已中止，未做任何修改。' -ForegroundColor Red
            exit 2
        }
    }
    Write-Ok '三个锚点均唯一'

    $capture = 'try{globalThis.__cbbSvc=this;}catch(e){}'

    $timer = 'try{(function(){const R=(typeof __non_webpack_require__==="function")?__non_webpack_require__:(typeof module!=="undefined"&&module.require?module.require.bind(module):require);const fs=R("fs"),path=R("path"),os=R("os"),vscode=R("vscode");const dir=path.join(os.tmpdir(),"codebuddy-branch");let warned=0;setInterval(()=>{try{const p=path.join(dir,"pending.json");if(!fs.existsSync(p))return;const st=fs.statSync(p);if(Date.now()-st.mtimeMs<400)return;const svc=globalThis.__cbbSvc;if(!svc){if(Date.now()-warned>8000){warned=Date.now();try{vscode.commands.executeCommand("tencentcloud.codingcopilot.chatHistory")}catch(e){}if(!globalThis.__cbbHinted){globalThis.__cbbHinted=1;try{vscode.window.showInformationMessage("CodeBuddy 分支：正在激活自动导入（只需第一次）")}catch(e){}}}return;}const text=fs.readFileSync(p,"utf8");const done=path.join(dir,"imported-"+Date.now()+".json");try{fs.renameSync(p,done)}catch(e){return}Promise.resolve().then(()=>svc.importArchiveFromJsonText(text)).then(()=>{try{vscode.window.showInformationMessage("CodeBuddy 分支：已生成新分支对话")}catch(e){}}).catch(e=>{try{vscode.window.showErrorMessage("CodeBuddy 分支导入失败: "+((e&&e.message)||e))}catch(x){}});}catch(e){}},1200);})()}catch(e){}'

    if ($DryRun) {
        Write-Ok 'DryRun：锚点检查通过，未写入'
        exit 0
    }

    Write-Step '备份原始文件'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = Join-Path $backupDir "genie-index-$stamp.js"
    Copy-Item -LiteralPath $target -Destination $bak -Force
    Write-Ok $bak

    Write-Step '写入补丁'
    $text = $text.Replace('async getConversationsWithState(){', 'async getConversationsWithState(){' + $capture)
    $text = $text.Replace('async importArchiveFromJsonText(ir){', 'async importArchiveFromJsonText(ir){' + $capture)
    $text = $text.Replace('async function doActivate(ir,ar){', 'async function doActivate(ir,ar){' + $timer)
    [System.IO.File]::WriteAllText($target, $text, $utf8)
    Write-Ok ('已写入 ' + [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1) + ' MB')
}

# ---------- 3. 安装本地扩展 ----------
Write-Step '安装扩展 codebuddy-branch'
$extDir = Join-Path $env:USERPROFILE '.codebuddycn\extensions\local.codebuddy-branch-0.1.0'
$srcDir = Join-Path $root 'src\extension'
if (-not (Test-Path -LiteralPath (Join-Path $srcDir 'extension.js'))) {
    Write-Host "缺少 $srcDir\extension.js" -ForegroundColor Red
    exit 3
}
if ($DryRun) { Write-Ok "DryRun：将复制到 $extDir"; exit 0 }
New-Item -ItemType Directory -Path $extDir -Force | Out-Null
Copy-Item -Path (Join-Path $srcDir '*') -Destination $extDir -Force
Write-Ok $extDir

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '请完全退出 CodeBuddy 再打开（不是重新加载窗口）。' -ForegroundColor Yellow
Write-Host '重启后：Ctrl+Alt+B（或 Ctrl+Alt+J）从当前对话的某一轮分叉。' -ForegroundColor Yellow
Write-Host ''
Write-Host '卸载：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1'
