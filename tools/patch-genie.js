'use strict';
/**
 * 给 CodeBuddy 的 genie 扩展打最小补丁：
 *  1) 在 ConversationServiceImpl 的两个方法入口把 this 存到 globalThis.__cbbSvc
 *  2) 在 doActivate 里启动 1.2s 轮询，发现 %TEMP%\codebuddy-branch\req-*.json / pending.json
 *     就调用它自己的 importArchiveFromJsonText(text) —— 走官方导入链路，
 *     写盘 + 更新内存 + fire 事件，界面立刻刷新，不需要重载。
 *
 * v2（2026-10-30）修复：队列文件里带 __cbbTargetWs（目标工作区路径），
 *   补丁只消费「目标 == 本窗口工作区」的任务。
 *   背景：pending.json 是全机共用文件，开着多个 CodeBuddy 窗口时，
 *   每个窗口的补丁都在抢同一个文件，结果分支被导入到别人的工作区历史里，
 *   当前窗口看不到（旧版还会误报「已生成」）。
 *   导入成功/失败后写 ack-<taskId>.json 回执，扩展据此提示真实结果。
 *
 * 用法:
 *   node patch-genie.js apply     # 全新打补丁，或把旧版轮询升级到 v2
 *   node patch-genie.js status
 *   node patch-genie.js revert <备份文件>
 */
const fs = require('fs');
const path = require('path');

const TARGET = 'C:\\Users\\21078\\AppData\\Local\\Programs\\CodeBuddy CN\\resources\\app\\extensions\\genie\\out\\extension\\index.js';
const MARK = '__cbbSvc';
const BACKUP_DIR = path.join(__dirname, 'backup');

const CAPTURE = 'try{globalThis.__cbbSvc=this;}catch(e){}';

// 旧版轮询片段的起点（用于原地升级，不依赖备份文件，避免备份与当前 IDE 版本不一致）
const TIMER_START = 'try{(function(){const R=(typeof __non_webpack_require__==="function")';
const TIMER_END = '})()}catch(e){}';

const TIMER = [
  'try{(function(){',
  'const R=(typeof __non_webpack_require__==="function")?__non_webpack_require__:(typeof module!=="undefined"&&module.require?module.require.bind(module):require);',
  'const fs=R("fs"),path=R("path"),os=R("os"),vscode=R("vscode");',
  'const dir=path.join(os.tmpdir(),"codebuddy-branch");',
  // 路径归一化：统一分隔符、去尾斜杠、小写（Windows 路径大小写不敏感）
  'function norm(p){try{return String(p||"").split("\\\\").join("/").replace(/\\/+$/,"").toLowerCase()}catch(e){return ""}}',
  'function myWs(){try{var f=vscode.workspace.workspaceFolders;return f&&f.length?norm(f[0].uri.fsPath):""}catch(e){return ""}}',
  'function ack(id,obj){try{fs.writeFileSync(path.join(dir,"ack-"+id+".json"),JSON.stringify(obj),"utf8")}catch(e){}}',
  'var warned=0;',
  'setInterval(function(){try{',
  'if(!fs.existsSync(dir))return;',
  'var mine=myWs();if(!mine)return;',
  'var names;try{names=fs.readdirSync(dir)}catch(e){return}',
  'for(var i=0;i<names.length;i++){',
  'var n=names[i];',
  'if(!/^(req-.*\\.json|pending\\.json)$/.test(n))continue;',
  'var p=path.join(dir,n);',
  'var st;try{st=fs.statSync(p)}catch(e){continue}',
  'if(Date.now()-st.mtimeMs<400)continue;',
  'var text;try{text=fs.readFileSync(p,"utf8")}catch(e){continue}',
  'var task;try{task=JSON.parse(text)}catch(e){continue}',
  'var target=norm(task.__cbbTargetWs||"");',
  'if(target&&target!==mine)continue;',
  'var svc=globalThis.__cbbSvc;',
  'if(!svc){if(Date.now()-warned>8000){warned=Date.now();try{vscode.commands.executeCommand("tencentcloud.codingcopilot.chatHistory")}catch(e){}if(!globalThis.__cbbHinted){globalThis.__cbbHinted=1;try{vscode.window.showInformationMessage("CodeBuddy 分支：正在激活自动导入（只需第一次）")}catch(e){}}}return;}',
  'var id=task.__taskId||("t"+Date.now());',
  'var done=path.join(dir,"imported-"+Date.now()+"-"+id+".json");',
  'try{fs.renameSync(p,done)}catch(e){continue}',
  'Promise.resolve().then(function(){return svc.importArchiveFromJsonText(text)}).then(function(){',
  'ack(id,{ok:true,ws:mine});',
  'try{vscode.window.showInformationMessage("CodeBuddy 分支：已生成新分支对话")}catch(e){}',
  '}).catch(function(e){',
  'var msg=String((e&&e.message)||e);',
  'ack(id,{ok:false,ws:mine,error:msg});',
  'try{fs.appendFileSync(path.join(dir,"import-error.log"),new Date().toISOString()+" "+mine+" "+msg+"\\n"+((e&&e.stack)||"")+"\\n","utf8")}catch(x){}',
  'try{vscode.window.showErrorMessage("CodeBuddy 分支导入失败: "+msg)}catch(x){}',
  '});',
  'return;',
  '}',
  '}catch(e){}},1200);',
  '})()}catch(e){}',
].join('');

function injectOnce(s, anchor, insert, tag) {
  const n = s.split(anchor).length - 1;
  if (n !== 1) throw new Error(tag + ' 锚点出现 ' + n + ' 次，放弃改动');
  return s.replace(anchor, anchor + insert);
}

function backupTarget(s) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dst = path.join(BACKUP_DIR, 'genie-extension-index.' + ts + '.js');
  fs.writeFileSync(dst, s, 'utf8');
  return dst;
}

function apply() {
  let s = fs.readFileSync(TARGET, 'utf8');

  // 情况一：已是补丁版 —— 只把轮询片段原地换成 v2，其余注入保留
  const start = s.indexOf(TIMER_START);
  if (start >= 0) {
    const endRel = s.indexOf(TIMER_END, start);
    if (endRel < 0) throw new Error('找到轮询起点但找不到终点，放弃改动');
    const end = endRel + TIMER_END.length;
    const old = s.slice(start, end);
    if (old.indexOf('__cbbTargetWs') >= 0) {
      console.log(JSON.stringify({ ok: true, already: true, msg: 'v2 轮询已是当前版本，未改动' }));
      return;
    }
    const bak = backupTarget(s);
    s = s.slice(0, start) + TIMER + s.slice(end);
    fs.writeFileSync(TARGET, s, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      upgraded: 'v1 -> v2',
      backup: bak,
      target: TARGET,
      delta: TIMER.length - old.length,
    }, null, 2));
    return;
  }

  // 情况二：已经打过补丁但没有可识别的轮询片段 —— 形态未知，不动
  if (s.indexOf(MARK) >= 0) {
    throw new Error('文件里已有 __cbbSvc 但找不到轮询片段，形态未知，放弃改动（请先 revert）');
  }

  // 情况三：全新打补丁
  const bak = backupTarget(s);
  const before = s.length;
  let out = s;
  out = injectOnce(out, 'async getConversationsWithState(){', CAPTURE, 'A1');
  out = injectOnce(out, 'async importArchiveFromJsonText(ir){', CAPTURE, 'A2');
  out = injectOnce(out, 'async function doActivate(ir,ar){', TIMER, 'B');
  fs.writeFileSync(TARGET, out, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    applied: true,
    backup: bak,
    target: TARGET,
    delta: out.length - before,
  }, null, 2));
}

function status() {
  const s = fs.readFileSync(TARGET, 'utf8');
  console.log(JSON.stringify({
    patched: s.indexOf(MARK) >= 0,
    hasTimer: s.indexOf('codebuddy-branch') >= 0,
    timerVersion: s.indexOf('__cbbTargetWs') >= 0 ? 2 : (s.indexOf('codebuddy-branch') >= 0 ? 1 : 0),
    target: TARGET,
  }, null, 2));
}

function revert(file) {
  if (!file || !fs.existsSync(file)) throw new Error('请提供有效的备份文件路径');
  fs.copyFileSync(file, TARGET);
  console.log(JSON.stringify({ ok: true, reverted: true, from: file }, null, 2));
}

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'apply') apply();
    else if (cmd === 'status') status();
    else if (cmd === 'revert') revert(arg);
    else console.log('用法: node patch-genie.js apply|status|revert <备份文件>');
  } catch (e) {
    console.error('错误: ' + e.message);
    process.exit(1);
  }
}

module.exports = { TARGET };
