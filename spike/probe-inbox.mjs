// Spike probe: NowTree 收件箱录入（v1.1.8）。
//
// Run: node spike/probe-inbox.mjs                       # 只跑本地逻辑（不需要 DSH）
//      node spike/probe-inbox.mjs http://127.0.0.1:1234 # 再验一次 HTTP 路由（只打「空标题→400」，不写库）
//
// 这是 LifeHud **唯一一处写别人的库**（plugin/lib/inbox.js），所以断言写得比读路径狠：
//   1. 只 INSERT 一行，字段逐项与 NowTree 自己的 inbox 记录对齐；
//   2. 原有记录一行都不许变（条数、内容、其它表）；
//   3. 参数不合法 / 库不存在 / 结构不对 / 被锁 → 明确 reason，**绝不留下半截写入**；
//   4. 库文件不存在时不许凭空造一个空库（那会在 NowTree 目录里留垃圾）。
//
// 全部在临时副本上做，永远不碰 %APPDATA% 里的真库。
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  addInboxTask, countInboxTasks, nowtreeTimestamp, InboxError,
  INBOX_TITLE_MAX, INBOX_NOTE_MAX,
} from '../plugin/lib/inbox.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
async function checkThrow(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(name, true, `${error.reason ?? error.name}: ${error.message}`);
    return error;
  }
  check(name, false, '没有抛错（本该拒绝）');
  return null;
}

/* ----------------------------------------------------- 夹具：真实表结构 */
// 优先从本机真实的 NowTree 库里抄 sqlite_master（结构与 NowTree 自己保持同步，
// 不靠人肉维护 DDL）；没有 NowTree 的机器用下面这份 2026-11-20 的等价 DDL 兜底。
const FALLBACK_DDL = `CREATE TABLE transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  note            TEXT,
  category        TEXT,
  status          TEXT    NOT NULL DEFAULT 'inbox',
  deadline_type   TEXT    NOT NULL DEFAULT 'none',
  deadline_date   TEXT,
  priority        INTEGER,
  created_time    TEXT    NOT NULL,
  completed_time  TEXT,
  updated_time    TEXT,
  parent_id       INTEGER,
  show_in_next    INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  order_index     INTEGER, reminder_time TEXT, reminder_done INTEGER NOT NULL DEFAULT 0,
  time_slot       TEXT NOT NULL DEFAULT 'none', sync_id TEXT, deleted_at TEXT,
  wait_auto_next INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (parent_id) REFERENCES transactions(id)
)`;

function realNowtreePath() {
  const appData = process.env.APPDATA;
  return appData ? join(appData, 'com.nowtree.app', 'nowtree.sqlite') : '';
}
function transactionsDdl() {
  const real = realNowtreePath();
  if (real && existsSync(real)) {
    try {
      const db = new DatabaseSync(real, { readOnly: true });
      try {
        const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get();
        if (row?.sql) return { ddl: row.sql, source: '真实 NowTree 库的 sqlite_master' };
      } finally { db.close(); }
    } catch { /* 落到兜底 DDL */ }
  }
  return { ddl: FALLBACK_DDL, source: '内置兜底 DDL（本机没有 NowTree）' };
}

const { ddl, source } = transactionsDdl();
const work = mkdtempSync(join(tmpdir(), 'lifehud-inbox-probe-'));
const dbPath = join(work, 'nowtree.sqlite');

/** 造一个「已经用了一阵子」的库：3 条已有记录（inbox / active / deleted 各一）。 */
function seed(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(ddl);
    const ins = db.prepare(`INSERT INTO transactions
      (title, note, category, status, deadline_type, priority, created_time, show_in_next, deleted, time_slot, sync_id)
      VALUES (?, ?, ?, ?, 'none', 1, ?, 0, ?, 'none', ?)`);
    ins.run('已有的 inbox 记录', '别动我', null, 'inbox', '2026-11-19T05:25:00.661902100+00:00', 0, 'uuid-old-1');
    ins.run('已有的任务', null, 'next_action', 'active', '2026-11-19T16:31:17.762402800+00:00', 0, 'uuid-old-2');
    ins.run('已删除的', null, null, 'inbox', '2026-11-19T05:00:00.000000000+00:00', 1, 'uuid-old-3');
  } finally { db.close(); }
}

/** 整库快照（除新 id 之外的所有列），用来证明「别的记录一个字都没变」。 */
function snapshot(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM transactions ORDER BY id').all().map((r) => JSON.stringify(r));
  } finally { db.close(); }
}

console.log(`夹具：${source}\n临时目录：${work}\n`);

try {
  seed(dbPath);
  const before = snapshot(dbPath);
  const beforeCount = countInboxTasks(dbPath);

  /* ------------------------------------------------------------ 1. 正常写入 */
  console.log('1) 正常写入');
  const task = addInboxTask(dbPath, { title: '  想到一个点子  ', note: '  先记下来  ' });
  check('返回 id / title / note / createdTime',
    Number.isInteger(task.id) && task.title === '想到一个点子' && task.note === '先记下来' && typeof task.createdTime === 'string',
    JSON.stringify(task));

  {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(task.id);
      eq(row.title, '想到一个点子', 'title');
      eq(row.note, '先记下来', 'note');
      eq(row.category, null, 'category（Inbox = NULL）');
      eq(row.status, 'inbox', 'status');
      eq(row.time_slot, 'none', 'time_slot');
      eq(row.deadline_type, 'none', 'deadline_type');
      eq(row.priority, 1, 'priority');
      eq(row.show_in_next, 0, 'show_in_next');
      eq(row.deleted, 0, 'deleted');
      eq(row.reminder_done, 0, 'reminder_done');
      eq(row.parent_id, null, 'parent_id');
      eq(row.order_index, null, 'order_index');
      eq(row.completed_time, null, 'completed_time');
      check('写入的行与 NowTree 自己的 inbox 记录逐字段一致',
        true, `id=${row.id} status=${row.status} category=${row.category} time_slot=${row.time_slot} priority=${row.priority}`);

      const createdAt = Date.parse(row.created_time);
      check('created_time 是 UTC + 9 位小数秒 + +00:00（照抄 NowTree 的形状）',
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}\+00:00$/.test(row.created_time),
        row.created_time);
      check('created_time 落在现在附近（±2 分钟）',
        Math.abs(Date.now() - createdAt) < 120000, `${Math.round((Date.now() - createdAt) / 1000)}s 前`);

      check('sync_id 是 uuid v4',
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(row.sync_id)),
        String(row.sync_id));
      check('新建记录不复用已有 sync_id',
        !before.some((json) => json.includes(row.sync_id)), String(row.sync_id));
    } finally { db.close(); }
  }

  check('收件箱计数 +1（只算 status=inbox 且 deleted=0）',
    countInboxTasks(dbPath) === beforeCount + 1, `${beforeCount} → ${countInboxTasks(dbPath)}`);

  /* ------------------------------------------------------------ 2. 不动别人的记录 */
  console.log('\n2) 只追加，不改不删');
  {
    const after = snapshot(dbPath);
    check('原有 3 行逐字节未变（整行 JSON 对比）',
      after.length === before.length + 1 && before.every((row, i) => after[i] === row),
      `${before.length} 行 → ${after.length} 行`);
    check('新行只多了一条（没有顺手插别的）', after.length - before.length === 1, String(after.length - before.length));
  }

  /* ------------------------------------------------------------ 3. 参数校验 */
  console.log('\n3) 参数校验（都必须在写库之前拦住）');
  const countBeforeBad = countInboxTasks(dbPath);
  const e1 = await checkThrow('空标题被拒（reason=title-required）', () => addInboxTask(dbPath, { title: '   ' }));
  eq(e1?.reason, 'title-required', 'reason');
  const e2 = await checkThrow('缺少 title 字段被拒', () => addInboxTask(dbPath, {}));
  eq(e2?.reason, 'title-required', 'reason');
  const e3 = await checkThrow(`超长标题被拒（> ${INBOX_TITLE_MAX}）`,
    () => addInboxTask(dbPath, { title: 'a'.repeat(INBOX_TITLE_MAX + 1) }));
  eq(e3?.reason, 'title-too-long', 'reason');
  const e4 = await checkThrow(`超长备注被拒（> ${INBOX_NOTE_MAX}）`,
    () => addInboxTask(dbPath, { title: 'ok', note: 'b'.repeat(INBOX_NOTE_MAX + 1) }));
  eq(e4?.reason, 'note-too-long', 'reason');
  check('被拒的 4 次一条都没写进去', countInboxTasks(dbPath) === countBeforeBad, `${countBeforeBad} → ${countInboxTasks(dbPath)}`);
  check('InboxError 带 reason 字段（路由靠它挑状态码）', e1 instanceof InboxError && typeof e1.reason === 'string');

  /* ------------------------------------------------------------ 4. 边界值 */
  console.log('\n4) 边界值');
  const maxTitle = addInboxTask(dbPath, { title: 'a'.repeat(INBOX_TITLE_MAX) });
  check(`正好 ${INBOX_TITLE_MAX} 字的标题可以写入`, Number.isInteger(maxTitle.id), `id=${maxTitle.id}`);
  const maxNote = addInboxTask(dbPath, { title: '备注上限', note: 'b'.repeat(INBOX_NOTE_MAX) });
  check(`正好 ${INBOX_NOTE_MAX} 字的备注可以写入`, Number.isInteger(maxNote.id), `id=${maxNote.id}`);
  const noNote = addInboxTask(dbPath, { title: '没有备注' });
  check('空备注存成 NULL（不是空字符串）', noNote.note === null, String(noNote.note));
  const multiline = addInboxTask(dbPath, { title: '带\n换行\t的标题', note: '第一行\n第二行' });
  check('标题里的换行/制表符被压成单个空格（标题是一行文本）', multiline.title === '带 换行 的标题', multiline.title);
  check('备注保留换行（NowTree 的备注是多行文本）', noNote.note === null && multiline.note === '第一行\n第二行', JSON.stringify(multiline.note));

  /* ------------------------------------------------------------ 5. 时间戳函数 */
  console.log('\n5) 时间戳形状');
  const fixed = nowtreeTimestamp(new Date('2026-11-20T02:01:39.097Z'));
  check('nowtreeTimestamp 与 NowTree 已有一条记录的写法同形',
    fixed === '2026-11-20T02:01:39.097000000+00:00', fixed);

  /* ------------------------------------------------------------ 6. 失败路径 */
  console.log('\n6) 失败路径');
  const ghost = join(work, 'not-installed', 'nowtree.sqlite');
  const e5 = await checkThrow('库不存在 → reason=no-db', () => addInboxTask(ghost, { title: 'x' }));
  eq(e5?.reason, 'no-db', 'reason');
  check('库不存在时**没有**凭空造出一个空库文件', !existsSync(ghost), existsSync(ghost) ? '文件被创建了' : '未创建');

  const emptyDb = join(work, 'no-schema.sqlite');
  new DatabaseSync(emptyDb).close(); // 只有文件、没有表
  const e6 = await checkThrow('结构不对（没有 transactions 表）→ reason=schema',
    () => addInboxTask(emptyDb, { title: 'x' }));
  eq(e6?.reason, 'schema', 'reason');
  check('结构不对时也不会留下半截行', countInboxTasks(emptyDb) === null, String(countInboxTasks(emptyDb)));

  // 被锁：另开一个连接拿住写锁，addInboxTask 必须等满 busy_timeout 后给 busy，而不是写坏。
  const locked = join(work, 'locked.sqlite');
  copyFileSync(dbPath, locked);
  const holder = new DatabaseSync(locked);
  holder.exec('PRAGMA busy_timeout = 2000');
  holder.exec('BEGIN IMMEDIATE');
  const rowCountBeforeLock = (() => {
    const db = new DatabaseSync(locked, { readOnly: true });
    try { return db.prepare('SELECT COUNT(*) n FROM transactions').get().n; } finally { db.close(); }
  })();
  const tLock = Date.now();
  const e7 = await checkThrow('库被另一个写事务锁住 → 等到 busy_timeout 后报 busy（不静默丢数据）',
    () => addInboxTask(locked, { title: '锁里的写' }));
  const lockMs = Date.now() - tLock;
  eq(e7?.reason, 'busy', 'reason');
  check('等锁时间 ≈ busy_timeout（3s 量级，不是立刻失败也不是无限等）',
    lockMs >= 2500 && lockMs < 8000, `${lockMs}ms`);
  holder.exec('ROLLBACK');
  holder.close();
  {
    const db = new DatabaseSync(locked, { readOnly: true });
    try {
      eq(db.prepare('SELECT COUNT(*) n FROM transactions').get().n, rowCountBeforeLock, '被锁后的行数');
    } finally { db.close(); }
    check('被锁那次没有留下半截写入', true, `仍是 ${rowCountBeforeLock} 行`);
  }
  const afterLock = addInboxTask(locked, { title: '锁放开后可以写' });
  check('锁放开后同一条路径立刻可用', Number.isInteger(afterLock.id), `id=${afterLock.id}`);

  /* ------------------------------------------------------------ 7. HTTP 路由（可选） */
  const BASE = String(process.argv[2] ?? process.env.LIFEHUD_BASE ?? '').replace(/\/+$/, '');
  console.log('\n7) HTTP 路由');
  if (!BASE) {
    check('未指定 DSH 地址 → 跳过（不构成失败）', true, '要跑：node spike/probe-inbox.mjs http://127.0.0.1:<端口>');
  } else {
    const url = `${BASE}/lifehud/api/inbox`;
    try {
      const get = await fetch(url, { signal: AbortSignal.timeout(8000) });
      eq(get.status, 405, 'GET 状态');
      check('GET → 405（只接受 POST）', true, `HTTP ${get.status}`);

      const bad = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   ' }), signal: AbortSignal.timeout(8000),
      });
      const badBody = await bad.json();
      eq(bad.status, 400, '空标题状态码');
      eq(badBody.reason, 'title-required', '空标题 reason');
      check('空标题 → 400 + reason=title-required（不会写库）', true, JSON.stringify(badBody));

      const notJson = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
        signal: AbortSignal.timeout(8000),
      });
      eq(notJson.status, 500, '坏 JSON 状态码');
      check('坏 JSON → 500 + ok=false（不抛未捕获异常）', true, JSON.stringify(await notJson.json()));
    } catch (error) {
      check('HTTP 路由可用', false, error?.message ?? String(error));
    }
    // 远程访问面：非 loopback 地址必须打不到
    const { networkInterfaces } = await import('node:os');
    const ips = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    const port = (() => { try { return new URL(BASE).port; } catch { return ''; } })();
    if (ips.length > 0 && port) {
      let allForbidden = true;
      for (const ip of ips) {
        try {
          const res = await fetch(`http://${ip}:${port}/lifehud/api/inbox`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'should not pass' }), signal: AbortSignal.timeout(4000),
          });
          if (res.status !== 403) allForbidden = false;
        } catch { /* 连不上也算打不到 */ }
      }
      check('非 loopback 地址打不到收件箱路由（403 / 连不上）', allForbidden, ips.join(', '));
    }
  }

  /* ------------------------------------------------------------ 8. 静态审查 */
  console.log('\n8) 静态审查');
  {
    const src = readFileSync(join(REPO, 'plugin', 'index.js'), 'utf8');
    check('路由在 isLocalPeer 之后才干活', /inboxHandler[\s\S]{0,400}isLocalPeer\(req\)/.test(src));
    check('路由只认 POST', /inboxHandler[\s\S]{0,600}req\.method !== 'POST'/.test(src));
    check('有 nowtreeWrite 总开关（默认开，可关掉写权限）', /config\.nowtreeWrite === false/.test(src));
    const inboxSrc = readFileSync(join(REPO, 'plugin', 'lib', 'inbox.js'), 'utf8');
    check('inbox.js 里没有任何 UPDATE / DELETE 语句（只追加）',
      !/\b(UPDATE|DELETE)\s+transactions/i.test(inboxSrc) && !/DROP\s+TABLE/i.test(inboxSrc));
    const clientSrc = readFileSync(join(REPO, 'plugin', 'client.js'), 'utf8');
    check('页面弹窗读 Host 的 error 字段（失败时给人话，不吞）', /payload\?\.error/.test(clientSrc));
  }
} finally {
  let removed = false;
  try { rmSync(work, { recursive: true, force: true }); removed = !existsSync(work); } catch { /* ignore */ }
  console.log(`\n临时目录已清理：${removed ? '是' : '否（残留 ' + work + '）'}`);
}

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log('\n' + '='.repeat(64));
console.log(`probe-inbox: ${pass}/${results.length} 通过${fail ? `（${fail} 条失败）` : ''}`);
if (fail) {
  for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL  ${r.name}  ${r.detail}`);
  process.exitCode = 1;
}
