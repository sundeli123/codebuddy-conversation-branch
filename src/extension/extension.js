const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('./branch-core');

const LOG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'CodeBuddyBranch');
const LOG_FILE = path.join(LOG_DIR, 'probe.log');
const QUEUE_DIR = path.join(os.tmpdir(), 'codebuddy-branch');
const PENDING = path.join(QUEUE_DIR, 'pending.json');

const ARCHIVE_SCHEMA = 'codebuddy.conversation';
const ARCHIVE_VERSION = 1;

function log(lines) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, Array.isArray(lines) ? lines.join('\n') : String(lines), 'utf8');
  } catch (e) { /* ignore */ }
}

function nowIso() { return new Date().toISOString(); }

/**
 * 该轮提问时刻 → "MM-DD HH:MM"（本地时区）。
 * 取的是这一轮第一条 user 消息的 createdAt，也就是用户按下发送的时刻
 * （不用 requests[].startedAt：那是后端开始处理的时间，通常晚几秒）。
 * 缺失/非法时返回空串，调用方据此省略这一段，不留空的 "｜"。
 */
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 路径归一化：统一分隔符、去尾斜杠、小写。必须与宿主补丁里的 norm() 完全一致 */
function normWs(p) {
  return String(p || '').split('\\').join('/').replace(/\/+$/, '').toLowerCase();
}

function newTaskId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function workspacePath() {
  const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!f) throw new Error('当前窗口没有打开工作区');
  return f.uri.fsPath;
}

/** 用磁盘上的会话构造「导入」能吃的归档；roundNo 为空表示全量 */
function buildArchive(wsPath, convId, roundNo) {
  const wsDir = core.resolveWorkspaceDir(wsPath);
  if (!wsDir) throw new Error('找不到该工作区的会话目录');
  const conv = core.loadConversation(wsDir, convId);
  const globalIdx = JSON.parse(fs.readFileSync(path.join(wsDir, 'index.json'), 'utf8'));
  const meta = (globalIdx.conversations || []).find((c) => c.id === convId) || {};

  const rounds = core.listRounds(wsDir, convId);
  const total = rounds.length;
  const n = (!roundNo || roundNo > total) ? total : Math.max(1, roundNo);
  const keepEnd = rounds[n - 1] ? rounds[n - 1].endIndex : conv.messages.length - 1;
  const keepIds = new Set(conv.messages.slice(0, keepEnd + 1).map((m) => m.id));

  const requests = [];
  for (let i = 0; i < conv.requests.length && i < n; i++) {
    const r = conv.requests[i];
    const ids = (r.messages || []).filter((x) => keepIds.has(x));
    if (!ids.length) continue;
    const messages = [];
    for (const id of ids) {
      const p = path.join(wsDir, convId, 'messages', id + '.json');
      let m;
      try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      messages.push({
        id: m.id,
        role: m.role,
        message: m.message,
        status: m.status || 'active',
        ...(typeof m.extra === 'string' ? { extra: m.extra } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      });
    }
    const req = {
      id: r.id,
      type: r.type || 'craft',
      state: r.state === 'running' ? 'complete' : (r.state || 'complete'),
      messages,
    };
    if (r.startedAt) req.startedAt = r.startedAt;
    if (r.usage && typeof r.usage === 'object') req.usage = r.usage;
    requests.push(req);
  }

  const suffix = n === total ? ' · 分支(全量)' : ' · 分支' + n;
  const conversation = {
    id: convId,
    type: meta.type || 'craft',
    name: (meta.name || '对话') + suffix,
    createdAt: nowIso(),
    lastMessageAt: nowIso(),
    originalId: convId,
    requests,
  };
  if (meta.modelMap && typeof meta.modelMap === 'object') conversation.modelMap = meta.modelMap;
  if (meta.effortMap && typeof meta.effortMap === 'object') conversation.effortMap = meta.effortMap;

  return {
    schema: ARCHIVE_SCHEMA,
    schemaVersion: ARCHIVE_VERSION,
    exportedAt: nowIso(),
    data: { lastMessageAt: nowIso(), conversations: [conversation] },
    _meta: { total, keptRound: n, keptMessages: keepIds.size },
  };
}

/**
 * 投递任务。必须是「一个任务一个文件 + 带目标工作区」：
 * 队列目录是全机共用的，开着多个 CodeBuddy 窗口时每个窗口的宿主补丁都在轮询，
 * 旧写法（单个 pending.json、谁先抢到算谁的）会把分支导进别的工作区历史里，
 * 当前窗口反而看不到。
 */
function enqueue(archive, taskId, ws) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  archive.__cbbTargetWs = ws;
  archive.__taskId = taskId;
  const file = path.join(QUEUE_DIR, 'req-' + taskId + '.json');
  const json = JSON.stringify(archive);
  fs.writeFileSync(file, json, 'utf8');
  return { file, bytes: Buffer.byteLength(json, 'utf8') };
}

/** 等宿主补丁回执：它真正调完官方导入链路后才会写 ack-<taskId>.json */
function waitAck(taskId, ms) {
  const ackPath = path.join(QUEUE_DIR, 'ack-' + taskId + '.json');
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (fs.existsSync(ackPath)) {
        clearInterval(t);
        let obj = null;
        try { obj = JSON.parse(fs.readFileSync(ackPath, 'utf8')); } catch { obj = { ok: false, error: '回执文件损坏' }; }
        try { fs.unlinkSync(ackPath); } catch { /* ignore */ }
        resolve(obj);
      } else if (Date.now() - start >= ms) {
        clearInterval(t);
        resolve(null);
      }
    }, 300);
  });
}

async function branchCommand() {
  const ws = workspacePath();
  const wsDir = core.resolveWorkspaceDir(ws);
  if (!wsDir) throw new Error('找不到会话目录：' + ws);
  const convId = core.getCurrentConversationId(wsDir);
  if (!convId) throw new Error('读不到当前会话 id');

  const rounds = core.listRounds(wsDir, convId);
  if (!rounds.length) throw new Error('当前会话还没有可分支的轮次');

  // 只展示"我问的问题"：第一段放 description（第一行），第二段放 detail（第二行），
  // 完整提问放 tooltip，鼠标悬停即可看全。
  const total = rounds.length;

  // ===== 方案 A：剪贴板定位 =====
  // 在对话里对某条消息点「复制」后按快捷键，自动把那一轮顶到第一项。
  let clip = '';
  try { clip = await vscode.env.clipboard.readText(); } catch (e) { /* ignore */ }
  let hit = null;
  try { hit = core.locateByClipboard(wsDir, convId, rounds, clip); } catch (e) { /* ignore */ }

  let ordered = rounds.slice().reverse();
  if (hit) {
    ordered = ordered.filter((r) => r.round === hit.round)
      .concat(ordered.filter((r) => r.round !== hit.round));
  }

  // 第一行只放"放得下"的字数，剩下的全部进 detail。
  // 原因：VS Code 只要发现 label 超出可视宽度就会自动加省略号，无法关闭；
  // 若 label 装整段问题，第一行末尾必然出现 "…"，和第二行接不上。
  const HEAD = 30;
  const items = ordered.map((r) => {
    const full = r.userFull || r.userPreview || '(空提问)';
    const head = full.slice(0, HEAD);
    const isFull = r.round === total;
    // 注意：QuickPickItem.tooltip 是 proposed API（quickPickItemTooltip），
    // 普通扩展一用就报 "CANNOT use API proposal"，所以不用它。
    // label 用纯字符串（不要用 {label,highlights} 对象，实测会让列表渲染为空）。
    const mark = (hit && r.round === hit.round) ? '★ ' : '';
    const when = fmtDateTime(r.createdAt);
    const prefix = (isFull ? '第 ' + r.round + ' 轮（全量）｜' : '第 ' + r.round + ' 轮｜')
      + (when ? when + '｜' : '');
    return {
      label: mark + prefix + head,
      // detail 放完整问题（从第 1 字起）：
      // VS Code 的悬停提示取 detail，这样悬停第二行能看到完整提问（前 30 字会和第一行重复，是有意为之）
      detail: full,
      round: r.round,
    };
  });
  try {
    log([
      '===== branch quickpick =====',
      'time: ' + nowIso(),
      'rounds: ' + total,
      'items: ' + items.length,
      'clipboardLen: ' + clip.length,
      'hit: ' + (hit ? ('round ' + hit.round + ' score ' + hit.score + ' by ' + hit.where) : 'none'),
      'first: ' + JSON.stringify(items[0] || {}).slice(0, 200),
      '===== END =====',
    ]);
  } catch (e) { /* ignore */ }
  const picked = await vscode.window.showQuickPick(items, {
    title: hit
      ? '剪贴板命中第 ' + hit.round + ' 轮（' + hit.where + '），已在第一项，回车即可'
      : '从哪一轮分叉？共 ' + total + ' 轮（悬停项可看完整提问）',
    placeHolder: hit ? '第 ' + hit.round + ' 轮已置顶，回车确认；也可改选其它轮' : '选分叉点：可按内容搜索',
    matchOnDetail: true,
  });
  if (!picked) return;

  const archive = buildArchive(ws, convId, picked.round);
  const taskId = newTaskId();
  const { file, bytes } = enqueue(archive, taskId, ws);
  const title = archive.data.conversations[0].name;

  // 只认回执：旧写法"文件消失就算成功"分不清是被本窗口导入了、还是被别的窗口叼走了，
  // 于是会出现提示"已生成"但历史里找不到的情况。
  const ack = await waitAck(taskId, 12000);

  if (ack && ack.ok) {
    vscode.window.showInformationMessage('CodeBuddy 分支：已生成「' + title + '」');
  } else if (ack) {
    vscode.window.showErrorMessage('CodeBuddy 分支导入失败：' + (ack.error || '未知错误'));
  } else if (fs.existsSync(file)) {
    vscode.window.showWarningMessage('CodeBuddy 分支：任务文件已生成（' + Math.round(bytes / 1024) + ' KB），但本窗口的宿主补丁没有取走它。补丁需要重启 IDE 才生效（只需一次），重启后再按快捷键即可。');
  } else {
    vscode.window.showWarningMessage('CodeBuddy 分支：任务被取走但没有回执，说明取走它的是旧版补丁（可能把分支导进了别的工作区）。请重启 IDE 后重试。');
  }
}

async function probe() {
  const lines = [];
  const push = (s) => lines.push(s);
  push('===== CodeBuddy Branch Probe =====');
  push('time: ' + nowIso());
  try {
    const ws = workspacePath();
    push('workspace: ' + ws);
    push('md5(lower drive) = ' + core.md5(ws.replace(/^[A-Za-z]:/, (m) => m.toLowerCase())));
    const dir = core.resolveWorkspaceDir(ws);
    push('wsDir: ' + (dir || 'NOT FOUND'));
    if (dir) {
      const id = core.getCurrentConversationId(dir);
      push('current conversation: ' + id);
      push('rounds: ' + core.listRounds(dir, id).length);
    }
  } catch (e) {
    push('error: ' + e.message);
  }
  push('queue dir: ' + QUEUE_DIR);
  push('pending exists: ' + fs.existsSync(PENDING));
  push('===== END =====');
  log(lines);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codebuddyBranch.branch', () =>
      branchCommand().catch((e) => {
        const detail = String((e && e.stack) || e);
        try {
          fs.mkdirSync(LOG_DIR, { recursive: true });
          fs.writeFileSync(path.join(LOG_DIR, 'error.log'), new Date().toISOString() + '\n' + detail, 'utf8');
        } catch (x) { /* ignore */ }
        vscode.window.showErrorMessage('CodeBuddy 分支失败：' + ((e && e.message) || e));
      })
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codebuddyBranch.probe', () => probe())
  );
  probe().catch(() => { });
}

function deactivate() { }

module.exports = { activate, deactivate };
