'use strict';
/**
 * 把磁盘上的 CodeBuddy 会话，导出成「历史对话 → 导入」能吃的归档 JSON。
 * 支持截断到第 N 轮，导入后就是一条分支。
 *
 * 归档 schema（从 genie 3.10.0 源码 parseConversationArchive 逆推）：
 * {
 *   schema: "codebuddy.conversation",
 *   schemaVersion: 1,
 *   exportedAt: ISO,
 *   data: { lastMessageAt: ISO, conversations: [ ConversationData ] }  // 必须正好 1 条
 * }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./extension/branch-core');

const ARCHIVE_SCHEMA = 'codebuddy.conversation';
const ARCHIVE_VERSION = 1;
const MAX_BYTES = 104857600;

function nowIso() { return new Date().toISOString(); }

function loadGlobal(wsDir) {
  return JSON.parse(fs.readFileSync(path.join(wsDir, 'index.json'), 'utf8'));
}

function readMessageFile(wsDir, convId, id) {
  const p = path.join(wsDir, convId, 'messages', id + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {string} wsPath 工作区路径
 * @param {string} convId 会话 id
 * @param {number} roundNo 截断到第几轮（1 起）；不传或 <=0 表示全部
 */
function buildArchive(wsPath, convId, roundNo) {
  const wsDir = core.resolveWorkspaceDir(wsPath);
  if (!wsDir) throw new Error('找不到工作区会话目录: ' + wsPath);
  const conv = core.loadConversation(wsDir, convId);
  const globalIdx = loadGlobal(wsDir);
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
      const m = readMessageFile(wsDir, convId, id);
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
    _meta: { wsDir, convId, rounds: total, keptRound: n, keptMessages: keepIds.size },
  };
}

/** 按 genie 的校验规则自检，避免导入时报 "invalid archive" */
function validateArchive(a) {
  const problems = [];
  const isRec = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const isId = (x) => typeof x === 'string' && /^[a-zA-Z0-9-_]+$/.test(x);
  const ROLES = new Set(['user', 'assistant', 'tool', 'system']);
  const STATES = new Set(['running', 'complete', 'aborted', 'canceled']);

  if (a.schema !== ARCHIVE_SCHEMA) problems.push('schema 不符');
  if (a.schemaVersion !== ARCHIVE_VERSION) problems.push('schemaVersion 不符');
  if (typeof a.exportedAt !== 'string') problems.push('exportedAt 不是字符串');
  if (!isRec(a.data)) return { ok: false, problems: problems.concat('data 不是对象') };
  if (typeof a.data.lastMessageAt !== 'string') problems.push('data.lastMessageAt 不是字符串');
  if (!Array.isArray(a.data.conversations) || a.data.conversations.length !== 1) {
    problems.push('data.conversations 必须正好 1 条');
    return { ok: false, problems };
  }
  const c = a.data.conversations[0];
  if (!isId(c.id)) problems.push('conversation.id 非法');
  if (typeof c.type !== 'string') problems.push('type 非字符串');
  if (typeof c.name !== 'string') problems.push('name 非字符串');
  if (typeof c.createdAt !== 'string') problems.push('createdAt 非字符串');
  if (typeof c.lastMessageAt !== 'string') problems.push('lastMessageAt 非字符串');
  if (!Array.isArray(c.requests)) problems.push('requests 非数组');

  const reqIds = new Set();
  const msgIds = new Set();
  let msgCount = 0;
  for (const [i, r] of (c.requests || []).entries()) {
    if (!isRec(r) || !isId(r.id)) problems.push(`requests[${i}].id 非法`);
    if (typeof r.type !== 'string') problems.push(`requests[${i}].type 非字符串`);
    if (!STATES.has(r.state)) problems.push(`requests[${i}].state 非法: ${r.state}`);
    if (reqIds.has(r.id)) problems.push(`requests[${i}].id 重复`);
    reqIds.add(r.id);
    if (!Array.isArray(r.messages)) { problems.push(`requests[${i}].messages 非数组`); continue; }
    for (const m of r.messages) {
      msgCount++;
      if (!isId(m.id)) problems.push(`消息 id 非法: ${m.id}`);
      if (!ROLES.has(m.role)) problems.push(`消息 role 非法: ${m.role}`);
      if (typeof m.message !== 'string') problems.push(`消息 message 非字符串: ${m.id}`);
      if (m.status !== undefined && !['active', 'deprecate', 'deleted'].includes(m.status)) problems.push(`消息 status 非法: ${m.status}`);
      if (m.extra !== undefined && typeof m.extra !== 'string') problems.push(`消息 extra 非字符串: ${m.id}`);
      if (msgIds.has(m.id)) problems.push(`消息 id 重复: ${m.id}`);
      msgIds.add(m.id);
    }
  }
  return { ok: problems.length === 0, problems, stats: { requests: reqIds.size, messages: msgCount } };
}

function writeArchive(archive, outPath) {
  const json = JSON.stringify(archive, null, 0);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_BYTES) throw new Error('归档超过 100MB 上限: ' + bytes);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, 'utf8');
  return { path: outPath, bytes };
}

module.exports = { buildArchive, validateArchive, writeArchive, ARCHIVE_SCHEMA, ARCHIVE_VERSION };

// 命令行：node make-archive.js <wsPath> <convId> [roundNo] [outPath]
if (require.main === module) {
  const [wsPath, convId, roundNo, outPath] = process.argv.slice(2);
  if (!wsPath || !convId) {
    console.log('用法: node make-archive.js "<工作区路径>" <会话id> [轮次] [输出路径]');
    process.exit(1);
  }
  const a = buildArchive(wsPath, convId, roundNo ? Number(roundNo) : 0);
  const v = validateArchive(a);
  const out = outPath || path.join(require('os').tmpdir(), 'codebuddy-branch',
    'branch-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  const w = writeArchive(a, out);
  console.log(JSON.stringify({ ok: v.ok, problems: v.problems, stats: v.stats, meta: a._meta, file: w }, null, 2));
}
