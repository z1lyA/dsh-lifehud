// Spike probe: 独立验收 v1.1.1「专注卡脱离 ActivityWatch」。
//
// Run:
//   node spike/probe-focus.mjs                                   # 真库只读巡检 + 临时库确定性断言
//   node spike/probe-focus.mjs http://127.0.0.1:<DSH 端口>        # 另跑第 E 段（断 AW 后的 /hud 实测）
//   （也可以用 $env:LIFEHUD_BASE；脚本里**不硬编码端口**，没给地址就跳过 E 段）
//
// 硬约束（验收要求）：**绝不写真实 capture.db**。
//   * 真库一律 `readOnly` 打开（第 A/B 段）；
//   * 需要"跑一遍会写库"的用例（迁移幂等 / 合并压缩）一律在 os.tmpdir() 里复制一份或新建临时库；
//   * 采集器只在临时库里起，而且把 WINDIR 指向不存在的目录 —— 不真 spawn powershell，
//     以免和插件自己那个常驻采集器抢前台/留下残留。
//
// 它和既有探针的分工：
//   probe-hud.mjs     —— 聚合卡的"形状"（确定性）
//   probe-capture.mjs —— 采集器本体（真 spawn / 编码 / 迁移）
//   本探针            —— 验收清单里"断 AW 后数据真实"「模型/迁移完整性」「AFK 口径」「合并压缩率」
//                        这四类可重复断言，外加真库与 AW 原库的**逐 bucket 对账**。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  readOwnActivity, openCaptureDb, importHistory, startCollector, appendSample, captureStatus,
} from '../plugin/index.js';

const results = [];

/** @param {string} name @param {boolean} pass @param {string} [detail] */
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 记录跳过（不算失败，但要在汇总里出现，避免"看起来全绿"）。 */
function skip(name, why) {
  results.push({ name, pass: true, skipped: true, detail: why });
  console.log(`SKIP  ${name}  — ${why}`);
}

const DAY = 86400000;
const MIN = 60000;

/** 本地日期键 `YYYY-MM-DD`（与 Host / 既有探针同口径）。 */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 只读打开一个库，撞上采集器正在写就重试几次（busy_timeout 之外的一道保险）。
 * @param {string} dbPath @param {boolean} [readOnly] @returns {DatabaseSync}
 */
function openDb(dbPath, readOnly = true) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return new DatabaseSync(dbPath, { readOnly });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** @param {string} dbPath @param {string} sql @param {...any} params */
function rows(dbPath, sql, ...params) {
  const db = openDb(dbPath, true);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/** 把「含 -wal/-shm 的库」整份复制到临时目录（不要在真库上开读写连接）。 */
function copyDbTo(from, to) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
  }
}

const REAL_DIR = join(homedir(), '.dsh', 'lifehud');
const REAL_DB = join(REAL_DIR, 'capture.db');
const AW_SOURCE = join(process.env.LOCALAPPDATA ?? '', 'activitywatch', 'activitywatch',
  'aw-server', 'peewee-sqlite.v2.db');
const BASE = String(process.argv[2] ?? process.env.LIFEHUD_BASE ?? '').replace(/\/+$/, '');

const workDir = mkdtempSync(join(tmpdir(), 'lifehud-focus-'));
let stopMerge = null;

try {
  /* ======================================================= A. 真库模型 / 迁移完整性 */

  console.log('\n--- A. 真实 capture.db 的模型与迁移完整性（只读）---');
  check('A1 真实采集库存在', existsSync(REAL_DB), REAL_DB);
  if (!existsSync(REAL_DB)) {
    throw new Error('真实 capture.db 不存在，A/B 段无从断言（先让插件跑起来采一段）');
  }

  const master = rows(REAL_DB, "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index')");
  const tables = new Map(master.filter((r) => r.type === 'table').map((r) => [r.name, r.sql ?? '']));
  const indexNames = master.filter((r) => r.type === 'index').map((r) => r.name);

  const cols = (table) => rows(REAL_DB, `PRAGMA table_info(${table})`).map((c) => c.name);
  const bucketCols = cols('buckets');
  const eventCols = cols('events');
  const metaCols = cols('meta');

  check('A2 buckets 表结构符合 §4.3',
    ['id', 'type', 'client', 'hostname', 'created'].every((c) => bucketCols.includes(c)),
    bucketCols.join(','));
  check('A3 events 表结构符合 §4.3（data 原文 / source）',
    ['id', 'bucket_id', 'ts', 'duration', 'data', 'source'].every((c) => eventCols.includes(c)),
    eventCols.join(','));
  check('A4 meta 表结构符合 §4.3', ['key', 'value'].every((c) => metaCols.includes(c)), metaCols.join(','));
  check('A5 两个索引都在',
    indexNames.includes('idx_events_bucket_ts') && indexNames.includes('idx_events_ts'),
    indexNames.join(','));
  check('A6 events.data 存的是原始 JSON（不是 app/title 扁平列）',
    !eventCols.includes('app') && !eventCols.includes('title') && !eventCols.includes('status'),
    eventCols.join(','));

  const bucketRows = rows(REAL_DB, 'SELECT id, type, client, hostname, created FROM buckets ORDER BY type, id');
  const bucketByType = (type) => bucketRows.filter((b) => b.type === type);

  // AW 原库（只读副本）——迁移对账的唯一依据。
  const awCopy = join(workDir, 'aw.db');
  const haveAw = existsSync(AW_SOURCE);
  let awBuckets = [];
  let awCounts = new Map();
  let awTotal = 0;
  let awZero = 0;
  let awClassesCount = -1;
  if (haveAw) {
    copyDbTo(AW_SOURCE, awCopy);
    const aw = openDb(awCopy, false); // 副本，可写打开只是为了让 WAL 能回放；不写
    try {
      awBuckets = aw.prepare('SELECT key, id, type, client, hostname, created FROM bucketmodel').all();
      awTotal = Number(aw.prepare('SELECT COUNT(*) AS n FROM eventmodel').get().n);
      awZero = Number(aw.prepare('SELECT COUNT(*) AS n FROM eventmodel WHERE duration = 0').get().n);
      for (const r of aw.prepare(
        'SELECT b.id AS id, COUNT(*) AS n FROM eventmodel e JOIN bucketmodel b ON b.key = e.bucket_id GROUP BY b.id',
      ).all()) awCounts.set(String(r.id), Number(r.n));
    } finally {
      aw.close();
    }
    try {
      const settings = JSON.parse(readFileSync(join(dirname(AW_SOURCE), 'settings.json'), 'utf8'));
      if (Array.isArray(settings?.classes)) awClassesCount = settings.classes.length;
    } catch { /* 下面的断言会说明 */ }
  }

  const migratedIds = new Set(awBuckets.map((b) => String(b.id)));
  const presentMigrated = [...migratedIds].filter((id) => bucketRows.some((b) => b.id === id));
  check('A7 AW 的 3 个 bucket 全部迁入（含空的 general.stopwatch）',
    migratedIds.size === 3 && presentMigrated.length === 3
    && bucketByType('general.stopwatch').length === 1,
    `AW ${migratedIds.size} 个 → 本库 ${presentMigrated.length} 个：${[...migratedIds].join(', ')}`);

  const liveBuckets = bucketRows.filter((b) => b.client === 'lifehud-capture');
  check('A8 自采集的两个 bucket 也在（client=lifehud-capture）',
    liveBuckets.length === 2
    && liveBuckets.some((b) => b.type === 'currentwindow')
    && liveBuckets.some((b) => b.type === 'afkstatus'),
    liveBuckets.map((b) => `${b.id}(${b.type})`).join(', '));
  check('A9 bucket 行字段完整（type/client/hostname/created 都非空）',
    bucketRows.every((b) => b.type && b.client && b.hostname && b.created),
    `${bucketRows.length} 个 bucket`);

  const totalEvents = Number(rows(REAL_DB, 'SELECT COUNT(*) AS n FROM events')[0].n);
  const bySource = rows(REAL_DB, 'SELECT source, COUNT(*) AS n FROM events GROUP BY source');
  const sourceMap = new Map(bySource.map((r) => [r.source, Number(r.n)]));
  check('A10 source 同时有 live 与 aw-migrated',
    (sourceMap.get('live') ?? 0) > 0 && (sourceMap.get('aw-migrated') ?? 0) > 0,
    bySource.map((r) => `${r.source}=${r.n}`).join(', '));

  const badData = rows(REAL_DB, 'SELECT id, data FROM events').filter((r) => {
    try { JSON.parse(r.data); return false; } catch { return true; }
  });
  check('A11 每一条 events.data 都能 JSON.parse', badData.length === 0, `${badData.length} 条坏的`);

  const winSample = rows(REAL_DB, `
    SELECT e.data AS data FROM events e JOIN buckets b ON b.id = e.bucket_id
     WHERE b.type = 'currentwindow' LIMIT 200`);
  const winKeyed = winSample.filter((r) => {
    try {
      const d = JSON.parse(r.data);
      return typeof d.app === 'string' && d.app.length > 0 && typeof d.title === 'string';
    } catch { return false; }
  });
  check('A12 窗口事件里能查到 app / title 原文',
    winSample.length > 0 && winKeyed.length === winSample.length,
    winSample[0]?.data);

  const afkSample = rows(REAL_DB, `
    SELECT e.data AS data FROM events e JOIN buckets b ON b.id = e.bucket_id
     WHERE b.type = 'afkstatus' LIMIT 200`);
  const afkKeyed = afkSample.filter((r) => {
    try { return ['afk', 'not-afk'].includes(String(JSON.parse(r.data).status)); } catch { return false; }
  });
  check('A13 AFK 事件里能查到 status 原文（afk / not-afk）',
    afkSample.length > 0 && afkKeyed.length === afkSample.length, afkSample[0]?.data);

  const meta = new Map(rows(REAL_DB, 'SELECT key, value FROM meta').map((m) => [m.key, m.value]));
  check('A14 meta.schema_version = 2', meta.get('schema_version') === '2', String(meta.get('schema_version')));
  check('A15 meta.history_imported = 1', meta.get('history_imported') === '1', String(meta.get('history_imported')));
  check('A16 meta.hostname 已写入', Boolean(meta.get('hostname')), `${String(meta.get('hostname')).length} 字符`);

  let classes = null;
  try { classes = JSON.parse(String(meta.get('aw_classes') ?? '')); } catch { /* 下面的断言会说明 */ }
  // AW 的 classes 是 `[{name:['Work'], rule:{type:'regex',regex:'…'}, data:{…}}]`
  // —— 归档的是 settings.json 的原文，形状别自己改。
  check('A17 meta.aw_classes 归档了 AW 的 classes（本机 16 条，原文形状）',
    Array.isArray(classes) && classes.length === 16
    && Array.isArray(classes[0]?.name) && typeof classes[0]?.rule?.regex === 'string',
    `${Array.isArray(classes) ? classes.length : '不是数组'} 条`
    + `${awClassesCount >= 0 ? `（AW settings.json 里有 ${awClassesCount} 条）` : ''}`);

  // 逐 bucket 对账：本库 source='aw-migrated' 的行数必须与 AW 原库一致。
  if (haveAw) {
    const mine = new Map(rows(REAL_DB,
      "SELECT bucket_id, COUNT(*) AS n FROM events WHERE source = 'aw-migrated' GROUP BY bucket_id",
    ).map((r) => [String(r.bucket_id), Number(r.n)]));
    const diffs = [];
    for (const [id, n] of awCounts) {
      if ((mine.get(id) ?? 0) !== n) diffs.push(`${id}: 本库 ${mine.get(id) ?? 0} / AW ${n}`);
    }
    const migratedTotal = Number(sourceMap.get('aw-migrated') ?? 0);
    check('A18 迁移逐 bucket 与 AW 原库行数一致（一条都不丢）',
      diffs.length === 0 && migratedTotal === awTotal,
      `${migratedTotal} / AW ${awTotal}；${diffs.slice(0, 3).join('; ') || '逐 bucket 一致'}`);

    const zeroMine = Number(rows(REAL_DB,
      "SELECT COUNT(*) AS n FROM events WHERE source = 'aw-migrated' AND duration = 0")[0].n);
    check('A19 duration=0 的心跳也原样迁入', zeroMine === awZero, `${zeroMine} / AW ${awZero}`);
  } else {
    skip('A18/A19 迁移对账', `这台机器没有 AW 原库（${AW_SOURCE}）`);
  }

  // 幂等：在**副本**上再跑一次 importHistory，真库一个字节都不动。
  const idemCopy = join(workDir, 'idem.db');
  copyDbTo(REAL_DB, idemCopy);
  const beforeIdem = Number(rows(idemCopy, 'SELECT COUNT(*) AS n FROM events')[0].n);
  const again = importHistory({ captureDb: idemCopy, dataDir: workDir, historySource: haveAw ? AW_SOURCE : '' });
  const afterIdem = Number(rows(idemCopy, 'SELECT COUNT(*) AS n FROM events')[0].n);
  check('A20 再跑一次 importHistory 返回 already 且行数不变（副本上验，真库只读）',
    again.skipped === 'already' && beforeIdem === afterIdem,
    `skipped=${again.skipped}，${beforeIdem} → ${afterIdem}`);

  const awLeftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('lifehud-aw-'));
  check('A21 迁移的临时副本已清理（tmpdir 没有 lifehud-aw-*）',
    awLeftovers.length === 0, awLeftovers.join(',') || '无残留');

  const mineAfter = Number(rows(REAL_DB, 'SELECT COUNT(*) AS n FROM events')[0].n);
  check('A22 本探针没动过真库（事件行数仍是 ' + totalEvents + '）',
    mineAfter >= totalEvents, `${totalEvents} → ${mineAfter}`);

  /* ======================================================= B. 断 AW 后的真实数据 */

  console.log('\n--- B. 断 AW 后：真库聚合出的专注卡数据 ---');
  let awUp = true;
  try {
    const res = await fetch('http://127.0.0.1:5600/api/0/info', { signal: AbortSignal.timeout(2500) });
    awUp = res.ok;
  } catch {
    awUp = false;
  }
  check('B1 ActivityWatch 已经停了（5600 不可达）——本次验收的前提', awUp === false,
    awUp ? '5600 竟然还活着' : '连不上');

  const real = readOwnActivity({ captureDb: REAL_DB, dataDir: REAL_DIR }, 84);
  const focus = real.focus;
  check('B2 focus.available = true（没有 AW 也照样有数据）', focus.available === true);
  check('B3 top 非空', Array.isArray(focus.top) && focus.top.length > 0,
    (focus.top ?? []).map((a) => `${a.app} ${a.minutes}min`).join(', '));
  check('B4 top 里是像样的应用名（不是 unknown / 未知 / 空串）',
    (focus.top ?? []).every((a) => a.app && !/^(unknown|未知|\?)$/i.test(a.app)),
    (focus.top ?? []).map((a) => a.app).join(', '));
  check('B5 trackingMinutes 在合理区间（>0 且 ≤ 24h×60）',
    Number.isFinite(focus.trackingMinutes) && focus.trackingMinutes > 0 && focus.trackingMinutes <= 1440,
    `${focus.trackingMinutes}min`);
  check('B6 heatmap 恰好 84 天、连续、最后一天是今天',
    real.heatmap.length === 84
    && real.heatmap.every((d, i) => i === 0
      || Date.parse(`${d.d}T00:00:00`) - Date.parse(`${real.heatmap[i - 1].d}T00:00:00`) === DAY)
    && real.heatmap.at(-1)?.d === dayKey(Date.now()),
    `${real.heatmap.length} 天，最后 ${real.heatmap.at(-1)?.d}`);
  check('B7 heatmap 里有历史日（迁移没断档）',
    real.heatmap.filter((d) => d.m > 0).length >= 5,
    `${real.heatmap.filter((d) => d.m > 0).length} 天有数据`);

  /* ---- 独立复算：24h 窗口里到底有多少「真的在电脑前」的秒数 ---- */
  const db = openDb(REAL_DB, true);
  let winRows = [];
  let afkRows = [];
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const rangeStart = new Date(new Date().setHours(0, 0, 0, 0) - 83 * DAY).toISOString();
    winRows = db.prepare(`
      SELECT e.ts AS ts, e.duration AS duration, e.data AS data FROM events e
        JOIN buckets b ON b.id = e.bucket_id
       WHERE b.type = 'currentwindow' AND e.ts >= ? AND e.duration > 0 ORDER BY e.ts`).all(rangeStart);
    afkRows = db.prepare(`
      SELECT e.ts AS ts, e.duration AS duration, e.data AS data FROM events e
        JOIN buckets b ON b.id = e.bucket_id
       WHERE b.type = 'afkstatus' AND e.ts >= ? AND e.duration > 0 ORDER BY e.ts`).all(rangeStart);
  } finally {
    db.close();
  }

  // 这段是**另写一遍**的交叠算法（不复用 Host 的 createAfkIndex），用来交叉验证。
  const spans = [];
  for (const row of afkRows) {
    try {
      if (String(JSON.parse(row.data)?.status) !== 'afk') continue;
    } catch { continue; }
    const start = Date.parse(row.ts);
    if (!Number.isFinite(start)) continue;
    spans.push([start, start + Math.max(0, Number(row.duration) || 0) * 1000]);
  }
  spans.sort((a, b) => a[0] - b[0]);

  /** 与 AFK 区间的交叠毫秒（线性扫；313 个区间 × 1.3 万条事件足够快）。 */
  const afkMsBetween = (startMs, endMs) => {
    let idle = 0;
    for (const [a, b] of spans) {
      if (b <= startMs) continue;
      if (a >= endMs) break;
      const lo = Math.max(startMs, a);
      const hi = Math.min(endMs, b);
      if (hi > lo) idle += hi - lo;
    }
    return idle;
  };

  const now = Date.now();
  const since24 = now - DAY;
  let trackAdjusted = 0;
  let trackRaw = 0;
  const perAppAdjusted = new Map();
  const perAppRaw = new Map();
  let longestAdjusted = { app: '', title: '', seconds: 0 };
  for (const row of winRows) {
    const start = Date.parse(row.ts);
    const duration = Number(row.duration) || 0;
    if (!Number.isFinite(start) || duration <= 0) continue;
    let data;
    try { data = JSON.parse(row.data); } catch { continue; }
    const app = String(data?.app ?? '未知');
    const title = String(data?.title ?? '');
    if (/^explorer\.exe$/i.test(app) && /program manager/i.test(title)) continue;
    const end = start + duration * 1000;
    const idle = afkMsBetween(start, end);
    const active = Math.max(0, duration - idle / 1000);
    if (active < 1) continue;
    const inside = Math.max(0, (Math.min(end, now) - Math.max(start, since24)) / 1000);
    if (inside < 1) continue;
    const ratio = active / duration;
    trackRaw += inside;
    trackAdjusted += inside * ratio;
    perAppRaw.set(app, (perAppRaw.get(app) ?? 0) + inside);
    perAppAdjusted.set(app, (perAppAdjusted.get(app) ?? 0) + inside * ratio);
    if (inside * ratio > longestAdjusted.seconds) {
      longestAdjusted = { app, title, seconds: inside * ratio };
    }
  }
  const toMin = (s) => Math.round(s / 6) / 10;
  const topAdj = [...perAppAdjusted.entries()]
    .map(([app, s]) => ({ app, minutes: toMin(s) }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 6);

  console.log(`独立复算：24h 原始 ${toMin(trackRaw)}min / 扣 AFK 后 ${toMin(trackAdjusted)}min`
    + `；Host 报 ${focus.trackingMinutes}min`);
  console.log('独立复算 top（扣 AFK）：', topAdj.map((a) => `${a.app} ${a.minutes}min`).join(', '));
  console.log('Host top：', (focus.top ?? []).map((a) => `${a.app} ${a.minutes}min`).join(', '));

  const drift = Math.abs(Number(focus.trackingMinutes) - toMin(trackAdjusted));
  check('B8 trackingMinutes 与独立复算的「扣 AFK」口径一致（±2% 或 ±2min）',
    drift <= Math.max(2, toMin(trackAdjusted) * 0.02),
    `Host ${focus.trackingMinutes}min vs 复算 ${toMin(trackAdjusted)}min（差 ${Math.round(drift)}min）`);

  // 热力日历自己再算一遍（按「事件起点所在的那天」记账，与 Host 同口径）。
  const heatReal = new Map(real.heatmap.map((d) => [d.d, d.m]));
  const perDayMine = new Map();
  for (const row of winRows) {
    const start = Date.parse(row.ts);
    const duration = Number(row.duration) || 0;
    if (!Number.isFinite(start) || duration <= 0) continue;
    let data;
    try { data = JSON.parse(row.data); } catch { continue; }
    const app = String(data?.app ?? '未知');
    const title = String(data?.title ?? '');
    if (/^explorer\.exe$/i.test(app) && /program manager/i.test(title)) continue;
    const active = Math.max(0, duration - afkMsBetween(start, start + duration * 1000) / 1000);
    if (active < 1) continue;
    const key = dayKey(start);
    perDayMine.set(key, (perDayMine.get(key) ?? 0) + active);
  }
  const heatBad = [];
  for (let i = 1; i <= 7; i += 1) {
    const key = dayKey(Date.now() - i * DAY);
    const mine = Math.round((perDayMine.get(key) ?? 0) / 60);
    const theirs = heatReal.get(key) ?? 0;
    if (Math.abs(mine - theirs) > 2) heatBad.push(`${key}: 复算 ${mine} / Host ${theirs}`);
  }
  check('B9 热力日历与独立复算的每日活跃分钟一致（抽查最近 7 天，±2min）',
    heatBad.length === 0, heatBad.join('; ') || '7 天全部一致');

  /* ======================================================= C. AFK 语义（确定性临时库） */

  console.log('\n--- C. AFK / 过滤语义（临时库，确定性用例）---');
  const afkDb = join(workDir, 'afk.db');
  {
    const d = openCaptureDb(afkDb);
    const host = 'probe-host';
    const iso = (ms) => new Date(ms).toISOString();
    d.prepare('INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)')
      .run(`lifehud-window_${host}`, 'currentwindow', 'lifehud-capture', host, iso(Date.now()));
    d.prepare('INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)')
      .run(`lifehud-afk_${host}`, 'afkstatus', 'lifehud-capture', host, iso(Date.now()));
    const ins = d.prepare('INSERT INTO events (bucket_id, ts, duration, data, source) VALUES (?, ?, ?, ?, ?)');
    const win = (app, title, startMs, minutes) => ins.run(`lifehud-window_${host}`, iso(startMs),
      minutes * 60, JSON.stringify({ app, title }), 'live');
    const afk = (status, startMs, minutes) => ins.run(`lifehud-afk_${host}`, iso(startMs),
      minutes * 60, JSON.stringify({ status }), 'live');

    const t0 = Date.now() - 3 * 60 * MIN; // 3 小时前：一定落在 24h 窗口里，且整段都在过去
    // 1) Code 100 分钟，其中 30 分钟 AFK → 应算 70
    win('Code.exe', 'index.js - VS Code', t0, 100);
    afk('not-afk', t0, 20);
    afk('afk', t0 + 20 * MIN, 30);
    afk('not-afk', t0 + 50 * MIN, 50);
    // 2) explorer.exe + Program Manager 40 分钟 → 一律丢弃
    win('explorer.exe', 'Program Manager', t0 + 100 * MIN, 40);
    // 3) msedge 20 分钟，整段 AFK → 应算 0（并整条不进 top）
    win('msedge.exe', 'DeepSeek', t0 + 140 * MIN, 20);
    afk('afk', t0 + 140 * MIN, 20);
    // 4) Weixin 10 分钟，没有 AFK → 算 10
    win('Weixin.exe', '张三', t0 + 160 * MIN, 10);
    afk('not-afk', t0 + 160 * MIN, 10);
    d.close();
  }
  const afkPay = readOwnActivity({ captureDb: afkDb, dataDir: workDir }, 84);
  const afkTop = new Map((afkPay.focus.top ?? []).map((a) => [a.app, a.minutes]));
  const afkHeat = new Map(afkPay.heatmap.map((x) => [x.d, x.m]));
  // 期望：70（Code 扣掉 30 分钟 AFK）+ 10（微信）= 80；explorer 空转段与整段 AFK 的 msedge 都是 0。
  const heatSum = [...afkHeat.values()].reduce((a, b) => a + b, 0);
  const codeItem = (afkPay.focus.top ?? []).find((a) => /code|vs code/i.test(a.app));
  console.log('临时库 focus :', JSON.stringify(afkPay.focus));
  console.log(`临时库热力合计: ${heatSum}min（期望 80 = 70 + 10）；原始时长本应是 170min`);

  check('C1 热力日历扣掉了 AFK（合计 80min，不是 170min）', heatSum === 80, `${heatSum}min`);
  check('C2 trackingMinutes 扣掉了 AFK（期望 80，不是 110）',
    afkPay.focus.trackingMinutes === 80, `${afkPay.focus.trackingMinutes}min`);
  check('C3 top 里 Code 的分钟数扣掉了 AFK（期望 70，不是 100）',
    codeItem?.minutes === 70, `${codeItem?.app ?? '(不在 top 里)'}=${codeItem?.minutes}min`);
  check('C4 explorer.exe + Program Manager 被丢弃',
    ![...afkTop.keys()].some((app) => /explorer/i.test(app)), [...afkTop.keys()].join(', '));
  check('C5 整段 AFK 的窗口（msedge）不进 top',
    ![...afkTop.keys()].some((app) => /msedge/i.test(app)), [...afkTop.keys()].join(', '));
  check('C6 longest 也扣掉 AFK（期望 70min）',
    afkPay.focus.longest?.minutes === 70, JSON.stringify(afkPay.focus.longest));

  /* ======================================================= D. 合并压缩 + 采集器单例 */

  console.log('\n--- D. 采集合并压缩率 / startCollector 单例（临时库，不真 spawn）---');
  const mergeDb = join(workDir, 'merge.db');
  // WINDIR 指到不存在的目录：spawn 必然失败 → 不起真进程，但合并/落盘逻辑照跑。
  const realWinDir = process.env.WINDIR;
  process.env.WINDIR = join(workDir, 'no-such-windir');
  let firstDispose = null;
  try {
    firstDispose = startCollector({ captureDb: mergeDb, capturePollSeconds: 2, afkThresholdSeconds: 180 });
    const secondDispose = startCollector({ captureDb: mergeDb, capturePollSeconds: 2, afkThresholdSeconds: 180 });
    const st = captureStatus();
    check('D1 重复 startCollector 只认一个实例（第二次返回空 disposer，不换库/不换 pid）',
      st.dbPath === mergeDb && st.pid === null, `dbPath=${st.dbPath}, pid=${st.pid}`);
    secondDispose(); // 空 disposer：不应该把第一个实例停掉
    check('D2 第二次返回的 disposer 是空操作（第一个实例还活着）',
      captureStatus().dbPath === mergeDb, `dbPath=${captureStatus().dbPath}`);

    // 60 条样本 × 2 秒 = 同一个应用连续 118 秒 → 合并成 1 行
    const base = Date.parse('2026-02-01T10:00:00.000Z');
    for (let i = 0; i < 60; i += 1) {
      appendSample({
        timestamp: new Date(base + i * 2000).toISOString(),
        app: 'Code.exe', title: 'index.js', idle_seconds: 0.4, status: 'not-afk',
      });
    }
    // 间隔 30 秒（> pulsetime 10s）→ 必须断开成新行
    const gapBase = base + 118 * 1000 + 30000;
    for (let i = 0; i < 10; i += 1) {
      appendSample({
        timestamp: new Date(gapBase + i * 2000).toISOString(),
        app: 'Code.exe', title: 'index.js', idle_seconds: 0.4, status: 'not-afk',
      });
    }
    // 换应用 → 新行
    for (let i = 0; i < 10; i += 1) {
      appendSample({
        timestamp: new Date(gapBase + 20 * 1000 + i * 2000).toISOString(),
        app: 'msedge.exe', title: 'DeepSeek', idle_seconds: 0.2, status: 'not-afk',
      });
    }
    const sampleCount = captureStatus().samples;
    // 未闭合事件也落盘：还没 dispose 就该能在库里读到行
    const midRows = rows(mergeDb, 'SELECT COUNT(*) AS n FROM events')[0].n;
    check('D3 未闭合事件也实时落盘（不用等事件切换）', Number(midRows) >= 2, `${midRows} 行（还没 dispose）`);
    check('D4 收到 80 条样本', sampleCount === 80, `samples=${sampleCount}`);
  } finally {
    firstDispose?.();
    firstDispose = null;
    process.env.WINDIR = realWinDir;
  }
  check('D5 dispose 后状态回到空闲', captureStatus().running === false && captureStatus().dbPath === null);

  const mergeEvents = rows(mergeDb, 'SELECT bucket_id, ts, duration, data FROM events ORDER BY ts');
  const winSeg = mergeEvents.filter((r) => r.bucket_id.startsWith('lifehud-window_'));
  const afkSeg = mergeEvents.filter((r) => r.bucket_id.startsWith('lifehud-afk_'));
  check('D6 同应用连续 118 秒合并成 1 行（不是 60 行）',
    winSeg.filter((r) => JSON.parse(r.data).app === 'Code.exe').length === 2,
    `Code 段 ${winSeg.filter((r) => JSON.parse(r.data).app === 'Code.exe').length} 行`
    + `（期望 2：118 秒连续段 + 间隔 30 秒后的新段）`);
  const firstSeg = winSeg.find((r) => JSON.parse(r.data).app === 'Code.exe');
  check('D7 合并后的 duration = 末样本 - 首样本（118 秒）',
    Math.abs(Number(firstSeg.duration) - 118) < 0.01, `duration=${firstSeg.duration}s`);
  check('D8 换应用开新行（msedge 段存在）',
    winSeg.some((r) => JSON.parse(r.data).app === 'msedge.exe'),
    winSeg.map((r) => JSON.parse(r.data).app).join(', '));
  check('D9 AFK 流同样合并（80 条样本 → 少量行）', afkSeg.length <= 3,
    `${afkSeg.length} 行`);
  const compression = mergeEvents.length === 0 ? 0 : 80 / mergeEvents.length;
  check('D10 压缩率 ≥ 10 倍（80 条样本 → 个位数行）', compression >= 10,
    `80 / ${mergeEvents.length} = ${compression.toFixed(1)}×`);

  /* ======================================================= E. HTTP（给出 DSH 地址时） */

  console.log('\n--- E. 断 AW 后的 /lifehud/api/hud（真实 HTTP）---');
  if (!BASE) {
    skip('E* 全部', '没给 DSH 地址（node spike/probe-focus.mjs http://127.0.0.1:<端口>）');
  } else {
    const fetchHud = async (url) => {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* 下面的断言会说明 */ }
      return { status: res.status, body, text };
    };
    const hudUrl = `${BASE}/lifehud/api/hud`;
    const first = await fetchHud(hudUrl);
    check('E1 GET /lifehud/api/hud → 200 且 ok:true',
      first.status === 200 && first.body?.ok === true, `HTTP ${first.status}`);
    const f = first.body?.focus ?? {};
    check('E2 HTTP 里的 focus.available = true（没有 AW 进程也照常出数）', f.available === true);
    check('E3 HTTP 里的 top 非空且是应用名',
      Array.isArray(f.top) && f.top.length > 0,
      (f.top ?? []).map((a) => `${a.app} ${a.minutes}min`).join(', '));
    check('E4 HTTP 里的 trackingMinutes 在 (0, 1440]', f.trackingMinutes > 0 && f.trackingMinutes <= 1440,
      `${f.trackingMinutes}min`);
    check('E5 页面诊断区没有 warning（断 AW 后不该报错）',
      Array.isArray(first.body?.warnings) && first.body.warnings.length === 0,
      JSON.stringify(first.body?.warnings));
    check('E6 capture.running = true（插件自己的采集器活着）',
      first.body?.capture?.running === true,
      `pid=${first.body?.capture?.pid}, samples=${first.body?.capture?.samples}`);
    check('E7 采集器 stdout 没有解析不出来的杂音（noise = 0）',
      first.body?.capture?.noise === 0, `noise=${first.body?.capture?.noise}`);

    // 隔 10 秒再取一次：samples 必须涨（采集器在真的采样，不是僵住）
    const before = Number(first.body?.capture?.samples ?? 0);
    const rowsBefore = Number(first.body?.capture?.rows ?? 0);
    await sleep(10000);
    const second = await fetchHud(hudUrl);
    const after = Number(second.body?.capture?.samples ?? 0);
    const rowsAfter = Number(second.body?.capture?.rows ?? 0);
    check('E8 10 秒后 capture.samples 增长（采样在跑）', after > before,
      `${before} → ${after}`);
    check('E9 capture.rows 不减少（落盘没回退）', rowsAfter >= rowsBefore,
      `${rowsBefore} → ${rowsAfter}`);
    check('E10 两次请求 warnings 都为空（运行期零 AW 依赖）',
      (second.body?.warnings ?? ['?']).length === 0, JSON.stringify(second.body?.warnings));

    // capture.db 的行数/时长在长（真库只读）
    const liveRows = rows(REAL_DB,
      "SELECT COUNT(*) AS n, COALESCE(SUM(duration),0) AS s FROM events WHERE source = 'live'")[0];
    check('E11 真库里 live 事件在长（source=live 的行数与总时长 > 0）',
      Number(liveRows.n) > 0 && Number(liveRows.s) > 0,
      `${liveRows.n} 行 / ${Math.round(Number(liveRows.s))} 秒`);
  }
} finally {
  if (stopMerge) stopMerge();
  rmSync(workDir, { recursive: true, force: true });
}

/* ======================================================= 汇总 */

const failed = results.filter((r) => !r.pass);
const skipped = results.filter((r) => r.skipped);
console.log(`\n${'='.repeat(64)}`);
console.log(`probe-focus: ${results.length - failed.length}/${results.length} 通过`
  + `${skipped.length ? `（含 ${skipped.length} 项 SKIP）` : ''}`);
for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
if (failed.length > 0) {
  console.log('\n提示：C2/C3/C6/B8 这类失败都指向同一件事 —— 24h 窗口的 trackingMinutes / top / longest'
    + '\n没有把（部分覆盖的）AFK 时间扣掉，而热力日历扣了。详见 notes/research/1.1.1-验收报告.md。');
  process.exitCode = 1;
}
