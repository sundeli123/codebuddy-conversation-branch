'use strict';
/**
 * 给 CodeBuddy 的 genie 扩展打最小补丁：
 *  1) 在 ConversationServiceImpl 的两个方法入口把 this 存到 globalThis.__cbbSvc
 *  2) 在 doActivate 里启动 1.2s 轮询，发现 %TEMP%\codebuddy-branch\pending.json
 *     就调用它自己的 importArchiveFromJsonText(text) —— 走官方导入链路
 *
 * 用法:
 *   node patch-genie.js status
 *   node patch-genie.js apply
 *   node patch-genie.js revert <备份文件>
 *   node patch-genie.js apply --target "D:\path\to\genie\out\extension\index.js"
 */
const fs = require('fs');
const path = require('path');

const MARK = '__cbbSvc';
const BACKUP_DIR = path.join(__dirname, '..', 'backup');

const CAPTURE = 'try{globalThis.__cbbSvc=this;}catch(e){}';

const TIMER = [
  'try{(function(){',
  'const R=(typeof __non_webpack_require__==="function")?__non_webpack_require__:(typeof module!=="undefined"&&module.require?module.require.bind(module):require);',
  'const fs=R("fs"),path=R("path"),os=R("os"),vscode=R("vscode");',
  'const dir=path.join(os.tmpdir(),"codebuddy-branch");',
  'let warned=0;',
  'setInterval(()=>{try{',
  'const p=path.join(dir,"pending.json");',
  'if(!fs.existsSync(p))return;',
  'const st=fs.statSync(p);',
  'if(Date.now()-st.mtimeMs<400)return;',
  'const svc=globalThis.__cbbSvc;',
  'if(!svc){if(Date.now()-warned>8000){warned=Date.now();try{vscode.commands.executeCommand("tencentcloud.codingcopilot.chatHistory")}catch(e){}if(!globalThis.__cbbHinted){globalThis.__cbbHinted=1;try{vscode.window.showInformationMessage("CodeBuddy 分支：正在激活自动导入（只需第一次）")}catch(e){}}}return;}',
  'const text=fs.readFileSync(p,"utf8");',
  'const done=path.join(dir,"imported-"+Date.now()+".json");',
  'try{fs.renameSync(p,done)}catch(e){return}',
  'Promise.resolve().then(()=>svc.importArchiveFromJsonText(text)).then(()=>{try{vscode.window.showInformationMessage("CodeBuddy 分支：已生成新分支对话")}catch(e){}}).catch(e=>{try{vscode.window.showErrorMessage("CodeBuddy 分支导入失败: "+((e&&e.message)||e))}catch(x){}});',
  '}catch(e){}},1200);',
  '})()}catch(e){}',
].join('');

/** 自动定位 CodeBuddy IDE 里的 genie 扩展主文件 */
function findTarget(explicit) {
  if (explicit) return explicit;
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy CN', 'resources', 'app', 'extensions', 'genie', 'out', 'extension', 'index.js'),
    path.join(process.env.ProgramFiles || '', 'CodeBuddy CN', 'resources', 'app', 'extensions', 'genie', 'out', 'extension', 'index.js'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'CodeBuddy CN', 'resources', 'app', 'extensions', 'genie', 'out', 'extension', 'index.js'),
  ];
  for (const p of cands) {
    if (!p) continue;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function injectOnce(s, anchor, insert, tag) {
  const n = s.split(anchor).length - 1;
  if (n !== 1) throw new Error(`${tag} 锚点出现 ${n} 次（应为 1 次），已中止，未修改文件`);
  return s.replace(anchor, anchor + insert);
}

function apply(target) {
  if (!target) throw new Error('找不到 CodeBuddy 安装目录，请用 --target 手动指定');
  let s = fs.readFileSync(target, 'utf8');
  if (s.indexOf(MARK) >= 0) {
    console.log(JSON.stringify({ ok: true, already: true, msg: '补丁已存在，未重复打', target }, null, 2));
    return;
  }
  const before = s.length;
  s = injectOnce(s, 'async getConversationsWithState(){', CAPTURE, 'A1');
  s = injectOnce(s, 'async importArchiveFromJsonText(ir){', CAPTURE, 'A2');
  s = injectOnce(s, 'async function doActivate(ir,ar){', TIMER, 'B');

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(BACKUP_DIR, `genie-index-${stamp}.js`);
  fs.copyFileSync(target, bak);

  fs.writeFileSync(target, s, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    applied: true,
    target,
    backup: bak,
    delta: s.length - before,
  }, null, 2));
}

function status(target) {
  if (!target) throw new Error('找不到 CodeBuddy 安装目录，请用 --target 手动指定');
  const s = fs.readFileSync(target, 'utf8');
  console.log(JSON.stringify({
    target,
    patched: s.indexOf(MARK) >= 0,
    hasTimer: s.indexOf('codebuddy-branch') >= 0,
  }, null, 2));
}

function revert(target, file) {
  if (!target) throw new Error('找不到 CodeBuddy 安装目录，请用 --target 手动指定');
  if (!file || !fs.existsSync(file)) throw new Error('请提供有效的备份文件路径');
  fs.copyFileSync(file, target);
  console.log(JSON.stringify({ ok: true, reverted: true, target, from: file }, null, 2));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  let target = null;
  let revertFrom = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--target') target = argv[++i];
    else if (!revertFrom) revertFrom = argv[i];
  }
  try {
    const t = findTarget(target);
    if (cmd === 'apply') apply(t);
    else if (cmd === 'status') status(t);
    else if (cmd === 'revert') revert(t, revertFrom);
    else console.log('用法: node patch-genie.js status|apply|revert <备份文件> [--target <index.js>]');
  } catch (e) {
    console.error('错误: ' + e.message);
    process.exit(2);
  }
}

module.exports = { apply, status, revert, findTarget };
