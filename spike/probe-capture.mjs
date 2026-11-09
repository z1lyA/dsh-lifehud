// Spike probe: exercise the v1.1.1 self-capture pipeline without DSH.
// Run: node spike/probe-capture.mjs
//
// 全部用 os.tmpdir() 里的临时库，绝不碰真实 dataDir 的 capture.db。四段：
//   A. 合并语义（确定性地喂样本，不启真实采集器）
//   B. 真实采集器（spawn powershell，采样若干轮 → 落库 → dispose → 无残留进程）
//   C. stdout 编码（中文标题不能变乱码）
//   D. 全量迁移 AW 历史（只读 AW 库文件的副本；没装 AW 就 SKIP）
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  startCollector, appendSample, captureStatus, openCaptureDb, importHistory, readOwnActivity,
} from '../plugin/index.js';

const results = [];
/** @param {string} name @param {boolean} pass @param {string} [detail] */
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const psExe = () => join(process.env.WINDIR ?? process.env.SystemRoot ?? '', 'System32',
  'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** 跑一次 PowerShell，拿 stdout（不依赖 PATH）。 */
function runPowerShell(args) {
  return new Promise((resolve) => {
    const child = spawn(psExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: String(error) }));
    child.on('exit', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

/** 标题里带「中文标题」标记的记事本进程（C 段用；标记用字符码拼，命令行保持纯 ASCII）。 */
async function findNotepadPids() {
  const { stdout } = await runPowerShell(['-Command',
    '$needle = -join ([char]0x4E2D, [char]0x6587, [char]0x6807, [char]0x9898); '
    + "Get-Process notepad -ErrorAction SilentlyContinue | "
    + "Where-Object { $_.MainWindowTitle -like ('*' + $needle + '*') } | "
    + 'ForEach-Object { $_.Id }']);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

/** 还在跑的 collector.ps1 进程（按命令行认，不按进程名瞎猜）。 */async function collectorProcesses() {
  // 注意：这里把脚本名拼起来，别在命令行里出现完整字面量，
  // 否则这段 PowerShell 自己的命令行也会被 -like 匹配中（会误报成孤儿）。
  const { stdout } = await runPowerShell(['-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
    + "Where-Object { $_.ProcessId -ne $PID -and "
    + "$_.CommandLine -like ('*' + 'collector' + '.' + 'ps1' + '*') } | "
    + 'ForEach-Object { $_.ProcessId }']);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 只读查一次库。采集器还在写的时候可能撞上短暂的锁，重试几次。
 * @param {string} dbPath @param {string} sql @returns {object[]}
 */
function readRows(dbPath, sql) {
  for (let attempt = 0; ; attempt += 1) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      return db.prepare(sql).all();
    } catch (error) {
      if (attempt >= 5) throw error;
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
  }
}

/** @param {string} dbPath @returns {object[]} 全部事件行 */
function readEvents(dbPath) {
  return readRows(dbPath, 'SELECT id, bucket_id, ts, duration, data, source FROM events ORDER BY ts');
}

const workDir = mkdtempSync(join(tmpdir(), 'lifehud-capture-'));
const keep = process.argv.includes('--keep');
let disposer = null;

try {
  /* ---------------------------------------------- A. 合并语义（确定性） */

  console.log('\n--- A. 合并语义（确定性喂样本，不启真实采集器）---');
  // 把 WINDIR 指向一个不存在的目录：采集器 spawn 会失败，但合并/落盘逻辑照跑。
  // 顺带验证「采集器起不来」时诊断确实进了 warnings（规格 §7 风险 7）。
  const realWinDir = process.env.WINDIR;
  process.env.WINDIR = join(workDir, 'no-such-windir');
  const mergeDb = join(workDir, 'merge.db');
  try {
    disposer = startCollector({ captureDb: mergeDb, capturePollSeconds: 2, afkThresholdSeconds: 180 });
    await sleep(300);

    const status = captureStatus();
    check('A1 采集库已建好', existsSync(mergeDb), mergeDb);
    check('A2 采集器 spawn 失败进诊断', status.warnings.some((w) => /capture: /i.test(w)),
      status.warnings[0] ?? '(无 warning)');

    const base = Date.parse('2026-01-01T09:00:00.000Z');
    const feed = (app, title, statusText, fromMs) => {
      appendSample({
        timestamp: new Date(fromMs).toISOString(),
        app,
        title,
        idle_seconds: 0.5,
        status: statusText,
      });
    };
    // 30 条 × 2 秒 = 同一应用连续 58 秒（应当合并成 1 行）
    for (let i = 0; i < 30; i += 1) feed('Code.exe', 'index.js - VS Code', 'not-afk', base + i * 2000);
    // 隔 30 秒（> pulsetime 10s）换应用 → 必须是新行
    const after = base + 58 * 1000 + 30000;
    for (let i = 0; i < 10; i += 1) feed('msedge.exe', 'DeepSeek', 'not-afk', after + i * 2000);
    appendSample({
      timestamp: new Date(after + 100001).toISOString(),
      app: 'msedge.exe', title: 'DeepSeek', idle_seconds: 0.1, status: 'afk',
    });
  } finally {
    // disposer 的顺序就是规格要求的：kill → flush → close。
    disposer();
    disposer = null;
    process.env.WINDIR = realWinDir;
  }

  const mergeRows = readEvents(mergeDb);
  const winRows = mergeRows.filter((r) => r.bucket_id.startsWith('lifehud-window_'));
  const afkRows = mergeRows.filter((r) => r.bucket_id.startsWith('lifehud-afk_'));
  check('A3 两条流各有 bucket 行', winRows.length > 0 && afkRows.length > 0,
    `window ${winRows.length} 行 / afk ${afkRows.length} 行`);
  // 31 条 window 样本 → 3 段（Code 段、间隔断开后的 msedge 段、AFK 样本切出的新段）
  check('A4 连续同应用被合并成 1 段', winRows.length === 3, `${winRows.length} 段（31 条样本）`);
  const first = winRows[0];
  check('A5 duration = 末样本 - 首样本', Math.abs(first.duration - 58) < 0.01, `duration=${first.duration}s`);
  const firstData = JSON.parse(first.data);
  check('A6 data 是原始 JSON（app/title 原文）',
    firstData.app === 'Code.exe' && firstData.title === 'index.js - VS Code', first.data);
  check('A7 afk 流 data 只有 status', JSON.parse(afkRows[0].data).status === 'not-afk'
    || JSON.parse(afkRows[0].data).status === 'afk', afkRows[0].data);
  check('A8 ts 是 ISO8601 UTC', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(first.ts), first.ts);
  check('A9 source=live', mergeRows.every((r) => r.source === 'live'));
  check('A10 行数远小于样本数', mergeRows.length < 42 / 2,
    `${mergeRows.length} 行 / 32 条样本`);

  const bucketRows = readRows(mergeDb, 'SELECT id, type, client, hostname FROM buckets ORDER BY id');
  check('A11 两个自采集 bucket 都在', bucketRows.length === 2,
    bucketRows.map((b) => `${b.id}(${b.type})`).join(', '));
  const metaRows = readRows(mergeDb, 'SELECT key, value FROM meta');
  check('A12 meta 有 schema_version', metaRows.some((m) => m.key === 'schema_version' && m.value === '2'));
  const indexRows = readRows(mergeDb, "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_events%'");
  check('A13 两个索引都在', indexRows.length === 2, indexRows.map((i) => i.name).join(', '));

  // storeTitles:false 时不落标题
  const muteDb = join(workDir, 'mute.db');
  const muteStop = startCollector({ captureDb: muteDb, storeTitles: false });
  appendSample({
    timestamp: new Date('2026-01-02T00:00:00.000Z').toISOString(),
    app: 'Code.exe', title: '机密文件.txt', idle_seconds: 0, status: 'not-afk',
  });
  muteStop();
  const muteTitle = JSON.parse(readEvents(muteDb).find((r) => r.bucket_id.startsWith('lifehud-window_')).data).title;
  check('A14 storeTitles:false 不落标题', muteTitle === '', `title=${JSON.stringify(muteTitle)}`);

  /* ---------------------------------------------- B. 真实采集器 */

  console.log('\n--- B. 真实采集器（spawn powershell，跑几轮采样）---');
  const liveDb = join(workDir, 'live.db');
  const leftoversBefore = await collectorProcesses();
  check('B1 启动前没有孤儿采集进程', leftoversBefore.length === 0, leftoversBefore.join(','));

  const stop = startCollector({ captureDb: liveDb, capturePollSeconds: 1, afkThresholdSeconds: 180 });
  const pid = captureStatus().pid;
  check('B2 采集器进程起来了', Number.isFinite(pid) && pid > 0, `pid=${pid}`);

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && captureStatus().samples < 5) await sleep(300);
  const live = captureStatus();
  check('B3 收到 ≥5 条样本', live.samples >= 5, `samples=${live.samples}`);
  check('B4 采集器仍在运行（没有崩溃）', live.running === true, live.lastError || '');

  const liveRows = readEvents(liveDb);
  check('B5 已落库（含未闭合事件的实时行）', liveRows.length >= 2, `${liveRows.length} 行`);
  const liveWin = liveRows.filter((r) => r.bucket_id.startsWith('lifehud-window_'));
  const liveAfk = liveRows.filter((r) => r.bucket_id.startsWith('lifehud-afk_'));
  check('B6 window/afk 两条流都有行', liveWin.length >= 1 && liveAfk.length >= 1,
    `window ${liveWin.length} / afk ${liveAfk.length}`);
  const winData = JSON.parse(liveWin[0].data);
  check('B7 窗口事件含 app 与 title 字段',
    typeof winData.app === 'string' && typeof winData.title === 'string' && winData.app.length > 0,
    JSON.stringify(winData));
  const liveTitles = liveWin.map((r) => JSON.parse(r.data).title);
  const afkStatus = JSON.parse(liveAfk[0].data).status;
  check('B8 AFK 状态取值合法', afkStatus === 'afk' || afkStatus === 'not-afk', afkStatus);
  check('B9 行数远小于样本数（合并生效）', liveRows.length <= live.samples,
    `${liveRows.length} 行 / ${live.samples} 条样本`);

  // 采集期间的行里不能出现编码坏掉的替换字符
  const rawText = liveRows.map((r) => r.data).join('');
  check('B10 落库文本没有 U+FFFD（未乱码）', !rawText.includes('\uFFFD'));

  stop();
  let gone = [];
  const killDeadline = Date.now() + 6000;
  do {
    gone = await collectorProcesses();
    if (gone.length === 0) break;
    await sleep(300);
  } while (Date.now() < killDeadline);
  check('B11 dispose 后没有残留 powershell 采集进程', gone.length === 0, gone.join(','));
  check('B12 dispose 后状态回到空闲', captureStatus().running === false && captureStatus().dbPath === null);

  /* ---------------------------------------------- C. 中文编码 */

  console.log('\n--- C. stdout 编码（中文标题不能乱码）---');
  // C1 机制断言：collector.ps1 开头那句 OutputEncoding 设完后，中文 JSON 行必须是 UTF-8。
  //    （不依赖前台窗口是谁，随时可跑。）
  const cjk = '中文标题-记事本.txt';
  const { stdout: cjkOut } = await runPowerShell(['-Command',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
    + `[Console]::Out.WriteLine(([ordered]@{ title = '${cjk}' } | ConvertTo-Json -Compress)); `
    + '[Console]::Out.Flush()']);
  let cjkTitle = '';
  try {
    cjkTitle = JSON.parse(cjkOut.trim()).title;
  } catch { /* 下面的断言会报出来 */ }
  check('C1 OutputEncoding=UTF8 后中文原样到达', cjkTitle === cjk,
    `收到 ${JSON.stringify(cjkTitle)}`);

  // C2 真实样本：前台窗口若带中文（含记事本），落库的标题必须一字不差。
  //    后台进程可能抢不到前台（桌面锁屏 / 无人操作），那就用 C1 的机制断言兜底，
  //    但 B 段真实采到的中文标题也算数（title 必须原样、不含替换字符）。
  const notepadFile = join(workDir, '中文标题.txt');
  writeFileSync(notepadFile, 'lifehud');
  spawn('notepad.exe', [notepadFile], { detached: true, stdio: 'ignore' }).unref();
  await sleep(1500);
  // 记事本可能是单实例转发，spawn 拿到的 pid 未必是真正的窗口进程；
  // 用「标题里含中文标记」把它找出来（标记用字符码拼，命令行里不出现中文，
  // 免得受控制台代码页影响）。
  const notepadPids = await findNotepadPids();
  if (notepadPids.length > 0) {
    await runPowerShell(['-Command',
      `$w = New-Object -ComObject WScript.Shell; $w.AppActivate(${notepadPids[0]}) | Out-Null`]);
  }
  await sleep(2500);

  const probeDb = join(workDir, 'cjk.db');
  const cjkStop = startCollector({ captureDb: probeDb, capturePollSeconds: 1 });
  await sleep(4000);
  cjkStop();
  const cjkRows = readEvents(probeDb).filter((r) => r.bucket_id.startsWith('lifehud-window_'));
  const titles = [...liveTitles, ...cjkRows.map((r) => JSON.parse(r.data).title)];
  const hasCjk = titles.some((t) => /[\u4e00-\u9fff]/.test(t));
  const garbled = titles.some((t) => t.includes('\uFFFD'));
  check('C2 真实样本里没有 U+FFFD', !garbled, titles.join(' | ').slice(0, 160));
  if (hasCjk) {
    check('C3 真实中文窗口标题原样落库', !garbled,
      titles.filter((t) => /[\u4e00-\u9fff]/.test(t)).join(' | ').slice(0, 160));
  } else {
    console.log(`SKIP  C3 实测这段没有中文前台窗口（${JSON.stringify(titles[0] ?? '')}），`
      + '中文原样性由 C1 的机制断言兜底');
  }

  // 收拾记事本（标题里带我们标记的那几个）
  for (const pid of await findNotepadPids()) {
    await runPowerShell(['-Command',
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`]);
  }
  const afterCleanup = await collectorProcesses();
  check('C4 全程结束后没有残留采集进程', afterCleanup.length === 0, afterCleanup.join(','));

  /* ---------------------------------------------- D. 迁移 AW 历史 */

  console.log('\n--- D. 全量迁移 ActivityWatch 历史 ---');
  // AW 库位置一律推导，不写死路径
  const awSource = join(process.env.LOCALAPPDATA ?? '', 'activitywatch', 'activitywatch',
    'aw-server', 'peewee-sqlite.v2.db');
  if (!existsSync(awSource)) {
    console.log(`SKIP  D* 这台机器没有 AW 库（${awSource}），跳过迁移断言`);
  } else {
    // 先自己数一遍 AW 到底有多少行（复制副本，别读正在被写的原库）
    const awCopy = join(workDir, 'aw-copy.db');
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(awSource + suffix)) copyFileSync(awSource + suffix, awCopy + suffix);
    }
    const awDb = new DatabaseSync(awCopy, { readOnly: true });
    const awEventCount = Number(awDb.prepare('SELECT COUNT(*) AS n FROM eventmodel').get().n);
    const awBuckets = awDb.prepare('SELECT id, type FROM bucketmodel').all();
    const awZeroDurations = Number(awDb.prepare('SELECT COUNT(*) AS n FROM eventmodel WHERE duration = 0').get().n);
    const awTimestamps = awDb.prepare('SELECT timestamp AS ts FROM eventmodel').all();
    awDb.close();
    console.log(`AW 库：${awBuckets.length} 个 bucket / ${awEventCount} 条事件`);

    const migrateDb = join(workDir, 'migrate.db');
    const leftoversBefore = readdirSync(tmpdir()).filter((name) => name.startsWith('lifehud-aw-'));
    const t0 = Date.now();
    const stats = importHistory({ captureDb: migrateDb, dataDir: workDir });
    const migrateMs = Date.now() - t0;
    console.log(`迁移：${JSON.stringify(stats)}  ${migrateMs}ms`);

    check('D1 迁移成功', stats.skipped === '', stats.skipped);
    check('D2 bucket 全部迁入（含空的 general.stopwatch）',
      readRows(migrateDb, 'SELECT id, type FROM buckets').length === awBuckets.length
      && readRows(migrateDb, "SELECT id FROM buckets WHERE type = 'general.stopwatch'").length === 1,
      readRows(migrateDb, 'SELECT id FROM buckets').map((b) => b.id).join(', '));
    const migrated = readRows(migrateDb, 'SELECT COUNT(*) AS n FROM events')[0].n;
    check('D3 事件数与 AW 一致（一条都不丢）', migrated === awEventCount, `${migrated} / AW ${awEventCount}`);
    check('D4 duration=0 的心跳也保留',
      readRows(migrateDb, 'SELECT COUNT(*) AS n FROM events WHERE duration = 0')[0].n === awZeroDurations,
      `${readRows(migrateDb, 'SELECT COUNT(*) AS n FROM events WHERE duration = 0')[0].n} / AW ${awZeroDurations}`);
    check('D5 源码标记 source=aw-migrated',
      readRows(migrateDb, "SELECT COUNT(*) AS n FROM events WHERE source <> 'aw-migrated'")[0].n === 0);
    check('D6 两条流都在（window 万级 / afk 数百）',
      readRows(migrateDb, "SELECT COUNT(*) AS n FROM events e JOIN buckets b ON b.id = e.bucket_id WHERE b.type = 'currentwindow'")[0].n > 10000
      && readRows(migrateDb, "SELECT COUNT(*) AS n FROM events e JOIN buckets b ON b.id = e.bucket_id WHERE b.type = 'afkstatus'")[0].n > 500,
      'currentwindow + afkstatus');

    const meta = new Map(readRows(migrateDb, 'SELECT key, value FROM meta').map((m) => [m.key, m.value]));
    check('D7 history_imported = 1', meta.get('history_imported') === '1', String(meta.get('history_imported')));
    let classes = null;
    try { classes = JSON.parse(String(meta.get('aw_classes'))); } catch { /* 下面的断言会报 */ }
    check('D8 meta.aw_classes 是 AW 的完整 classes 数组',
      Array.isArray(classes) && classes.length > 0 && Array.isArray(classes[0]?.name),
      `${classes?.length ?? 0} 条`);

    const rawRow = readRows(migrateDb,
      "SELECT e.data FROM events e JOIN buckets b ON b.id = e.bucket_id WHERE b.type = 'currentwindow' LIMIT 1")[0];
    let rawParses = false;
    try { JSON.parse(rawRow?.data); rawParses = true; } catch { /* 下面的断言会报 */ }
    check('D9 data 存的是 datastr 原文（空格、字段都保留）',
      typeof rawRow?.data === 'string' && rawRow.data.includes('"app": "') && rawParses, rawRow?.data);
    check('D10 ts 全部是 ISO8601 UTC',
      readRows(migrateDb, "SELECT ts FROM events WHERE ts NOT LIKE '____-__-__T__:__:__.___Z' LIMIT 1").length === 0);

    const before = readRows(migrateDb, 'SELECT COUNT(*) AS n FROM events')[0].n;
    const again = importHistory({ captureDb: migrateDb, dataDir: workDir });
    const after = readRows(migrateDb, 'SELECT COUNT(*) AS n FROM events')[0].n;
    check('D11 二次导入不新增行（幂等）', again.skipped === 'already' && before === after,
      `${again.skipped}：${before} → ${after}`);

    const leftoversAfter = readdirSync(tmpdir()).filter((name) => name.startsWith('lifehud-aw-'));
    check('D12 迁移临时副本已清理（tmpdir 里没留垃圾）',
      leftoversAfter.length === leftoversBefore.length,
      leftoversBefore.length === 0 ? '无残留' : leftoversAfter.join(','));

    // 迁移后的数据要能直接画出专注卡与热力日历（不断档）
    const activity = readOwnActivity({ captureDb: migrateDb, dataDir: workDir }, 84);
    const heat = new Map(activity.heatmap.map((d) => [d.d, d.m]));
    const busyDays = activity.heatmap.filter((d) => d.m > 0).length;
    check('D13 迁移后专注卡可用', activity.focus.available === true);
    check('D14 迁移后 top 非空', (activity.focus.top ?? []).length > 0,
      (activity.focus.top ?? []).slice(0, 3).map((a) => `${a.app} ${a.minutes}`).join(' · '));

    // AW 里有数据的每一天，热力日历都不该是 0（断档 = 迁移丢了数据）
    const localDay = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const awDays = [...new Set(awTimestamps
      .map((row) => Date.parse(row.ts))
      .filter((ms) => Number.isFinite(ms))
      .map(localDay))].filter((key) => heat.has(key));
    // 今天不算：它只是刚刚开始的一段（采集到的几分钟可能都是空转），不能算「断档」。
    const todayKey = localDay(Date.now());
    const gaps = awDays.filter((key) => key !== todayKey && (heat.get(key) ?? 0) <= 0);
    check('D15 AW 有数据的每一天热力都不为 0（不断档）', gaps.length === 0,
      `AW 覆盖 ${awDays.length} 天（${awDays[0]} → ${awDays.at(-1)}），热力有数据 ${busyDays} 天，`
      + `空 ${gaps.length} 天：${gaps.slice(0, 3).join(',')}`);
  }
} finally {
  if (disposer) disposer();
  if (!keep) rmSync(workDir, { recursive: true, force: true });
  else console.log(`\n(保留临时目录：${workDir})`);
}

/* ---------------------------------------------- 汇总 */

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(60)}`);
console.log(`probe-capture: ${results.length - failed.length}/${results.length} 通过`);
for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
if (failed.length > 0) process.exitCode = 1;
