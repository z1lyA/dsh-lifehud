// Spike probe: exercise buildHud() without DSH, so the host logic can be iterated fast.
// Run: node spike/probe-hud.mjs            # 临时采集库，确定性断言专注卡 + 热力
//      node spike/probe-hud.mjs --real     # 另外断言真实 dataDir 的 capture.db（迁移后跑）
//
// v1.1.1 起专注/热力读的是 LifeHud 自己的 <dataDir>/capture.db，跟 ActivityWatch
// 进程无关。这里先往临时库里灌一「已知形状」的样本，再断言聚合结果——不用碰真实
// 数据，也不用开着任何外部服务。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildHud, openCaptureDb, readOwnActivity } from '../plugin/index.js';
import { NOWTREE_DB, NOWTREE_LEVELDB } from './paths.mjs';

const results = [];
/** @param {string} name @param {boolean} pass @param {string} [detail] */
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const MIN = 60 * 1000;

/** 本地日期键 `YYYY-MM-DD`（与 Host 侧同口径）。 */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 记一笔「某天有多少活跃分钟」。注意 Host 的口径（与 v1.1.0 的 AW 实现一致）：
 * 一段事件的**全部**活跃秒算在它「起点所在的那天」，跨午夜也不拆。
 * @param {Map<string, number>} map @param {number} startMs @param {number} minutes
 */
function addActive(map, startMs, minutes) {
  const key = dayKey(startMs);
  map.set(key, (map.get(key) ?? 0) + minutes);
}

/**
 * 往临时采集库灌样本：最近 3 小时的窗口/AFK 流 + 几天历史，覆盖专注卡与热力日历。
 * @param {string} dbPath @returns {Map<string, number>} 期望的「每日活跃分钟」
 */
function seedCaptureDb(dbPath) {
  const db = openCaptureDb(dbPath);
  const now = Date.now();
  const host = 'probe-host';
  const iso = (ms) => new Date(ms).toISOString();
  const bucket = (id, type) => db.prepare(
    'INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)',
  ).run(id, type, 'lifehud-capture', host, iso(now));
  bucket(`lifehud-window_${host}`, 'currentwindow');
  bucket(`lifehud-afk_${host}`, 'afkstatus');

  const insert = db.prepare(
    'INSERT INTO events (bucket_id, ts, duration, data, source) VALUES (?, ?, ?, ?, ?)',
  );
  const win = (app, title, startMs, minutes, source = 'live') => insert.run(
    `lifehud-window_${host}`, iso(startMs), minutes * 60, JSON.stringify({ app, title }), source,
  );
  const afk = (status, startMs, minutes) => insert.run(
    `lifehud-afk_${host}`, iso(startMs), minutes * 60, JSON.stringify({ status }), 'live',
  );

  const expected = new Map();

  // ---- 最近 3 小时（全部落在 24h 滚动窗口里，所以 top 的分钟数就是原始时长）----
  const t0 = now - 180 * MIN;
  win('Code.exe', 'index.js - VS Code', t0, 90);
  win('explorer.exe', 'Program Manager', t0 + 90 * MIN, 40); // 空转段，必须被过滤
  win('msedge.exe', 'DeepSeek', t0 + 130 * MIN, 40);
  win('Weixin.exe', '张三', t0 + 170 * MIN, 5);
  afk('not-afk', t0, 30);
  afk('afk', t0 + 30 * MIN, 30); // 落在 Code 段里 → 90 分钟应只剩 60
  addActive(expected, t0, 60);
  addActive(expected, t0 + 130 * MIN, 40);
  addActive(expected, t0 + 170 * MIN, 5);

  // ---- 历史（都在 24h 窗口外，日期固定可控）----
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const at = (daysAgo, hour) => dayStart.getTime() - daysAgo * 86400000 + hour * 3600000;

  // 20 天前：120 分钟 Code，其中 60 分钟 AFK → 该天只剩 60 分钟
  win('Code.exe', 'index.js - VS Code', at(20, 8), 120, 'aw-migrated');
  afk('afk', at(20, 8.5), 60);
  addActive(expected, at(20, 8), 60);

  // 21 天前：45 分钟 Edge
  win('msedge.exe', 'DeepSeek', at(21, 9), 45, 'aw-migrated');
  addActive(expected, at(21, 9), 45);

  // 22 天前：只有 explorer.exe + Program Manager → 必须被过滤成 0
  win('explorer.exe', 'Program Manager', at(22, 9), 100, 'aw-migrated');

  // 23~40 天前：每天 60 分钟，保证热力日历不断档
  for (let d = 23; d <= 40; d += 1) {
    win('Code.exe', 'index.js - VS Code', at(d, 10), 60, 'aw-migrated');
    addActive(expected, at(d, 10), 60);
  }

  // 一条 duration=0 的心跳：保留在库里，但聚合时必须跳过
  win('cmd.exe', 'should-be-ignored', t0 + 5 * MIN, 0);

  db.close();
  return expected;
}

/**
 * 灌一份「接近真实规模」的库（84 天 × 230 条 ≈ 1.9 万行），量一下聚合耗时。
 * @param {string} dbPath @returns {number} 事件行数
 */
function seedBulkDb(dbPath) {
  const db = openCaptureDb(dbPath);
  const now = Date.now();
  const host = 'bulk-host';
  const iso = (ms) => new Date(ms).toISOString();
  db.prepare('INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)')
    .run(`lifehud-window_${host}`, 'currentwindow', 'lifehud-capture', host, iso(now));
  db.prepare('INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)')
    .run(`lifehud-afk_${host}`, 'afkstatus', 'lifehud-capture', host, iso(now));
  const insertWin = db.prepare(
    'INSERT INTO events (bucket_id, ts, duration, data, source) VALUES (?, ?, ?, ?, ?)',
  );
  const insertAfk = db.prepare(
    'INSERT INTO events (bucket_id, ts, duration, data, source) VALUES (?, ?, ?, ?, ?)',
  );
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const apps = ['Code.exe', 'msedge.exe', 'Weixin.exe', 'explorer.exe', 'notepad.exe'];
  let rows = 0;
  db.exec('BEGIN');
  for (let d = 0; d < 84; d += 1) {
    const base = dayStart.getTime() - d * 86400000 + 8 * 3600000;
    // 每天 230 条窗口事件（1 分钟粒度，模拟 AW 的原始数据量）
    for (let i = 0; i < 230; i += 1) {
      const start = base + i * MIN;
      insertWin.run(`lifehud-window_${host}`, iso(start), 60,
        JSON.stringify({ app: apps[i % apps.length], title: `窗口 ${i}` }), 'aw-migrated');
      rows += 1;
    }
    // 每天 8 段 AFK
    for (let i = 0; i < 8; i += 1) {
      const start = base + i * 30 * MIN;
      insertAfk.run(`lifehud-afk_${host}`, iso(start), 600,
        JSON.stringify({ status: 'afk' }), 'aw-migrated');
      rows += 1;
    }
  }
  db.exec('COMMIT');
  db.close();
  return rows;
}

const workDir = mkdtempSync(join(tmpdir(), 'lifehud-hud-'));
try {
  /* ---------------------------------------------------- 正确性（临时库） */

  const captureDb = join(workDir, 'capture.db');
  const expectedPerDay = seedCaptureDb(captureDb);

  const config = {
    nowtreeDb: NOWTREE_DB,
    leveldbDir: NOWTREE_LEVELDB,
    latitude: 39.9042,
    longitude: 116.4074,
    sessionLimit: 5,
    dataDir: workDir, // 设置文件也读空的临时目录
    captureDb,
  };

  const payload = await buildHud(config);

  console.log('clock   :', JSON.stringify(payload.clock));
  console.log('tasks   :', payload.tasks.label, payload.tasks.range, `${payload.tasks.items.length} 条`);
  for (const t of payload.tasks.items) console.log('   -', t.title, t.next ? '[NEXT]' : '');
  console.log('weather :', payload.weather ? payload.weather.summary : 'null');
  console.log('hourly  :', payload.weather ? `${payload.weather.hourly.length} 点` : '-');
  console.log('sessions:', payload.sessions.length);
  for (const s of payload.sessions) console.log('   -', s.title, '|', new Date(s.at).toLocaleString('zh-CN'));
  console.log('focus   :', payload.focus.available, `tracking=${payload.focus.trackingMinutes}min`);
  for (const a of payload.focus.top) console.log('   -', a.app, `${a.minutes}min`);
  console.log('longest :', JSON.stringify(payload.focus.longest));
  console.log('heatmap :', payload.heatmap.length, '天，最后一天', payload.heatmap.at(-1));
  console.log('warnings:', payload.warnings);

  const focus = payload.focus;
  check('专注卡可用（focus.available）', focus.available === true);
  check('窗口口径是 24h', focus.window === '24h', focus.window);
  check('top 非空', Array.isArray(focus.top) && focus.top.length > 0,
    (focus.top ?? []).map((a) => a.app).join(', '));
  check('top[0] = Code（别名 → VS Code）90 分钟',
    focus.top?.[0]?.app === 'VS Code' && focus.top?.[0]?.minutes === 90,
    JSON.stringify(focus.top?.[0]));
  check('top 排序 / 分钟数正确（90 / 40 / 5）',
    JSON.stringify((focus.top ?? []).map((a) => a.minutes)) === '[90,40,5]',
    JSON.stringify((focus.top ?? []).map((a) => a.minutes)));
  check('explorer.exe + Program Manager 被过滤',
    !(focus.top ?? []).some((a) => /文件资源管理器|explorer/i.test(a.app)));
  check('duration=0 的事件不参与聚合', !(focus.top ?? []).some((a) => /cmd/i.test(a.app)));
  // 90（Code）+ 40（Edge）+ 5（微信）= 135；空转段与 duration=0 都不算进来。
  check('trackingMinutes = 135（90+40+5）', focus.trackingMinutes === 135, String(focus.trackingMinutes));
  check('longest 用原始 app 名、90 分钟',
    focus.longest?.app === 'Code.exe' && focus.longest?.minutes === 90
    && focus.longest?.title === 'index.js - VS Code', JSON.stringify(focus.longest));

  check('heatmap 恰好 84 天', payload.heatmap.length === 84, String(payload.heatmap.length));
  check('heatmap 升序且不断档', payload.heatmap.every((d, i) => (
    i === 0 || Date.parse(`${d.d}T00:00:00`) - Date.parse(`${payload.heatmap[i - 1].d}T00:00:00`) === 86400000
  )));
  check('heatmap 最后一天是今天', payload.heatmap.at(-1)?.d === dayKey(Date.now()), payload.heatmap.at(-1)?.d);

  const heat = new Map(payload.heatmap.map((d) => [d.d, d.m]));
  const mismatched = [];
  for (const [key, minutes] of expectedPerDay) {
    if (!heat.has(key)) {
      mismatched.push(`${key} 不在 84 天里`);
      continue;
    }
    const want = Math.round(minutes);
    if (heat.get(key) !== want) mismatched.push(`${key}: 期望 ${want} 实际 ${heat.get(key)}`);
  }
  check(`每日活跃分钟与期望一致（${expectedPerDay.size} 天，含 AFK 扣除）`,
    mismatched.length === 0, mismatched.join('; ') || '全部一致');

  const quietDay = dayKey(new Date().setHours(0, 0, 0, 0) - 22 * 86400000);
  check('只有空转段的那天 = 0 分钟', (heat.get(quietDay) ?? -1) === 0, String(heat.get(quietDay)));

  /* ---------------------------------------------------- 性能（近真实规模） */

  const bulkDb = join(workDir, 'bulk.db');
  const bulkRows = seedBulkDb(bulkDb);
  const bulkConfig = { ...config, captureDb: bulkDb };
  // 预热一次（第一次会带 WAL/句柄开销），量第二次
  readOwnActivity(bulkConfig, 84);
  const t1 = process.hrtime.bigint();
  const bulk = readOwnActivity(bulkConfig, 84);
  const activityMs = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`\nbulk    : ${bulkRows} 行 / 84 天，readOwnActivity ${activityMs.toFixed(1)}ms，`
    + `前 3 名 ${bulk.focus.top.slice(0, 3).map((a) => `${a.app} ${a.minutes}`).join(' · ')}`);
  check('近真实规模下 readOwnActivity < 200ms', activityMs < 200, `${activityMs.toFixed(1)}ms / ${bulkRows} 行`);
  check('近真实规模下 focus.available = true', bulk.focus.available === true);
  check('近真实规模下 top 非空', (bulk.focus.top ?? []).length > 0);
  check('近真实规模下热力有历史日', bulk.heatmap.filter((d) => d.m > 0).length > 50,
    `${bulk.heatmap.filter((d) => d.m > 0).length} 天`);

  /* ---------------------------------------------------- 只读连接 / 建表幂等 */

  check('buildHud 返回里带 capture 状态字段', Boolean(payload.capture)
    && typeof payload.capture.running === 'boolean' && Array.isArray(payload.capture.warnings));
  check('采集库里没有 opens 的写句柄（readOwnActivity 用只读连接）', (() => {
    const db = new DatabaseSync(bulkDb, { readOnly: true });
    try {
      const mode = db.prepare('PRAGMA journal_mode').get();
      return String(Object.values(mode)[0]).toLowerCase() === 'wal';
    } finally {
      db.close();
    }
  })(), 'journal_mode = WAL');

  /* ---------------------------------------------------- 可选：真实 dataDir */

  if (process.argv.includes('--real')) {
    console.log('\n--- 真实 dataDir 的 capture.db ---');
    const realDir = join(homedir(), '.dsh', 'lifehud');
    const realConfig = { ...config, dataDir: realDir, captureDb: join(realDir, 'capture.db') };
    const real = await buildHud(realConfig);
    console.log('focus   :', real.focus.available, `tracking=${real.focus.trackingMinutes}min`);
    for (const a of real.focus.top) console.log('   -', a.app, `${a.minutes}min`);
    console.log('heatmap :', real.heatmap.filter((d) => d.m > 0).length, '天有数据');
    console.log('warnings:', real.warnings);
    console.log('capture :', JSON.stringify(real.capture));
    check('真实库：专注卡可用', real.focus.available === true);
    check('真实库：top 非空', (real.focus.top ?? []).length > 0,
      (real.focus.top ?? []).map((a) => a.app).join(', '));

    // 真实库里窗口事件覆盖的每一天，热力日历都不该是 0（今天除外：它刚开了个头）
    const db = new DatabaseSync(realConfig.captureDb, { readOnly: true });
    let eventDays = [];
    try {
      eventDays = [...new Set(db.prepare(
        "SELECT e.ts AS ts FROM events e JOIN buckets b ON b.id = e.bucket_id WHERE b.type = 'currentwindow'",
      ).all().map((row) => Date.parse(row.ts)).filter((ms) => Number.isFinite(ms)).map(dayKey))];
    } finally {
      db.close();
    }
    const heat = new Map(real.heatmap.map((d) => [d.d, d.m]));
    const today = dayKey(Date.now());
    const gaps = eventDays.filter((key) => heat.has(key) && key !== today && (heat.get(key) ?? 0) <= 0);
    check('真实库：有窗口数据的每一天热力都不为 0（不断档，今天除外）', gaps.length === 0,
      `${eventDays.length} 天有窗口数据，其中热力为 0 的 ${gaps.length} 天：${gaps.slice(0, 3).join(',')}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(60)}`);
console.log(`probe-hud: ${results.length - failed.length}/${results.length} 通过`);
for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
if (failed.length > 0) process.exitCode = 1;
