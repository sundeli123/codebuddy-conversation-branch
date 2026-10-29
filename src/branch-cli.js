'use strict';
/**
 * 命令行版分叉：生成 pending.json，宿主补丁会在 1.2 秒内自动导入。
 *
 * 用法：
 *   node branch-cli.js                       # 当前目录作为工作区，全量分叉
 *   node branch-cli.js 3                     # 截断到第 3 轮
 *   node branch-cli.js 3 "E:\path\to\project"
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('./extension/branch-core');

const ARCHIVE_SCHEMA = 'codebuddy.conversation';
const ARCHIVE_VERSION = 1;
const QUEUE_DIR = path.join(os.tmpdir(), 'codebuddy-branch');
const PENDING = path.join(QUEUE_DIR, 'pending.json');

const nowIso = () => new Date().toISOString();

function buildArchive(wsPath, convId, roundNo) {
  const wsDir = core.resolveWorkspaceDir(wsPath);
  if (!wsDir) throw new Error('找不到该工作区的会话目录: ' + wsPath);
  const conv = core.loadConversation(wsDir, convId);
  const meta = (JSON.parse(fs.readFileSync(path.join(wsDir, 'index.json'), 'utf8')).conversations || [])
    .find((c) => c.id === convId) || {};

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
      let m;
      try { m = JSON.parse(fs.readFileSync(path.join(wsDir, convId, 'messages', id + '.json'), 'utf8')); } catch { continue; }
      messages.push({
        id: m.id, role: m.role, message: m.message, status: m.status || 'active',
        ...(typeof m.extra === 'string' ? { extra: m.extra } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}),
      });
    }
    const req = { id: r.id, type: r.type || 'craft', state: r.state === 'running' ? 'complete' : (r.state || 'complete'), messages };
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

  return {
    schema: ARCHIVE_SCHEMA, schemaVersion: ARCHIVE_VERSION, exportedAt: nowIso(),
    data: { lastMessageAt: nowIso(), conversations: [conversation] },
    _meta: { total, keptRound: n, keptMessages: keepIds.size, name: conversation.name },
  };
}

function main() {
  const roundArg = process.argv[2];
  const wsArg = process.argv[3] || process.cwd();
  const wsPath = path.resolve(wsArg);
  const wsDir = core.resolveWorkspaceDir(wsPath);
  if (!wsDir) {
    console.error('找不到会话目录，请确认路径是 CodeBuddy 打开过的项目：' + wsPath);
    process.exit(1);
  }
  const convId = core.getCurrentConversationId(wsDir);
  if (!convId) {
    console.error('读不到当前会话 id');
    process.exit(1);
  }
  const archive = buildArchive(wsPath, convId, roundArg ? Number(roundArg) : 0);
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.writeFileSync(PENDING, JSON.stringify(archive), 'utf8');
  const waitMs = Number(process.env.BRANCH_WAIT_MS || 5000);
  const start = Date.now();
  const timer = setInterval(() => {
    if (!fs.existsSync(PENDING)) {
      clearInterval(timer);
      console.log(JSON.stringify({ ok: true, consumed: true, name: archive._meta.name, ms: Date.now() - start }, null, 2));
      process.exit(0);
    }
    if (Date.now() - start > waitMs) {
      clearInterval(timer);
      console.log(JSON.stringify({
        ok: false, consumed: false,
        msg: '宿主没有消费 pending.json —— 补丁未生效（需重启一次 CodeBuddy）',
        file: PENDING, name: archive._meta.name,
      }, null, 2));
      process.exit(2);
    }
  }, 300);
}

main();
