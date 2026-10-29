'use strict';
/**
 * CodeBuddy 对话分支 —— 纯 Node 核心逻辑（不依赖 vscode，可单独用 node 跑测试）
 *
 * 存储结构（实测 CodeBuddy IDE 1.106.1 / genie 3.10.0）：
 *   <historyRoot>/<md5(工作区路径)>/
 *       index.json     { conversations:[{id,type,name,createdAt,lastMessageAt,...}], current }
 *       recent.json    { <conversationId>: <ISO 时间> }
 *       current.json   { conversationId, lastUpdated }
 *       <conversationId>/
 *           index.json  { messages:[{id,type,role,isComplete}], requests:[{id,type,messages:[id...]}] }
 *           messages/<messageId>.json   { role, message, id, extra, createdAt }
 *           assets/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOCAL = path.join(os.homedir(), 'AppData', 'Local');
const EXT_DATA = path.join(LOCAL, 'CodeBuddyExtension', 'Data');

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function nowIso() { return new Date().toISOString(); }
function newId() { return crypto.randomBytes(16).toString('hex'); }

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) {
  const tmp = p + '.tmp-branch';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function backup(p, tag) {
  if (!fs.existsSync(p)) return null;
  const dst = p + '.bak-' + (tag || 'branch') + '-' + Date.now();
  fs.copyFileSync(p, dst);
  return dst;
}

/** 列出所有候选 history 根目录（不同安装/账号可能有多个） */
function findHistoryRoots() {
  const out = [];
  let lvl1 = [];
  try { lvl1 = fs.readdirSync(EXT_DATA); } catch { return out; }
  for (const a of lvl1) {
    const p1 = path.join(EXT_DATA, a);
    let lvl2 = [];
    try { lvl2 = fs.readdirSync(p1); } catch { continue; }
    for (const b of lvl2) {
      const p2 = path.join(p1, b);
      let lvl3 = [];
      try { lvl3 = fs.readdirSync(p2); } catch { continue; }
      for (const c of lvl3) {
        const hp = path.join(p2, c, 'history');
        try { if (fs.statSync(hp).isDirectory()) out.push(hp); } catch { }
      }
    }
  }
  return out;
}

/** 给定工作区路径，返回它的 history 目录（含 index.json 的那个） */
function resolveWorkspaceDir(wsPath) {
  const cands = new Set([
    wsPath,
    wsPath.replace(/^[A-Za-z]:/, (m) => m.toLowerCase()),
    wsPath.replace(/^[A-Za-z]:/, (m) => m.toUpperCase()),
  ]);
  const hashes = [...cands].map(md5);
  for (const root of findHistoryRoots()) {
    for (const h of hashes) {
      const dir = path.join(root, h);
      if (fs.existsSync(path.join(dir, 'index.json'))) return dir;
    }
  }
  return null;
}

/** 当前打开的会话 id */
function getCurrentConversationId(wsDir) {
  const p = path.join(wsDir, 'current.json');
  if (fs.existsSync(p)) {
    try { const j = readJson(p); if (j.conversationId) return j.conversationId; } catch { }
  }
  try { return readJson(path.join(wsDir, 'index.json')).current || null; } catch { return null; }
}

function conversationDir(wsDir, id) { return path.join(wsDir, id); }

function loadConversation(wsDir, id) {
  const dir = conversationDir(wsDir, id);
  const idx = readJson(path.join(dir, 'index.json'));
  return { dir, index: idx, messages: idx.messages || [], requests: idx.requests || [] };
}

/** 从消息文件里提取纯文本（user/assistant 都是 content:[{type:'text',text}] 结构） */
function messageText(wsDir, convId, messageId) {
  const p = path.join(wsDir, convId, 'messages', messageId + '.json');
  try {
    const raw = readJson(p);
    let inner = raw.message;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { return ''; } }
    const parts = [];
    const walk = (c) => {
      if (!c) return;
      if (typeof c === 'string') { parts.push(c); return; }
      if (Array.isArray(c)) { c.forEach(walk); return; }
      if (typeof c === 'object') {
        if (typeof c.text === 'string') parts.push(c.text);
        else if (c.content) walk(c.content);
      }
    };
    walk(inner && inner.content);
    return parts.join('\n');
  } catch { return ''; }
}

/** 去掉系统注入的 user_info / rules / 附件路径，得到完整的用户提问文本 */
function cleanUserText(text) {
  let t = String(text || '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .replace(/<rules>[\s\S]*?<\/rules>/g, '')
    .replace(/<additional_data>[\s\S]*?<\/additional_data>/g, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, '')
    .trim();
  // 只取成对的 <user_query>…</user_query>，避免正文里"引用"这个标签时被误截断
  const blocks = [...t.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)];
  if (blocks.length) t = blocks[blocks.length - 1][1].trim();
  else t = t.replace(/<\/?user_query>/g, '');

  // 附件路径噪音：@image:C:\...\xxx.png / @file:...
  let imgs = 0;
  t = t
    .replace(/@image:[^\n]*?\.(?:png|jpe?g|gif|webp|bmp|svg)\b/gi, () => { imgs++; return ' '; })
    .replace(/@file:[^\n]*?\.\w{1,6}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!t) return imgs ? '[图片 ×' + imgs + ']' : '';
  return (imgs ? '[图片 ×' + imgs + '] ' : '') + t;
}

/** 截断版，仅用于兜底展示 */
function cleanTitle(text) {
  const t = cleanUserText(text);
  return t ? t.slice(0, 60) : '(空提问)';
}

/** 粗略判断一段文本像不像代码/日志片段：符号密度高就当成代码 */
function looksLikeCode(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  const head = s.slice(0, 80);
  const code = (head.match(/[{}();=<>\[\]\\/`$|&]/g) || []).length;
  return code / head.length > 0.08;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function readCreatedAt(wsDir, convId, messageId) {
  try {
    const p = path.join(wsDir, convId, 'messages', messageId + '.json');
    const raw = readJson(p);
    return raw.createdAt || '';
  } catch { return ''; }
}

/**
 * 列出可分支的轮次：每个 role=user 的消息是一个分叉点，
 * 该轮包含这条 user 消息以及其后的 assistant/tool 消息（直到下一条 user 前）。
 */
function listRounds(wsDir, convId) {
  const { messages } = loadConversation(wsDir, convId);
  const rounds = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    let end = messages.length - 1;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === 'user') { end = j - 1; break; }
    }
    const text = messageText(wsDir, convId, messages[i].id);

    // 该轮第一条"像人话"的 assistant 文本作为识别锚点。
    // 实测：最长的那条常常是代码块；全量的 isComplete 基本都是 false；
    // 所以要跳过代码片段，取第一条自然语言。
    let assistantRaw = '';
    for (let k = i + 1; k <= end; k++) {
      if (messages[k].role !== 'assistant') continue;
      const t = messageText(wsDir, convId, messages[k].id);
      if (t.trim() && !looksLikeCode(t)) { assistantRaw = t; break; }
    }
    const createdAt = readCreatedAt(wsDir, convId, messages[i].id);

    rounds.push({
      round: rounds.length + 1,
      startIndex: i,
      endIndex: end,
      messageId: messages[i].id,
      title: cleanTitle(text) || '(空提问)',
      userPreview: cleanTitle(text),
      userFull: cleanUserText(text) || '(空提问)',
      assistantPreview: assistantRaw ? cleanTitle(assistantRaw) : '',
      time: fmtTime(createdAt),
      createdAt,
      msgCount: end - i + 1,
      rawTitle: text,
      rawAssistant: assistantRaw,
    });
  }
  const total = rounds.length;
  for (const r of rounds) r.fromEnd = total - r.round + 1;
  return rounds;
}

/**
 * 从第 roundNo 轮分叉：复制 [0..该轮结束] 的消息，生成新会话。
 * 不改动原会话的任何文件。
 * @returns {{newId:string, copiedMessages:number, convDir:string}}
 */
function forkAtRound(wsDir, convId, roundNo, options) {
  const opts = options || {};
  const rounds = listRounds(wsDir, convId);
  if (!rounds.length) throw new Error('当前会话没有可分支的轮次');
  const n = Math.max(1, Math.min(roundNo, rounds.length));
  const target = rounds[n - 1];
  const keepEnd = target.endIndex;

  const { index, messages, requests } = loadConversation(wsDir, convId);
  const keepIds = new Set(messages.slice(0, keepEnd + 1).map((m) => m.id));

  const id = newId();
  const srcDir = conversationDir(wsDir, convId);
  const dstDir = conversationDir(wsDir, id);
  fs.mkdirSync(path.join(dstDir, 'messages'), { recursive: true });

  // 1) 复制消息文件（只复制保留区间内的）
  let copied = 0;
  for (const m of messages.slice(0, keepEnd + 1)) {
    const s = path.join(srcDir, 'messages', m.id + '.json');
    if (!fs.existsSync(s)) continue;
    fs.copyFileSync(s, path.join(dstDir, 'messages', m.id + '.json'));
    copied++;
  }

  // 2) assets 全量复制（图片可能被保留消息引用）
  const srcAssets = path.join(srcDir, 'assets');
  if (fs.existsSync(srcAssets)) {
    fs.mkdirSync(path.join(dstDir, 'assets'), { recursive: true });
    for (const f of fs.readdirSync(srcAssets)) {
      const s = path.join(srcAssets, f);
      try { if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dstDir, 'assets', f)); } catch { }
    }
  }

  // 3) 新会话自己的 index.json：messages 截断、requests 截断
  const newMessages = messages.slice(0, keepEnd + 1).map((m) => ({ ...m }));
  // 截断点的最后一条 assistant 若仍是流式中，标记完成，避免新会话卡在"生成中"
  const last = newMessages[newMessages.length - 1];
  if (last && last.role === 'assistant') last.isComplete = true;

  const keptRequests = [];
  for (const r of requests) {
    const ids = (r.messages || []).filter((x) => keepIds.has(x));
    if (!ids.length) continue;
    keptRequests.push({ ...r, messages: ids });
  }
  writeJson(path.join(dstDir, 'index.json'), { messages: newMessages, requests: keptRequests });

  // 4) 注册到全局索引
  const globalIdxPath = path.join(wsDir, 'index.json');
  backup(globalIdxPath, 'prebranch');
  const g = readJson(globalIdxPath);
  const src = (g.conversations || []).find((c) => c.id === convId) || {};
  const name = (src.name || '对话') + ' · 分支' + n;
  const entry = {
    id,
    type: src.type || 'craft',
    name,
    createdAt: nowIso(),
    lastMessageAt: nowIso(),
    chatMode: src.chatMode || 'craft',
    selectedModelId: src.selectedModelId || '',
    selectionRevision: 1,
  };
  g.conversations = g.conversations || [];
  g.conversations.push(entry);
  const setCurrent = opts.setCurrent !== false;
  if (setCurrent) g.current = id;
  writeJson(globalIdxPath, g);

  // 5) 指针文件
  if (setCurrent) {
    backup(path.join(wsDir, 'current.json'), 'prebranch');
    writeJson(path.join(wsDir, 'current.json'), { conversationId: id, lastUpdated: nowIso() });
  }

  const recentPath = path.join(wsDir, 'recent.json');
  try {
    const recent = fs.existsSync(recentPath) ? readJson(recentPath) : {};
    recent[id] = nowIso();
    backup(recentPath, 'prebranch');
    writeJson(recentPath, recent);
  } catch { }

  // 6) 同步 genie-history 里的当前会话指针（扩展自己写的那个）
  try {
    if (!setCurrent) throw new Error('skip');
    const gh = path.join(os.homedir(), 'AppData', 'Roaming', 'CodeBuddy CN', 'User', 'globalStorage',
      'tencent-cloud.coding-copilot', 'genie-history');
    if (fs.existsSync(gh)) {
      for (const d of fs.readdirSync(gh)) {
        const p = path.join(gh, d, 'current.json');
        if (!fs.existsSync(p)) continue;
        // 只更新 workspace 对得上的那个（用 lastUpdated 最近的判断，避免误改别的项目）
        writeJson(p, { conversationId: id, lastUpdated: nowIso() });
      }
    }
  } catch { }

  return { newId: id, copiedMessages: copied, convDir: dstDir, name, rounds: rounds.length };
}

/** 校验：新会话目录是否完整 */
function verifyFork(wsDir, id) {
  const dir = conversationDir(wsDir, id);
  const problems = [];
  if (!fs.existsSync(path.join(dir, 'index.json'))) problems.push('缺少 index.json');
  let msgCount = 0;
  try {
    const idx = readJson(path.join(dir, 'index.json'));
    msgCount = (idx.messages || []).length;
    for (const m of idx.messages || []) {
      if (!fs.existsSync(path.join(dir, 'messages', m.id + '.json'))) problems.push('缺消息文件: ' + m.id);
    }
  } catch (e) { problems.push('index.json 读取失败: ' + e.message); }
  return { ok: problems.length === 0, msgCount, problems };
}

/** 归一化：去掉空白、标点和 markdown 符号，便于做包含匹配 */
function normalizeText(s) {
  return String(s || '')
    .replace(/\\[nrt]/g, ' ')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》.,!?;:()\[\]{}<>`*#_\-—…~|/\\@$%^&+=]/g, '')
    .toLowerCase();
}

/**
 * 给"目标文本"和"剪贴板内容"打分：
 * 完全包含 → 1000+；否则按 8 字片段命中比例给分（最多 700）
 */
function scoreMatch(haystackNorm, needleNorm) {
  if (!haystackNorm || !needleNorm) return 0;
  if (haystackNorm.includes(needleNorm)) return 1000 + Math.min(needleNorm.length, 200);
  if (needleNorm.length < 8) return 0;
  const win = 8;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + win <= needleNorm.length; i += win) {
    total++;
    if (haystackNorm.includes(needleNorm.slice(i, i + win))) hit++;
  }
  if (!total) return 0;
  return Math.round(700 * hit / total);
}

/**
 * 用剪贴板内容反查它属于哪一轮（先比用户提问，再比该轮每条 AI 回复）。
 * @returns {{round:number, score:number, where:string}|null}
 */
function locateByClipboard(wsDir, convId, rounds, clip) {
  const needle = normalizeText(clip);
  if (needle.length < 8) return null; // 太短容易误匹配

  const { messages } = loadConversation(wsDir, convId);
  let best = { round: 0, score: 0, where: '' };

  for (const r of rounds) {
    const sUser = scoreMatch(normalizeText(r.userFull || r.userPreview), needle);
    if (sUser > best.score) best = { round: r.round, score: sUser, where: '你的提问' };

    for (let k = r.startIndex + 1; k <= r.endIndex; k++) {
      const m = messages[k];
      if (!m || m.role !== 'assistant') continue;
      const sAi = scoreMatch(normalizeText(messageText(wsDir, convId, m.id)), needle);
      if (sAi > best.score) best = { round: r.round, score: sAi, where: 'AI 回复' };
    }
  }
  return best.score >= 500 ? best : null;
}

module.exports = {
  md5, findHistoryRoots, resolveWorkspaceDir, getCurrentConversationId,
  loadConversation, listRounds, forkAtRound, verifyFork, messageText, cleanTitle,
  normalizeText, scoreMatch, locateByClipboard,
};
