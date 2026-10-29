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

function enqueue(archive) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const json = JSON.stringify(archive);
  fs.writeFileSync(PENDING, json, 'utf8');
  return Buffer.byteLength(json, 'utf8');
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
    const prefix = isFull ? '第 ' + r.round + ' 轮（全量）｜' : '第 ' + r.round + ' 轮｜';
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
  const bytes = enqueue(archive);

  const waitConsumed = (ms) => new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (!fs.existsSync(PENDING)) { clearInterval(t); resolve(true); }
      else if (Date.now() - start >= ms) { clearInterval(t); resolve(false); }
    }, 400);
  });

  let consumed = await waitConsumed(3000);
  if (!consumed) {
    // 兜底：宿主侧补丁会自己打开一次历史页来激活；这里只再等一会儿
    consumed = await waitConsumed(5000);
  }

  if (consumed) {
    vscode.window.showInformationMessage('CodeBuddy 分支：已生成「' + archive.data.conversations[0].name + '」');
  } else {
    vscode.window.showWarningMessage('CodeBuddy 分支：文件已生成（' + Math.round(bytes / 1024) + ' KB），但宿主没消费。补丁可能尚未生效——重启一次 CodeBuddy 即可（只需一次）。');
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
