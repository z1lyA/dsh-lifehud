#!/usr/bin/env node
/**
 * spike/probe-weight.mjs — LifeHud v1.1.0 体重链路的对抗性独立验证。
 *
 * 不依赖浏览器、不依赖宿主进程：直接 import Host 的 `readWeight()`，再用
 * `node:sqlite` 直接看库，最后用 fetch 打一次真实路由。
 *
 * 口径（与 plugin/index.js 对齐）：曲线 = 最近「有数据的」7 个测量日，
 * 同一天多次只留最后一次，points 升序。
 *
 * 三条自我约束：
 *   1. 只读真实库；任何破坏性实验都在 %TEMP% 的副本上做。
 *   2. mi_session.json 只在内存里读，坏 token 是「临时目录里的破坏副本」，跑完删掉。
 *   3. 不打印任何凭据（serviceToken / ssecurity / userId 一律不进日志）。
 *
 * 用法： node spike/probe-weight.mjs
 * 退出码：有 FAIL → 1，否则 0。
 */
import { DatabaseSync } from 'node:sqlite';
import {
  readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir, networkInterfaces, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWeight } from '../plugin/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
// DSH 的 Web 端口每次启动都会变（59098 → 51879 → …），所以不要写死：
//   node spike/probe-weight.mjs http://127.0.0.1:51879   或   $env:LIFEHUD_BASE=…
const BASE = String(process.argv[2] ?? process.env.LIFEHUD_BASE ?? 'http://127.0.0.1:59098').replace(/\/+$/, '');
const BASE_PORT = (() => { try { return new URL(BASE).port || '80'; } catch { return '59098'; } })();
const ROUTE = `${BASE}/lifehud/api/weight`;

// ──────────────────────────── 基础设施 ────────────────────────────
const results = [];
const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };

/** @param {string} id @param {string} name @param {() => any} fn */
async function check(id, name, fn) {
  let status = 'PASS';
  let evidence = '';
  try {
    evidence = String(await fn());
  } catch (error) {
    status = 'FAIL';
    evidence = error instanceof Error ? error.message : String(error);
  }
  results.push({ id, name, status, evidence });
  const tag = status === 'PASS' ? `${C.ok}PASS${C.off}` : `${C.bad}FAIL${C.off}`;
  console.log(`  [${tag}] ${id} ${name}\n         ${C.dim}→ ${evidence}${C.off}`);
  return status === 'PASS';
}

function note(id, name, evidence) {
  results.push({ id, name, status: 'INFO', evidence: String(evidence) });
  console.log(`  [${C.dim}INFO${C.off}] ${id} ${name}\n         ${C.dim}→ ${evidence}${C.off}`);
}

function fail(message) { throw new Error(message); }
function assert(cond, message) { if (!cond) fail(message); }
function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertAscending(dates, label) {
  for (let i = 1; i < dates.length; i += 1) {
    if (!(dates[i - 1] < dates[i])) fail(`${label}: 不是严格升序 @${i} (${dates[i - 1]} → ${dates[i]})`);
  }
}
/** 一天内多次称重只留最后一次；曲线点必须都是有限正数，不允许空洞/NaN 占位。 */
function assertCleanPoints(points, label) {
  assert(Array.isArray(points), `${label}: points 不是数组`);
  for (const [i, p] of points.entries()) {
    assert(p && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date),
      `${label}: points[${i}].date 不合法 (${JSON.stringify(p?.date)})`);
    assert(Number.isFinite(p.weight_kg) && p.weight_kg > 0,
      `${label}: points[${i}].weight_kg 不是有限正数 (${JSON.stringify(p?.weight_kg)})`);
  }
  assertAscending(points.map((p) => p.date), label);
  eq(new Set(points.map((p) => p.date)).size, points.length, `${label}: 有重复日期（同日未去重）`);
}

function uniq(list) { return [...new Set(list)]; }
function sortedAsc(list) { return [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); }
function range(list) { return `${Math.min(...list)}~${Math.max(...list)}`; }
function tableRows(list) { return list.map((p) => `${p.date}=${p.weight_kg}`).join(' '); }

// ──────────────────────────── 配置 ────────────────────────────
/** 从 cordis.patch.yml 里抠出 config 的 key/value（够用即可，不引入 yaml 解析器）。 */
function parseBundleConfig(file) {
  const text = readFileSync(file, 'utf8');
  const cfg = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s{6,}([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"')))) value = value.slice(1, -1);
    cfg[m[1]] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return cfg;
}

const CFG = parseBundleConfig(join(REPO, 'plugin', 'cordis.patch.yml'));
// 与 plugin/index.js 的默认路径保持一致：配置里没有就按标准位置推导，不依赖某个人的绝对路径。
const DATA_DIR = String(CFG.dataDir ?? join(homedir(), '.dsh', 'lifehud'));
const REAL_DB = String(CFG.weightDb ?? join(DATA_DIR, 'lifehud-weight.db'));
const REAL_SESSION = String(CFG.miSession ?? join(DATA_DIR, 'mi-session.json'));

/** 传给 readWeight 的配置：真实的那一份。 */
const realConfig = {
  dataDir: DATA_DIR,
  weightDb: REAL_DB,
  miSession: REAL_SESSION,
  miDid: CFG.miDid,
  weightTtlMs: CFG.weightTtlMs,
};

// ──────────────────────────── 临时目录（自带清理） ────────────────────────────
const TMP = join(tmpdir(), `lifehud-weight-probe-${process.pid}-${Date.now()}`);
mkdirSync(TMP, { recursive: true });
const t = (name) => join(TMP, name);

function dbOpen(dbPath, readOnly = true) {
  return new DatabaseSync(dbPath, { readOnly });
}

/** @returns {{rows:number,distinctDates:number,minDate:string|null,maxDate:string|null,minTs:number|null,maxTs:number|null}} */
function dbStats(dbPath) {
  const db = dbOpen(dbPath);
  try {
    const row = db.prepare('SELECT COUNT(*) rows, COUNT(DISTINCT date) dates, MIN(date) lo, MAX(date) hi, MIN(ts) minTs, MAX(ts) maxTs FROM weight').get();
    return { rows: row.rows, distinctDates: row.dates, minDate: row.lo, maxDate: row.hi, minTs: row.minTs, maxTs: row.maxTs };
  } finally { db.close(); }
}

/** 副本库里「剩余的最新 n 个测量日」（升序）。 */
function newestDates(dbPath, n) {
  const db = dbOpen(dbPath);
  try {
    const rows = db.prepare('SELECT DISTINCT date FROM weight ORDER BY date DESC LIMIT ?').all(n);
    return rows.map((r) => r.date).reverse();
  } finally { db.close(); }
}

function prepareCopyDb(name) {
  const target = t(name);
  copyFileSync(REAL_DB, target);
  return target;
}

/** 用坏 session + force 走 stale 路径读某个库（这样绝不会把云上的数据写回去覆盖删除）。 */
async function staleRead(dbPath, sessionPath = BAD_SESSION) {
  return readWeight({ ...realConfig, weightDb: dbPath, miSession: sessionPath }, { force: true });
}

/** 只在内存里留的真凭据，用来断言「凭据没有出现在库文件/响应体里」。绝不打印。 */
const REAL_CREDS = (() => {
  const raw = JSON.parse(readFileSync(REAL_SESSION, 'utf8'));
  return { serviceToken: String(raw.serviceToken ?? ''), ssecurity: String(raw.ssecurity ?? ''), userId: String(raw.userId ?? '') };
})();

/** 破坏副本：真 token 只出现在 %TEMP% 的这份副本里，跑完随目录一起删。 */
const BAD_SESSION = t('mi_session.bad.json');
{
  const raw = JSON.parse(readFileSync(REAL_SESSION, 'utf8'));
  raw.serviceToken = `probe-invalid-${Date.now()}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`;
  writeFileSync(BAD_SESSION, JSON.stringify(raw));
}
const BROKEN_JSON_SESSION = t('mi_session.broken.json');
writeFileSync(BROKEN_JSON_SESSION, '{"userId":"1","serviceToken": broken');
const MISSING_FIELD_SESSION = t('mi_session.missing-field.json');
writeFileSync(MISSING_FIELD_SESSION, JSON.stringify({ userId: '1', ssecurity: 'AAAA' }));
const NO_SUCH_SESSION = t('does-not-exist/mi_session.json');

const t0 = Date.now();
console.log(`\nLifeHud v1.1.0 体重链路验证  ${new Date(t0).toLocaleString('sv-SE')}`);
console.log(`真实库 ${REAL_DB}`);
console.log(`临时目录 ${TMP}`);
console.log(`会话文件 ${REAL_SESSION}（只读，不打印内容）\n`);

const realBefore = dbStats(REAL_DB);
console.log(`${C.dim}基线：真实库 ${realBefore.rows} 行 / ${realBefore.distinctDates} 个测量日 / ${realBefore.minDate} ~ ${realBefore.maxDate}${C.off}\n`);

let syncedSnapshot = null;

try {
  // ════════════════ 1. 云端可用 ════════════════
  console.log('1) 云端可用');
  await check('1.1', 'readWeight({force:true}) 成功取云并落库', async () => {
    const snap = await readWeight(realConfig, { force: true });
    syncedSnapshot = snap;
    eq(snap.ok, true, 'ok');
    eq(snap.stale, false, 'stale');
    eq(snap.reason, null, 'reason');
    assert(Number.isFinite(snap.lastSyncAt) && snap.lastSyncAt > 0, `lastSyncAt 不合法 (${snap.lastSyncAt})`);
    assert(snap.archived > 0, `archived 应 > 0，实际 ${snap.archived}`);
    assert(Array.isArray(snap.points) && snap.points.length > 0, 'points 为空');
    return `ok=true stale=false reason=null archived=${snap.archived} points=${snap.points.length} 跨度 ${snap.points[0].date}~${snap.points.at(-1).date}`;
  });

  await check('1.2', '曲线口径：≤7 个测量日、升序、无重复、无 NaN', async () => {
    const snap = syncedSnapshot;
    assertCleanPoints(snap.points, 'curve');
    assert(snap.points.length <= 7, `点数 ${snap.points.length} > 7`);
    return `${snap.points.length} 个点：${tableRows(snap.points)}`;
  });

  await check('1.3', '云上的条数与本地库一致（archived vs COUNT(*)>distinctDates 的关系）', async () => {
    const stats = dbStats(REAL_DB);
    assert(stats.rows === syncedSnapshot.archived,
      `archived=${syncedSnapshot.archived} 但本地 ${stats.rows} 行（同 weight_id 幂等时两者应相等）`);
    return `archived=${syncedSnapshot.archived} = 本地 ${stats.rows} 行 / ${stats.distinctDates} 个测量日（多次称重合并成一天）`;
  });

  // ════════════════ 2. 落库正确 ════════════════
  console.log('\n2) 落库正确（node:sqlite 直读）');
  const dbMain = dbOpen(REAL_DB);
  try {
    await check('2.1', 'weight_id 是 TEXT 且无 .0 尾巴（能当主键去重）', async () => {
      const types = dbMain.prepare("SELECT COUNT(*) n, SUM(typeof(weight_id)='text') ok FROM weight").get();
      eq(types.ok, types.n, 'typeof(weight_id)=text 的行数');
      const dotted = dbMain.prepare("SELECT COUNT(*) n FROM weight WHERE weight_id LIKE '%.%'").get().n;
      eq(dotted, 0, "weight_id 含 '.' 的行数");
      const nonNumeric = dbMain.prepare("SELECT COUNT(*) n FROM weight WHERE weight_id GLOB '*[^0-9]*'").get().n;
      eq(nonNumeric, 0, 'weight_id 含非数字字符的行数');
      return `${types.n}/${types.n} 行 typeof='text'，0 行含 '.'，0 行含非数字`;
    });

    await check('2.2', 'ts 是整数且单位是「秒」（与 weight_id/1000 吻合）', async () => {
      const types = dbMain.prepare("SELECT COUNT(*) n, SUM(typeof(ts)='integer') ok FROM weight").get();
      eq(types.ok, types.n, 'typeof(ts)=integer 的行数');
      const mismatch = dbMain.prepare('SELECT COUNT(*) n FROM weight WHERE CAST(weight_id AS INTEGER)/1000 <> ts').get().n;
      eq(mismatch, 0, 'ts ≠ floor(weight_id/1000) 的行数');
      const wild = dbMain.prepare('SELECT COUNT(*) n FROM weight WHERE ts < 1500000000 OR ts > 3000000000').get().n;
      eq(wild, 0, 'ts 落在 2017~2065 之外的行数');
      return `${types.n}/${types.n} 行 integer，且 ts 全部 = floor(weight_id/1000)（秒），范围 ${dbMain.prepare('SELECT MIN(ts) a, MAX(ts) b FROM weight').get().a}~${dbMain.prepare('SELECT MAX(ts) b FROM weight').get().b}`;
    });

    await check('2.3', 'date 是本地时区 YYYY-MM-DD，且与 measured_at 一致', async () => {
      const bad = dbMain.prepare("SELECT COUNT(*) n FROM weight WHERE date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'").get().n;
      eq(bad, 0, 'date 不是 YYYY-MM-DD 的行数');
      const offMeasured = dbMain.prepare("SELECT COUNT(*) n FROM weight WHERE measured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND date <> SUBSTR(measured_at,1,10)").get().n;
      eq(offMeasured, 0, 'date ≠ measured_at 前缀的行数');
      const offLocal = dbMain.prepare("SELECT COUNT(*) n FROM weight WHERE strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') <> date").get().n;
      eq(offLocal, 0, 'date ≠ strftime(ts,localtime) 的行数（时区口径不一致）');
      const total = dbMain.prepare('SELECT COUNT(*) n FROM weight').get().n;
      return `${total} 行全部通过：格式合法 / 与 measured_at 前缀一致 / 等于 strftime(ts,'unixepoch','localtime')`;
    });

    await check('2.4', 'weight_kg 落在合理范围 40~150kg', async () => {
      const r = dbMain.prepare('SELECT COUNT(*) n, MIN(weight_kg) a, MAX(weight_kg) b, SUM(weight_kg < 40 OR weight_kg > 150) out FROM weight').get();
      eq(r.out, 0, '越界的行数');
      assert(r.n > 0, '库里没有数据');
      return `${r.n} 行，范围 ${r.a}~${r.b} kg，越界 0 行`;
    });

    await check('2.5', 'meta.lastSyncAt 是毫秒时间戳（前端 relTime 依赖它）', async () => {
      const row = dbMain.prepare("SELECT value FROM meta WHERE key='lastSyncAt'").get();
      assert(row, 'meta.lastSyncAt 不存在');
      const ms = Number(row.value);
      assert(Number.isFinite(ms) && ms > 1.5e12 && ms < 3e12, `lastSyncAt 不像毫秒时间戳 (${row.value})`);
      const ageMin = ((Date.now() - ms) / 60000).toFixed(1);
      return `lastSyncAt=${ms}（${ageMin} 分钟前）`;
    });

    await check('2.6', '同日多次称重保留的是「最后一次」（不是第一条）', async () => {
      const dupDays = dbMain.prepare('SELECT date, COUNT(*) n FROM weight GROUP BY date HAVING n > 1 ORDER BY date DESC').all();
      if (dupDays.length === 0) return '本库没有同日多次记录的样本，跳过（不构成失败）';
      const newestCached = syncedSnapshot.points.at(-1);
      const dbLast = dbMain.prepare('SELECT weight_kg FROM weight WHERE date = ? ORDER BY ts DESC LIMIT 1').get(newestCached.date);
      eq(dbLast.weight_kg, newestCached.weight_kg, `最新日 ${newestCached.date} 的曲线值应为当天最后一次`);
      return `${dupDays.length} 个多称日，最新日 ${newestCached.date} 曲线值 = 当天 ts 最大的那条 (${dbLast.weight_kg}kg)`;
    });

    await check('2.7', '凭据不落库、不落响应（serviceToken / ssecurity 不进 SQLite、不进 JSON）', async () => {
      const bytes = readFileSync(REAL_DB);
      const body = JSON.stringify(await readWeight(realConfig, { force: true }));
      const leaked = [];
      for (const [key, value] of Object.entries(REAL_CREDS)) {
        if (value.length < 12) continue; // 太短的值在二进制里可能巧合命中，不做字节搜索
        if (bytes.includes(Buffer.from(value))) leaked.push(`${key}@db`);
        if (body.includes(value)) leaked.push(`${key}@response`);
      }
      eq(leaked.join(','), '', '泄漏位置');
      return `库文件 ${(bytes.length / 1024).toFixed(0)}KB 与响应体里都搜不到 serviceToken/ssecurity（userId 单独在 7.9 查）`;
    });

    await check('2.8', '不信任已解析的列：从 raw_json 独立重算曲线，结果一致', async () => {
      const snap = await readWeight(realConfig, { force: true });
      const rows = dbMain.prepare('SELECT weight_id, ts, date, weight_kg, measured_at, raw_json FROM weight').all();
      assert(rows.length > 0, '库里没有数据');
      for (const row of rows) {
        let v;
        try { v = JSON.parse(row.raw_json); } catch { fail(`raw_json 不是合法 JSON（weight_id=${row.weight_id}）`); }
        eq(String(v.weightId).replace(/\.0+$/, ''), row.weight_id, `raw_json.weightId vs weight_id（${row.weight_id}）`);
        eq(String(v.createTime ?? ''), row.measured_at, `raw_json.createTime vs measured_at（${row.weight_id}）`);
        eq(String(v.createTime ?? '').slice(0, 10), row.date, `raw_json.createTime 日期 vs date（${row.weight_id}）`);
        assert(Math.abs(Number(v.weight) - Number(row.weight_kg)) < 0.006,
          `raw_json.weight vs weight_kg（${row.weight_id}: ${v.weight} vs ${row.weight_kg}）`);
      }
      // 完全独立地（只读原始云记录）重放「最近 7 个有数据的测量日」口径。
      const byTs = [...rows].sort((a, b) => b.ts - a.ts);
      const seen = new Set();
      const expected = [];
      for (const row of byTs) {
        if (seen.has(row.date)) continue;
        seen.add(row.date);
        expected.push({ date: row.date, weight_kg: Number(row.weight_kg) });
        if (expected.length >= 7) break;
      }
      expected.reverse();
      eq(JSON.stringify(snap.points), JSON.stringify(expected), 'raw_json 重算的曲线 vs readWeight 返回');
      return `${rows.length} 条原始记录逐字段自洽，重算曲线 ${expected.length} 点与返回值完全一致`;
    });
  } finally { dbMain.close(); }

  // ════════════════ 3. 幂等 ════════════════
  console.log('\n3) 幂等（连跑 force 不涨行数）');
  await check('3.1', '同一批云数据重复 force 同步，行数不变', async () => {
    const before = dbStats(REAL_DB);
    await readWeight(realConfig, { force: true });
    const mid = dbStats(REAL_DB);
    await readWeight(realConfig, { force: true });
    const after = dbStats(REAL_DB);
    if (after.rows !== before.rows) {
      // 唯一合法的变化是「用户刚好又称了一次」：新行必须比基线更新。
      const db = dbOpen(REAL_DB);
      let fresh;
      try {
        fresh = db.prepare('SELECT COUNT(*) n FROM weight WHERE ts * 1000 > ?').get(before.maxTs * 1000).n;
      } finally { db.close(); }
      assert(fresh === after.rows - before.rows,
        `行数 ${before.rows} → ${after.rows}，且多出来的不是「更新的记录」（新 ts 行数=${fresh}）→ 不是幂等，是在重复插入/删改`);
      return `行数 ${before.rows} → ${mid.rows} → ${after.rows}；新增的 ${fresh} 行 ts 都更新（真实新称重），不是重复插入`;
    }
    return `COUNT(*) ${before.rows} → ${mid.rows} → ${after.rows}（两次 force 都按 weight_id upsert，无重复）`;
  });

  await check('3.2', '库里的主键它就是主键：weight_id 无重复且被唯一约束覆盖', async () => {
    const db = dbOpen(REAL_DB);
    try {
      const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='weight'").get()?.sql ?? '';
      assert(/weight_id\s+TEXT\s+PRIMARY\s+KEY/i.test(idx), `weight 表定义里没有 weight_id TEXT PRIMARY KEY：${idx.replace(/\s+/g, ' ')}`);
      const dup = db.prepare('SELECT COUNT(*) n FROM (SELECT weight_id FROM weight GROUP BY weight_id HAVING COUNT(*) > 1)').get().n;
      eq(dup, 0, '重复 weight_id 组数');
      return `weight_id TEXT PRIMARY KEY 存在，0 组重复`;
    } finally { db.close(); }
  });

  // ════════════════ 4. 7 天口径 + 缺失日 ════════════════
  console.log('\n4) 最近 7 个「有数据的」测量日（临时副本库上删数据）');
  await check('4.1', '未删任何数据时：曲线 = 本地最新 7 个测量日（与 Live 路由一致）', async () => {
    const copy = prepareCopyDb('full.db');
    const snap = await staleRead(copy);
    eq(snap.stale, true, `stale（坏 session 必须降级）`);
    assertCleanPoints(snap.points, 'full.db');
    const expected = newestDates(copy, 7);
    eq(snap.points.length, expected.length, '点数 vs 库里最新 7 个测量日');
    eq(snap.points.map((p) => p.date).join(','), expected.join(','), '曲线日期序列');
    return `${snap.points.length} 点 = 库内最新 7 个测量日 ${expected.join(' / ')}`;
  });

  await check('4.2', '缺失日不断链：中间挖掉日期后仍升序、点数 = min(7, 剩余不同日期数)', async () => {
    const copy = prepareCopyDb('gaps.db');
    const newest12 = newestDates(copy, 12);
    assert(newest12.length >= 9, `样本不够（只有 ${newest12.length} 个测量日）`);
    const removed = [newest12[3], newest12[6]];
    const db = dbOpen(copy, false);
    try {
      const stmt = db.prepare('DELETE FROM weight WHERE date = ?');
      for (const d of removed) stmt.run(d);
    } finally { db.close(); }
    const remaining = newestDates(copy, 99);
    const snap = await staleRead(copy);
    assertCleanPoints(snap.points, 'gaps.db');
    eq(snap.points.length, Math.min(7, remaining.length), `点数应 = min(7, ${remaining.length})`);
    const expected = remaining.slice(-7);
    eq(snap.points.map((p) => p.date).join(','), expected.join(','), '曲线日期序列（应跳过被删的日期，不补空点）');
    assert(!snap.points.some((p) => removed.includes(p.date)), `被删的日期 ${removed.join('/')} 又出现在曲线里`);
    eq(new Set(snap.points.map((p) => p.date)).size, 7, '去重后仍是 7 个不同日期');
    return `删掉 ${removed.join(' / ')} 后剩 ${remaining.length} 天 → 返回 ${snap.points.length} 点，日期 ${expected[0]}~${expected.at(-1)}，无空洞/NaN`;
  });

  await check('4.3', '不足 7 天时返回实际点数（只留 3 天）', async () => {
    const copy = prepareCopyDb('three.db');
    const keep = newestDates(copy, 3);
    const db = dbOpen(copy, false);
    try {
      const stmt = db.prepare('DELETE FROM weight WHERE date NOT IN (?, ?, ?)');
      stmt.run(keep[0], keep[1], keep[2]);
    } finally { db.close(); }
    eq(dbStats(copy).distinctDates, 3, '副本剩余测量日');
    const snap = await staleRead(copy);
    assertCleanPoints(snap.points, 'three.db');
    eq(snap.points.length, 3, '点数');
    eq(snap.points.map((p) => p.date).join(','), sortedAsc(keep).join(','), '日期序列');
    return `只剩 3 个测量日 → 返回 ${snap.points.length} 点（min(7,3)），升序 ${keep.join(' / ')}`;
  });

  await check('4.4', '空库不炸：0 个测量日 → points=[]', async () => {
    const copy = prepareCopyDb('empty.db');
    const db = dbOpen(copy, false);
    try { db.exec('DELETE FROM weight'); } finally { db.close(); }
    const snap = await staleRead(copy);
    eq(snap.stale, true, 'stale');
    assert(Array.isArray(snap.points) && snap.points.length === 0, `points 应为空数组，实际 ${JSON.stringify(snap.points)}`);
    return `空库 → points=[]，stale=true，不抛异常`;
  });

  await check('4.5', '同一天多条：曲线只保留最后一次（临时库里造 3 条同日记录）', async () => {
    const copy = prepareCopyDb('same-day.db');
    const target = newestDates(copy, 1)[0];
    const db = dbOpen(copy, false);
    try {
      const base = db.prepare('SELECT MAX(ts) ts FROM weight').get().ts;
      const ins = db.prepare('INSERT INTO weight (weight_id, ts, date, weight_kg, measured_at, raw_json) VALUES (?,?,?,?,?,?)');
      ins.run(String((base + 100) * 1000), base + 100, target, 11.11, `${target} 23:00:00`, '{}');
      ins.run(String((base + 200) * 1000), base + 200, target, 22.22, `${target} 23:30:00`, '{}');
    } finally { db.close(); }
    const snap = await staleRead(copy);
    assertCleanPoints(snap.points, 'same-day.db');
    const last = snap.points.at(-1);
    eq(last.date, target, '曲线最后一点日期');
    eq(last.weight_kg, 22.22, `同日应保留 ts 最大那条（22.22），实际 ${last.weight_kg}`);
    eq(new Set(snap.points.map((p) => p.date)).size, snap.points.length, '同日是否被重复计点');
    return `${target} 造 3 条（含 11.11 / 22.22）→ 曲线仍只有 1 个该日点，取值 22.22（ts 最大）`;
  });

  // ════════════════ 5. stale 降级 ════════════════
  console.log('\n5) stale 降级（坏 session / 缺文件，都不许抛）');
  await check('5.1', '坏 token + force → stale=true / reason=session-expired / points 仍来自本地', async () => {
    const snap = await staleRead(REAL_DB);
    eq(snap.stale, true, 'stale');
    eq(snap.reason, 'session-expired', 'reason');
    assert(snap.points.length > 0, 'stale 时 points 不应为空（本地库有数据）');
    assertCleanPoints(snap.points, 'stale curve');
    assert(typeof snap.error === 'string' && snap.error.length > 0, 'error 说明缺失');
    assert(!/probe-invalid/i.test(JSON.stringify(snap)), '返回体里泄漏了被破坏的 token');
    return `stale=true reason=session-expired points=${snap.points.length}（本地） error="${snap.error.slice(0, 40)}…" 未抛异常`;
  });

  await check('5.2', 'miSession 指向不存在的路径 → stale=true / session-expired，不抛', async () => {
    const snap = await staleRead(REAL_DB, NO_SUCH_SESSION);
    eq(snap.stale, true, 'stale');
    eq(snap.reason, 'session-expired', 'reason');
    assert(snap.points.length > 0, 'points 不应为空');
    return `stale=true reason=session-expired points=${snap.points.length}，error="${snap.error.slice(0, 40)}…"`;
  });

  await check('5.3', 'session 文件是坏 JSON / 缺字段 → 同样 session-expired，不抛', async () => {
    const brokenJson = await staleRead(REAL_DB, BROKEN_JSON_SESSION);
    eq(brokenJson.reason, 'session-expired', '坏 JSON 的 reason');
    const missingField = await staleRead(REAL_DB, MISSING_FIELD_SESSION);
    eq(missingField.reason, 'session-expired', '缺字段的 reason');
    assert(missingField.points.length > 0, '缺字段时 points 不应为空');
    return `坏 JSON → reason=session-expired；缺 serviceToken → reason=session-expired（error="${missingField.error.slice(0, 30)}…"）`;
  });

  await check('5.4', '本地库也没有（全新路径）→ stale=true, points=[]，不抛', async () => {
    const freshDb = t('fresh/nested/weight.db');
    const snap = await staleRead(freshDb);
    eq(snap.stale, true, 'stale');
    assert(Array.isArray(snap.points) && snap.points.length === 0, `points 应为 []，实际 ${JSON.stringify(snap.points)}`);
    assert(existsSync(freshDb), '应顺手把库建出来（openWeightDb 会 mkdir）');
    return `全新库路径 → stale=true reason=${snap.reason} points=[]，库文件被自动创建`;
  });

  await check('5.5', 'weightDb 完全没配（空 config）→ 走 local 分支，不抛', async () => {
    const snap = await readWeight({ miSession: BAD_SESSION }, { force: true });
    eq(snap.stale, true, 'stale');
    assert(Array.isArray(snap.points) && snap.points.length === 0, 'points 应为 []');
    note('5.5b', '此时 reason 的实际值（session 先失败，故报 session-expired；库路径为空）', `reason=${snap.reason}`);
    return `空 config → stale=true reason=${snap.reason} points=[]，不抛异常`;
  });

  await check('5.6', 'stale 读取不写坏真实库（行数/日期跨度不变）', async () => {
    const stats = dbStats(REAL_DB);
    eq(stats.rows, realBefore.rows, '真实库行数');
    eq(stats.maxDate, realBefore.maxDate, '真实库最新日期');
    return `多次 stale 读取后真实库仍是 ${stats.rows} 行 / ${stats.distinctDates} 个测量日（最新 ${stats.maxDate}）`;
  });

  await check('5.7', 'reason 分类准确：云侧业务错误 → cloud（不是 session-expired）', async () => {
    const copy = prepareCopyDb('wrong-did.db');
    const snap = await readWeight({ ...realConfig, weightDb: copy, miDid: 'blt.9.thisdevicecannotexist' }, { force: true });
    eq(snap.stale, true, 'stale');
    eq(snap.reason, 'cloud', `reason（error=${snap.error}）`);
    assert(snap.points.length > 0, 'stale 时本地曲线应保留');
    return `错误 did → stale=true reason=cloud points=${snap.points.length}（本地），error="${snap.error}"；没有误判成会话过期`;
  });

  await check('5.8', 'reason 分类准确：网络不可达 → network（stub fetch，不碰真网络）', async () => {
    const realFetch = globalThis.fetch;
    let stubbed = 0;
    globalThis.fetch = async () => { stubbed += 1; throw new TypeError('fetch failed (probe stub)'); };
    let snap;
    try {
      snap = await readWeight(realConfig, { force: true });
    } finally { globalThis.fetch = realFetch; }
    eq(stubbed, 1, '被 stub 的 fetch 调用次数');
    eq(snap.stale, true, 'stale');
    eq(snap.reason, 'network', 'reason');
    assert(snap.points.length > 0, '本地曲线应保留');
    return `fetch 抛错 → stale=true reason=network points=${snap.points.length}，不抛异常`;
  });

  await check('5.9', 'reason 分类准确：本地库写不进去 → local，且不卡死', async () => {
    const copy = prepareCopyDb('locked.db');
    const holder = new DatabaseSync(copy);
    holder.exec('BEGIN EXCLUSIVE');
    const started = Date.now();
    let snap;
    try {
      snap = await readWeight({ ...realConfig, weightDb: copy }, { force: true });
    } finally {
      try { holder.exec('ROLLBACK'); } catch { /* ignore */ }
      holder.close();
    }
    const ms = Date.now() - started;
    eq(snap.stale, true, 'stale');
    eq(snap.reason, 'local', `reason（error=${snap.error}）`);
    assert(ms < 15000, `被锁时耗时 ${ms}ms，像卡死`);
    note('5.9b', '库被独占锁定时本地曲线也读不出来，stale 降级只能给空曲线',
      `points=${snap.points.length} lastSyncAt=${snap.lastSyncAt}（不是崩溃，但卡片会退化成占位文案）`);
    return `独占锁 → stale=true reason=local points=${snap.points.length}，${ms}ms 内返回（未卡死），error="${snap.error?.slice(0, 30)}…"`;
  });

  await check('5.10', 'stale 不伪造新鲜度：降级读不会更新 meta.lastSyncAt', async () => {
    const copy = prepareCopyDb('nofake.db');
    const before = dbStats(copy);
    const readMeta = () => {
      const h = dbOpen(copy);
      try { return h.prepare("SELECT value FROM meta WHERE key='lastSyncAt'").get()?.value; } finally { h.close(); }
    };
    const metaBefore = readMeta();
    await staleRead(copy);
    const metaAfter = readMeta();
    eq(metaAfter, metaBefore, 'stale 读前后的 meta.lastSyncAt');
    const after = dbStats(copy);
    eq(after.rows, before.rows, 'stale 读前后的行数');
    return `stale 读前后 meta.lastSyncAt 保持 ${metaBefore}（前端因此能显示「最后同步：X 小时前」），行数 ${after.rows} 不变`;
  });

  await check('5.11', '云返回「空 result」时不误删本地数据（但会刷新 lastSyncAt）', async () => {
    const copy = prepareCopyDb('empty-cloud.db');
    const before = dbStats(copy);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200, ok: true, text: async () => JSON.stringify({ code: 0, result: [] }),
    });
    let snap;
    try {
      snap = await readWeight({ ...realConfig, weightDb: copy }, { force: true });
    } finally { globalThis.fetch = realFetch; }
    const after = dbStats(copy);
    eq(after.rows, before.rows, '空云结果同步后的行数（不许把本地行删掉）');
    eq(snap.archived, 0, 'archived');
    eq(snap.points.length, 7, '曲线仍应来自本地');
    note('5.11b', '「静默假新鲜」风险：云成功但 0 条时 stale=false 且 lastSyncAt=刚刚',
      `返回 stale=${snap.stale} reason=${snap.reason} archived=${snap.archived}，前端不看 archived，卡片会显示「最后同步：刚刚」（建议前端对 archived===0 降级提示）`);
    return `${before.rows} 行一行没删，points=${snap.points.length}（本地）；但 stale=false archived=0 → 见 5.11b`;
  });

  await check('5.12', '云返回不可解析的乱码 → reason=cloud，本地曲线保留，不抛', async () => {
    const copy = prepareCopyDb('garbage-cloud.db');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200, ok: true, text: async () => 'this-is-not-json-nor-rc4-ciphertext',
    });
    let snap;
    try {
      snap = await readWeight({ ...realConfig, weightDb: copy }, { force: true });
    } finally { globalThis.fetch = realFetch; }
    eq(snap.stale, true, 'stale');
    eq(snap.reason, 'cloud', `reason（error=${snap.error}）`);
    eq(snap.points.length, 7, '本地曲线');
    return `乱码响应 → stale=true reason=cloud points=${snap.points.length}，error="${snap.error?.slice(0, 34)}…"`;
  });

  // ════════════════ 6. TTL / force ════════════════
  console.log('\n6) TTL 与 force 语义');
  await check('6.1', '非 force 连调两次 → lastSyncAt 相同（第二次走缓存）且明显更快', async () => {
    // 换一个 dbPath → 打掉模块级缓存（weightCache 按 dbPath 分键），确保第一次是真实打云。
    const ttlDb = prepareCopyDb('ttl.db');
    const cfg = { ...realConfig, weightDb: ttlDb };

    const s1t = process.hrtime.bigint();
    const s1 = await readWeight(cfg, { force: false });
    const ms1 = Number(process.hrtime.bigint() - s1t) / 1e6;
    eq(s1.stale, false, '第一次应成功打云（stale=false）');

    const s2t = process.hrtime.bigint();
    const s2 = await readWeight(cfg, { force: false });
    const ms2 = Number(process.hrtime.bigint() - s2t) / 1e6;

    eq(s2.lastSyncAt, s1.lastSyncAt, 'TTL 内两次的 lastSyncAt');
    eq(s2.archived, s1.archived, 'TTL 内两次的 archived');
    assert(ms2 < ms1, `第二次(${ms2.toFixed(0)}ms) 不比第一次(${ms1.toFixed(0)}ms) 快 → 没走缓存`);
    assert(ms2 < 100, `第二次 ${ms2.toFixed(0)}ms，不像纯内存缓存命中`);

    const s3t = process.hrtime.bigint();
    const s3 = await readWeight(cfg, { force: true });
    const ms3 = Number(process.hrtime.bigint() - s3t) / 1e6;
    assert(s3.lastSyncAt > s2.lastSyncAt, `force 后 lastSyncAt 没变新 (${s2.lastSyncAt} → ${s3.lastSyncAt})`);
    return `非force#1 ${ms1.toFixed(0)}ms lastSyncAt=${s1.lastSyncAt} → 非force#2 ${ms2.toFixed(1)}ms 同值(缓存) → force ${ms3.toFixed(0)}ms lastSyncAt=${s3.lastSyncAt}(更新)`;
  });

  await check('6.2', 'TTL 是「按 dbPath 分键」的：换库不会串味', async () => {
    const otherDb = prepareCopyDb('other.db');
    const snap = await readWeight({ ...realConfig, weightDb: otherDb }, { force: false });
    eq(snap.stale, false, 'stale');
    assert(Number.isFinite(snap.lastSyncAt), 'lastSyncAt');
    // 用另一个库路径再读一次，lastSyncAt 必须是「这次」同步的，而不是上一个库的缓存值。
    const otherDb2 = prepareCopyDb('other2.db');
    const snap2 = await readWeight({ ...realConfig, weightDb: otherDb2 }, { force: false });
    assert(snap2.lastSyncAt >= snap.lastSyncAt, `换库后 lastSyncAt 倒退 (${snap.lastSyncAt} → ${snap2.lastSyncAt})`);
    return `两个不同 dbPath 分别同步：${snap.lastSyncAt} → ${snap2.lastSyncAt}，未命中彼此缓存`;
  });

  await check('6.3', 'weightTtlMs 有下限保护（>=60s），不会配成 0 导致狂刷云', async () => {
    const src = readFileSync(join(REPO, 'plugin', 'index.js'), 'utf8');
    assert(/Math\.max\(\s*60000\s*,\s*Number\(config\.weightTtlMs/.test(src), '没找到 TTL 下限保护 Math.max(60000, …)');
    const ttlDb = prepareCopyDb('ttlmin.db');
    const s1 = await readWeight({ ...realConfig, weightDb: ttlDb, weightTtlMs: 0 }, { force: false });
    const s2 = await readWeight({ ...realConfig, weightDb: ttlDb, weightTtlMs: 0 }, { force: false });
    eq(s2.lastSyncAt, s1.lastSyncAt, 'weightTtlMs=0 时第二次仍应命中缓存（下限 60s）');
    return `weightTtlMs=0 → 下限 60s 生效，第二次仍 lastSyncAt=${s2.lastSyncAt}（未狂刷）`;
  });

  await check('6.4', '并发单飞按库分键：同库并发只发一次云请求，不同库各发各的（互不串数据）', async () => {
    const dbA = prepareCopyDb('inflight-a.db');
    const dbB = prepareCopyDb('inflight-b.db');
    // 让 B 的库和 A 不一样：删掉 B 里最新的 3 个测量日。
    const gone = newestDates(dbB, 3);
    const hb = dbOpen(dbB, false);
    try {
      const stmt = hb.prepare('DELETE FROM weight WHERE date = ?');
      for (const d of gone) stmt.run(d);
    } finally { hb.close(); }

    const realFetch = globalThis.fetch;
    let cloudCalls = 0;
    globalThis.fetch = (...args) => { cloudCalls += 1; return realFetch(...args); };

    // 同一个库并发两次 → 单飞生效，只该发一次云请求。
    let a1;
    let a2;
    try {
      [a1, a2] = await Promise.all([
        readWeight({ ...realConfig, weightDb: dbA }, { force: true }),
        readWeight({ ...realConfig, weightDb: dbA }, { force: true }),
      ]);
    } finally { /* 恢复 fetch 放到最后 */ }
    eq(cloudCalls, 1, '同库并发两次 → 云端请求数');
    assert(a1 === a2, '同库并发应返回同一个 snapshot 对象（单飞生效）');

    // 换一个库并发，且给 B 一个坏 session：
    // B 走 stale 分支、只读自己的库；如果单飞还按「有没有在飞」合并，B 就会拿到 A 的云端曲线。
    let a3;
    let b;
    try {
      [a3, b] = await Promise.all([
        readWeight({ ...realConfig, weightDb: dbA }, { force: true }),
        readWeight({ ...realConfig, weightDb: dbB, miSession: BAD_SESSION }, { force: true }),
      ]);
    } finally { globalThis.fetch = realFetch; }
    eq(cloudCalls, 3, '不同库并发 → 云端请求数应为 1(同库合并) + 2(每库各一次)');
    eq(b.stale, true, 'B 用坏 session 应走 stale 分支');
    const contaminated = b.points.filter((p) => gone.includes(p.date)).map((p) => p.date);
    eq(contaminated.length, 0, `B 的曲线不应包含 B 库里已被删掉的日期（${gone.join('/')}），否则就是拿到了 A 的数据`);
    assert(a3 !== b, '不同库的并发调用不应返回同一个 snapshot 对象');
    const aHasGone = a3.points.some((p) => gone.includes(p.date));
    assert(aHasGone, 'A 走云端，曲线里应仍有那些日期（作为对照组）');
    return `同库并发 → 只发 1 次云请求且同一 snapshot；不同库并发 → 各发各的（B stale 只读自己的库，已删日期 ${gone.join('/')} 未出现，A 仍有）`;
  });

  await check('6.5', 'stale 之后修好 session：force 立刻恢复最新（非 force 要等 TTL 过期）', async () => {
    const copy = prepareCopyDb('recover.db');
    const cfg = { ...realConfig, weightDb: copy };
    const stale = await readWeight({ ...cfg, miSession: BAD_SESSION }, { force: true });
    eq(stale.stale, true, '坏 session 的 stale');
    // 不带 force：会被 TTL 里的 stale 快照挡住（这是设计取舍，不是崩溃）
    const cached = await readWeight(cfg, { force: false });
    note('6.5b', 'stale 快照也会写进 10 分钟 TTL 缓存',
      `修好 session 后不带 force 仍返回 stale=${cached.stale} reason=${cached.reason}（0ms，没重试云）；界面刷新按钮走 ?force=1，所以用户无感`);
    const fresh = await readWeight(cfg, { force: true });
    eq(fresh.stale, false, 'force 后 stale');
    assert(fresh.lastSyncAt > (stale.lastSyncAt ?? 0), `force 后 lastSyncAt 应变新 (${stale.lastSyncAt} → ${fresh.lastSyncAt})`);
    return `坏 session(stale) → 非 force 仍 stale(缓存) → force 立刻 stale=false，lastSyncAt ${stale.lastSyncAt} → ${fresh.lastSyncAt}`;
  });

  // ════════════════ 7. 路由鉴权 + 契约 ════════════════
  // DSH 的 Web 端口每次启动都会变，所以「没给地址」不算失败，直接跳过这一组。
  const hasBase = Boolean(process.argv[2] ?? process.env.LIFEHUD_BASE ?? '');
  if (!hasBase) {
    note('7.0', '未指定 DSH 地址 → 跳过第 7 组（路由契约 / 鉴权）',
      '要跑这一组：node spike/probe-weight.mjs http://127.0.0.1:<DSH 窗口地址栏里的端口>');
  } else {
  console.log('\n7) 路由鉴权 + 契约');
  let liveBody = null;
  await check('7.1', 'GET /lifehud/api/weight → 200，字段名/类型符合契约', async () => {
    const res = await fetch(ROUTE, { signal: AbortSignal.timeout(30000) });
    eq(res.status, 200, 'HTTP 状态');
    const ctype = String(res.headers.get('content-type') ?? '');
    assert(ctype.startsWith('application/json'), `content-type 是 ${ctype}（前端 res.json() 依赖它）`);
    eq(String(res.headers.get('cache-control') ?? ''), 'no-store', 'cache-control（force 刷新必须绕开浏览器缓存）');
    liveBody = await res.json();
    const allowed = new Set(['ok', 'stale', 'reason', 'lastSyncAt', 'points', 'archived', 'error']);
    const extra = Object.keys(liveBody).filter((k) => !allowed.has(k));
    eq(extra.join(','), '', '契约外的多余字段');
    eq(typeof liveBody.ok, 'boolean', 'typeof ok');
    eq(typeof liveBody.stale, 'boolean', 'typeof stale');
    assert(liveBody.reason === null || typeof liveBody.reason === 'string', `reason 类型 ${typeof liveBody.reason}`);
    assert(Number.isFinite(liveBody.lastSyncAt), `lastSyncAt 类型 ${typeof liveBody.lastSyncAt}`);
    assert(Array.isArray(liveBody.points), 'points 不是数组');
    assertCleanPoints(liveBody.points, 'live points');
    return `200 ${ctype} + cache-control=${res.headers.get('cache-control')}；键=[${Object.keys(liveBody).join(',')}]；points=${liveBody.points.length} stale=${liveBody.stale} archived=${liveBody.archived}`;
  });

  await check('7.2', '路由返回的点 = 本地库最新 7 个测量日（Host 进程与我读的是同一份口径）', async () => {
    const expected = newestDates(REAL_DB, 7);
    eq(liveBody.points.map((p) => p.date).join(','), expected.join(','), '路由日期序列');
    const db = dbOpen(REAL_DB);
    let pairs;
    try {
      pairs = db.prepare('SELECT date, weight_kg FROM weight WHERE weight_id IN (SELECT weight_id FROM weight w1 WHERE ts = (SELECT MAX(ts) FROM weight w2 WHERE w2.date = w1.date))').all();
    } finally { db.close(); }
    const map = new Map(pairs.map((r) => [r.date, r.weight_kg]));
    for (const p of liveBody.points) eq(p.weight_kg, map.get(p.date), `${p.date} 的重量（应为当天 ts 最大那条）`);
    return `${liveBody.points.length} 点逐日核对通过：${tableRows(liveBody.points)}`;
  });

  await check('7.3', '?force=1 → 200 且绕过 TTL（lastSyncAt 变新）', async () => {
    const before = liveBody.lastSyncAt;
    const res = await fetch(`${ROUTE}?force=1`, { signal: AbortSignal.timeout(30000) });
    eq(res.status, 200, 'HTTP 状态');
    const body = await res.json();
    eq(body.stale, false, 'force 请求的 stale');
    assert(body.lastSyncAt > before, `force 后 lastSyncAt 没变新 (${before} → ${body.lastSyncAt})`);
    return `force=1 → 200，lastSyncAt ${before} → ${body.lastSyncAt}`;
  });

  await check('7.4', 'POST → 405（只读端点）', async () => {
    const res = await fetch(ROUTE, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10000) });
    eq(res.status, 405, 'POST 状态');
    const body = await res.json();
    eq(body.ok, false, 'POST 响应 ok');
    return `POST → 405 ${JSON.stringify(body)}`;
  });

  await check('7.5', 'PUT/DELETE → 405', async () => {
    const put = await fetch(ROUTE, { method: 'PUT', body: '{}', signal: AbortSignal.timeout(10000) });
    const del = await fetch(ROUTE, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
    eq(put.status, 405, 'PUT 状态');
    eq(del.status, 405, 'DELETE 状态');
    return `PUT → ${put.status}，DELETE → ${del.status}`;
  });

  await check('7.6', '每个 handler 都先过 isLocalPeer（静态审查）', async () => {
    const src = readFileSync(join(REPO, 'plugin', 'index.js'), 'utf8');
    const handlers = [...src.matchAll(/\((?:req),\s*(?:res)\)\s*=>\s*\{/g)];
    assert(handlers.length > 0, '没找到任何 (req, res) handler');
    const guardless = [];
    for (const m of handlers) {
      const body = src.slice(m.index, m.index + 600);
      if (!/isLocalPeer\(req\)/.test(body)) guardless.push(m.index);
    }
    eq(guardless.length, 0, `没有鉴权就干活的 handler 数（位置 ${guardless.join(',')}）`);
    const registers = [...src.matchAll(/webServer\.register\(/g)].length;
    assert(registers >= 5, `注册的路由只有 ${registers} 条，期望 >= 5`);
    assert(/address === '127\.0\.0\.1' \|\| address === '::1' \|\| address === '::ffff:127\.0\.0\.1'/.test(src),
      'isLocalPeer 的白名单不是预期的三个 loopback 形式');
    return `${handlers.length} 个 handler 全部含 isLocalPeer(req)；register ${registers} 条路由；白名单只有 127.0.0.1 / ::1 / ::ffff:127.0.0.1`;
  });

  await check('7.7', '远程访问面：非 loopback 地址打不到该端口（403 的证据边界）', async () => {
    const ips = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    if (ips.length === 0) return '本机没有非 loopback IPv4，无法验证远程面（证据边界如实记录）';
    const outcomes = [];
    for (const ip of ips) {
      try {
        const res = await fetch(`http://${ip}:${BASE_PORT}/lifehud/api/weight`, { signal: AbortSignal.timeout(4000) });
        outcomes.push(`${ip} → HTTP ${res.status}`);
      } catch (error) {
        const code = error?.cause?.code ?? error?.code ?? error?.name ?? 'error';
        outcomes.push(`${ip} → 连不上 (${code})`);
      }
    }
    const reachable = outcomes.filter((o) => o.includes('HTTP'));
    const ok = reachable.every((o) => o.includes('403'));
    assert(ok, `非 loopback 地址能拿到非 403 响应：${outcomes.join('; ')}`);
    note('7.7b', '证据边界：无法在 loopback 上伪造 remoteAddress，403 分支只能靠代码审查 + 这条连通性/响应证据',
      `${outcomes.join('; ')}`);
    return outcomes.join('; ');
  });

  await check('7.8', 'client.js 读的字段名与响应契约一致（只读检查）', async () => {
    const src = readFileSync(join(REPO, 'plugin', 'client.js'), 'utf8');
    const need = [
      [`const WEIGHT_URL = '/lifehud/api/weight'`, '端点常量'],
      ['p.weight_kg', 'points[].weight_kg'],
      ['typeof p.date === ', 'points[].date'],
      ['data.stale', 'stale'],
      ['data.lastSyncAt', 'lastSyncAt'],
    ];
    const missing = need.filter(([needle]) => !src.includes(needle)).map(([, label]) => label);
    eq(missing.join(','), '', '前端缺失的字段引用');
    const usesArchived = src.includes('archived');
    return `端点常量 + ${need.slice(1).map(([, l]) => l).join(' / ')} 全部命中；archived ${usesArchived ? '被前端使用' : '前端未使用（仅诊断用，非契约破坏）'}`;
  });

  await check('7.9', 'HTTP 响应体不含任何凭据（含 userId）', async () => {
    const res = await fetch(`${ROUTE}?force=1`, { signal: AbortSignal.timeout(30000) });
    eq(res.status, 200, 'HTTP 状态');
    const text = await res.text();
    const leaked = Object.entries(REAL_CREDS)
      .filter(([, value]) => value.length >= 8 && text.includes(value)).map(([key]) => key);
    eq(leaked.join(','), '', '响应体里出现的凭据字段');
    return `?force=1 响应 ${text.length} 字节，serviceToken / ssecurity / userId 均未出现`;
  });

  }

  // ════════════════ 收尾：真实库复原核对 ════════════════
  console.log('\n8) 收尾核对');
  await check('8.1', '真实库在测试前后条数一致（库未被破坏）', async () => {
    const after = dbStats(REAL_DB);
    if (after.rows === realBefore.rows) {
      return `测试前 ${realBefore.rows} 行 / ${realBefore.distinctDates} 日 → 测试后 ${after.rows} 行 / ${after.distinctDates} 日`;
    }
    // 不一致 → 用 force 重新同步一次再核对（真实库的真正复原手段）。
    await readWeight(realConfig, { force: true });
    const recovered = dbStats(REAL_DB);
    eq(recovered.rows, realBefore.rows, `force 复原后行数（${after.rows} → ${recovered.rows}）仍与基线 ${realBefore.rows} 不符`);
    return `中途出现 ${after.rows} 行，已 force 重新同步复原到 ${recovered.rows} 行`;
  });
} finally {
  // 自带清理：临时库 / 坏 session 副本全部删掉（%TEMP% 不留垃圾）。
  let removed = false;
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    removed = !existsSync(TMP);
  } catch { /* ignore */ }
  let leftovers = [];
  try { leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith('lifehud-weight-probe-')); } catch { /* ignore */ }
  results.push({
    id: '8.2',
    name: '临时目录已清理，%TEMP% 里不留坏 session 副本',
    status: removed && leftovers.length === 0 ? 'PASS' : 'FAIL',
    evidence: removed && leftovers.length === 0
      ? `${TMP} 已删除；%TEMP% 下无 lifehud-weight-probe-* 残留`
      : `removed=${removed} 残留=${leftovers.join(',') || '无'}`,
  });
  console.log(`  [${removed && leftovers.length === 0 ? `${C.ok}PASS${C.off}` : `${C.bad}FAIL${C.off}`}] 8.2 临时目录已清理\n         ${C.dim}→ ${removed && !leftovers.length ? '已删除，无残留' : `residual=${leftovers.join(',')}`}${C.off}`);

  // ──────────────── 汇总 ────────────────
  const pass = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const info = results.filter((r) => r.status === 'INFO').length;
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`结果：${C.ok}${pass} PASS${C.off} / ${failCount ? C.bad : ''}${failCount} FAIL${C.off} / ${info} INFO   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failCount) {
    console.log('\n失败明细（可复现命令：node spike/probe-weight.mjs）：');
    for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ✗ ${r.id} ${r.name}\n    ${r.evidence}`);
  }
  console.log(`${'─'.repeat(72)}\n`);
  process.exitCode = failCount ? 1 : 0;
}
