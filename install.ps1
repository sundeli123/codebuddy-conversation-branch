#Requires -Version 5.1
<#
    codebuddy-conversation-branch  一键安装（Windows）

    做三件事：
      1. 给 CodeBuddy IDE 自带的 genie 扩展打一个小补丁（让它能自动导入"待导入归档"）
      2. 把本地扩展复制到 CodeBuddy 的扩展目录
      3. 提示重启

    补丁有两种情况都会处理：
      - 全新安装：检查三个锚点唯一后插入
      - 旧版（v0.1.0 的 pending.json 版本）已装：原地升级到时 v0.2.0 的按工作区定向版本

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
$extVersion = '0.2.0'

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

# ---------- 2. 读文件、判断该做什么 ----------
Write-Step '检查补丁状态'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)

$capture = 'try{globalThis.__cbbSvc=this;}catch(e){}'

# 轮询片段：只消费 __cbbTargetWs 等于本窗口工作区的任务，成功后写回执
$timer = 'try{(function(){const R=(typeof __non_webpack_require__==="function")?__non_webpack_require__:(typeof module!=="undefined"&&module.require?module.require.bind(module):require);const fs=R("fs"),path=R("path"),os=R("os"),vscode=R("vscode");const dir=path.join(os.tmpdir(),"codebuddy-branch");function norm(p){try{return String(p||"").split("\\").join("/").replace(/\/+$/,"").toLowerCase()}catch(e){return ""}}function myWs(){try{var f=vscode.workspace.workspaceFolders;return f&&f.length?norm(f[0].uri.fsPath):""}catch(e){return ""}}function ack(id,obj){try{fs.writeFileSync(path.join(dir,"ack-"+id+".json"),JSON.stringify(obj),"utf8")}catch(e){}}var warned=0;setInterval(function(){try{if(!fs.existsSync(dir))return;var mine=myWs();if(!mine)return;var names;try{names=fs.readdirSync(dir)}catch(e){return}for(var i=0;i<names.length;i++){var n=names[i];if(!/^(req-.*\.json|pending\.json)$/.test(n))continue;var p=path.join(dir,n);var st;try{st=fs.statSync(p)}catch(e){continue}if(Date.now()-st.mtimeMs<400)continue;var text;try{text=fs.readFileSync(p,"utf8")}catch(e){continue}var task;try{task=JSON.parse(text)}catch(e){continue}var target=norm(task.__cbbTargetWs||"");if(target&&target!==mine)continue;var svc=globalThis.__cbbSvc;if(!svc){if(Date.now()-warned>8000){warned=Date.now();try{vscode.commands.executeCommand("tencentcloud.codingcopilot.chatHistory")}catch(e){}if(!globalThis.__cbbHinted){globalThis.__cbbHinted=1;try{vscode.window.showInformationMessage("CodeBuddy 分支：正在激活自动导入（只需第一次）")}catch(e){}}}return;}var id=task.__taskId||("t"+Date.now());var done=path.join(dir,"imported-"+Date.now()+"-"+id+".json");try{fs.renameSync(p,done)}catch(e){continue}Promise.resolve().then(function(){return svc.importArchiveFromJsonText(text)}).then(function(){ack(id,{ok:true,ws:mine});try{vscode.window.showInformationMessage("CodeBuddy 分支：已生成新分支对话")}catch(e){}}).catch(function(e){var msg=String((e&&e.message)||e);ack(id,{ok:false,ws:mine,error:msg});try{fs.appendFileSync(path.join(dir,"import-error.log"),new Date().toISOString()+" "+mine+" "+msg+"\n"+((e&&e.stack)||"")+"\n","utf8")}catch(x){}try{vscode.window.showErrorMessage("CodeBuddy 分支导入失败: "+msg)}catch(x){}});return;}}catch(e){}},1200);})()}catch(e){}'

# 定位"已有轮询片段"的边界（v1/v2 都适用），用于原地升级
$timerStart = 'try{(function(){const R=(typeof __non_webpack_require__==="function")'
$timerEnd   = '})()}catch(e){}'

$mode = 'fresh'
if ($text.Contains('__cbbTargetWs')) {
    $mode = 'skip'
    Write-Warn2 '补丁已是 v2（按工作区定向），跳过'
} elseif ($text.Contains('__cbbSvc')) {
    if ($text.IndexOf($timerStart) -ge 0 -and $text.IndexOf($timerEnd, $text.IndexOf($timerStart)) -ge 0) {
        $mode = 'upgrade'
        Write-Ok '检测到 v0.1.0 补丁，将原地升级到 v0.2.0（保留原有注入点，只换轮询片段）'
    } else {
        $mode = 'unknown'
        Write-Warn2 '检测到补丁但找不到轮询片段，形态未知，跳过（如需重打请先运行 uninstall.ps1）'
    }
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
}

if ($DryRun) {
    Write-Ok ("DryRun：补丁模式=" + $mode + "，未写入任何文件")
    exit 0
}

if ($mode -eq 'upgrade' -or $mode -eq 'fresh') {
    Write-Step '备份原始文件'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = Join-Path $backupDir "genie-index-$stamp.js"
    Copy-Item -LiteralPath $target -Destination $bak -Force
    Write-Ok $bak

    Write-Step '写入补丁'
    if ($mode -eq 'upgrade') {
        $i = $text.IndexOf($timerStart)
        $j = $text.IndexOf($timerEnd, $i)
        $text = $text.Substring(0, $i) + $timer + $text.Substring($j + $timerEnd.Length)
        Write-Ok '已升级为 v2 轮询（按工作区定向 + 回执）'
    } else {
        $text = $text.Replace('async getConversationsWithState(){', 'async getConversationsWithState(){' + $capture)
        $text = $text.Replace('async importArchiveFromJsonText(ir){', 'async importArchiveFromJsonText(ir){' + $capture)
        $text = $text.Replace('async function doActivate(ir,ar){', 'async function doActivate(ir,ar){' + $timer)
        Write-Ok '已插入 3 处补丁'
    }
    [System.IO.File]::WriteAllText($target, $text, $utf8)
    Write-Ok ('已写入 ' + [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1) + ' MB')
}

# ---------- 3. 安装本地扩展 ----------
Write-Step "安装扩展 codebuddy-branch $extVersion"
$extDir = Join-Path $env:USERPROFILE ".codebuddycn\extensions\local.codebuddy-branch-$extVersion"
$srcDir = Join-Path $root 'src\extension'
if (-not (Test-Path -LiteralPath (Join-Path $srcDir 'extension.js'))) {
    Write-Host "缺少 $srcDir\extension.js" -ForegroundColor Red
    exit 3
}

# 旧版本目录必须删掉：两个同名扩展会抢同一个快捷键
$extRoot = Join-Path $env:USERPROFILE '.codebuddycn\extensions'
Get-ChildItem -LiteralPath $extRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'local.codebuddy-branch-*' -and $_.Name -ne "local.codebuddy-branch-$extVersion" } |
    ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
        Write-Ok ('已移除旧版本目录 ' + $_.Name)
    }

New-Item -ItemType Directory -Path $extDir -Force | Out-Null
Copy-Item -Path (Join-Path $srcDir '*') -Destination $extDir -Force
Write-Ok $extDir

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '请完全退出 CodeBuddy 再打开（不是重新加载窗口）。' -ForegroundColor Yellow
Write-Host '重启后：Ctrl+Alt+B（或 Ctrl+Alt+J）从当前对话的某一轮分叉。' -ForegroundColor Yellow
Write-Host ''
Write-Host '卸载：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1'
