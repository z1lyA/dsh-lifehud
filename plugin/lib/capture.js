/**
 * 专注采集：collector.ps1 子进程的生命周期、事件合并落盘、AW 历史一次性迁移。
 * 从 plugin/index.js 拆出（v1.1.2 评审 S3）。采集器脚本在上一级：../collector.ps1。
 */
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync, readFileSync, mkdirSync, copyFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { envPath } from './util.js';

/* ---- 自采集（前台窗口 + AFK）常量，见下面「自采集」一节 ---- */
/** 本地采集库文件名：`<dataDir>/capture.db`（`config.captureDb` 可整段覆盖）。 */
const CAPTURE_FILE = 'capture.db';
/** 采样间隔（秒）。2 秒接近 AW 的 1 秒粒度，又不会把库写胖。 */
const CAPTURE_POLL_SECONDS_DEFAULT = 2;
/** 空闲超过这么多秒算「离开」。 */
const AFK_THRESHOLD_DEFAULT = 180;
/** 同一事件内允许的最大心跳间隔，超过就当新事件（对齐 AW 的 pulsetime）。 */
const CAPTURE_PULSETIME_MIN_SECONDS = 10;
/** 攒够这么多事件、或者等这么久，就落盘一次（批量写，少抖动）。 */
const CAPTURE_FLUSH_ROWS = 50;
const CAPTURE_FLUSH_MS = 60 * 1000;
/** 采集器意外退出后的重启上限（指数退避，到顶就停并写诊断）。 */
const CAPTURE_RESTART_MAX = 5;
/** 诊断区最多保留这么多条采集相关 warning。 */
const CAPTURE_WARNING_MAX = 20;
/** 采集库的表结构版本（规格 §4.3）。 */
const CAPTURE_SCHEMA_VERSION = '2';
/** 本插件自采集的 bucket 归属者，迁移来的数据仍是 'aw-watcher-window' 等原值。 */
const CAPTURE_CLIENT = 'lifehud-capture';

/* ------------------------------------------------- 自采集（前台窗口 + AFK） */

/**
 * 专注卡的数据从 v1.1.1 起是自己采的，不再依赖 ActivityWatch 进程：
 *
 *   Windows user32/kernel32
 *      ↑ P/Invoke（C#，靠 Windows 自带的 PowerShell 5.1 在内存里编译，零安装）
 *   plugin/collector.ps1         长驻子进程，每 N 秒输出一行 JSON
 *      ↓ stdout（JSONL，UTF-8 —— 脚本开头把 OutputEncoding 设成 UTF-8，否则中文乱码）
 *   startCollector()             readline 逐行收流
 *      ↓ appendSample()          同 bucket + 同 data + 间隔 ≤ pulsetime 就延长未闭合事件
 *   <dataDir>/capture.db         node:sqlite（LifeHud 唯一可写的地方）
 *      ↓ readOwnActivity()
 *   buildHud() 的 focus / heatmap → GET /lifehud/api/hud（对外契约不变）
 *
 * 采集（写）与展示（读）解耦：页面请求只读本地库，不触发采集、不联网。
 */

/**
 * 采集库建表语句（规格 §4.3 的通用模型：bucket + 原始 JSON 事件）。
 * `events.data` 存**原始 JSON 原文**，将来加新 watcher（键鼠计数 / 浏览器 URL …）
 * 直接塞进来就行，不用改库；`source` 区分实时采集与迁移来的历史。
 */
const CAPTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  id       TEXT PRIMARY KEY,
  type     TEXT NOT NULL,
  client   TEXT NOT NULL,
  hostname TEXT NOT NULL,
  created  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  bucket_id TEXT    NOT NULL REFERENCES buckets(id),
  ts        TEXT    NOT NULL,
  duration  REAL    NOT NULL,
  data      TEXT    NOT NULL,
  source    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_bucket_ts ON events(bucket_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** 采集运行时（模块级单例：HMR / 重装可能让 apply 跑两次，绝不能起两个采集器）。 */
let captureRuntime = null;

/** 采集器的诊断信息（buildHud 时附加到 warnings，页面诊断区才看得见）。 */
const captureWarnings = [];

/**
 * 记一条采集相关诊断：去重 + 封顶，避免刷屏。
 * @param {string} message @returns {void}
 */
function noteCapture(message) {
  const text = String(message ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return;
  const line = `capture: ${text}`;
  if (captureWarnings.includes(line)) return;
  captureWarnings.push(line);
  if (captureWarnings.length > CAPTURE_WARNING_MAX) captureWarnings.shift();
}

/**
 * capture.db 的位置：默认 `<dataDir>/capture.db`，可用 `config.captureDb` 整段覆盖。
 * @param {object} [config] bundle row config
 * @returns {string} path
 */
function captureDbPath(config = {}) {
  const explicit = String(config.captureDb ?? '');
  if (explicit) return explicit;
  const dataDir = String(config.dataDir ?? '') || join(homedir(), '.dsh', 'lifehud');
  return join(dataDir, CAPTURE_FILE);
}

/**
 * 打开（必要时新建）capture.db —— **非只读**，这是 LifeHud 唯一自己写的库。
 * 建表是幂等的，所以每次启动都可以放心调用。
 * @param {string} dbPath 库路径
 * @returns {import('node:sqlite').DatabaseSync} handle
 */
export function openCaptureDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL：写（采集器）与读（/hud 每次开只读连接）不必互相等，迁移大批写入时页面也不卡。
  // busy_timeout 兜住偶发的锁竞争（默认几乎等于不等）。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec(CAPTURE_SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', CAPTURE_SCHEMA_VERSION);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('hostname', hostname());
  return db;
}

/**
 * 保证某个 bucket 行存在（events 有外键，先有 bucket 才有事件）。
 * @param {object} db @param {string} id @param {string} type @param {string} host @returns {void}
 */
function ensureCaptureBucket(db, id, type, host) {
  db.prepare('INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, CAPTURE_CLIENT, host, new Date().toISOString());
}

/**
 * 未闭合事件 → 待写行。
 * @param {object} segment @returns {{rowId:number|null,bucketId:string,ts:string,duration:number,data:string}}
 */
function settleSegment(segment) {
  return {
    rowId: segment.rowId,
    bucketId: segment.bucketId,
    ts: new Date(segment.startMs).toISOString(),
    duration: Math.max(0, (segment.endMs - segment.startMs) / 1000),
    data: segment.data,
  };
}

/**
 * 收一条采集样本（采集器每 N 秒一行）。
 *
 * 一行样本拆成两条流：窗口（app + title）与 AFK（status）；两条流各自维护一条
 * 未闭合事件，同 data 且间隔 ≤ pulsetime 就延长，否则闭合旧的、开新的。
 * @param {object} row `{timestamp, app, title, idle_seconds, status}`
 * @returns {void}
 */
/**
 * 空闲秒数 → 离散档位。
 * 为什么不直接存每秒的 idle_seconds：合并语义靠 `data` 完全相同才延长事件，
 * 逐样本变化的数字会让「8 小时一个应用」从 1 行变成 14,400 行。档位与 AFK 阈值对齐
 * （180s 及以上就是 AFK），既能保留空闲强度，又不会破坏压缩。
 * @param {unknown} seconds
 * @returns {'0-10'|'10-60'|'60-180'|'180+'}
 */
function idleLevel(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s >= 180) return '180+';
  if (s >= 60) return '60-180';
  if (s >= 10) return '10-60';
  return '0-10';
}

export function appendSample(row) {
  const state = captureRuntime;
  if (!state?.db) return;
  const tsMs = Date.parse(String(row?.timestamp ?? ''));
  if (!Number.isFinite(tsMs)) return;

  state.samples += 1;
  state.lastSampleAt = tsMs;
  // 有样本 = 采集器活着。每帧清零重启计数，免得「睡眠唤醒偶发崩几次」攒到上限后
  // 就永久停采（否则跑几周就会被 5 次历史崩溃拖死）。
  state.restarts = 0;

  const app = String(row?.app ?? '') || 'unknown';
  // 窗口标题可能很敏感：storeTitles:false 时只留应用名（决策 D3）。
  const title = state.storeTitles ? String(row?.title ?? '') : '';
  const status = String(row?.status ?? '') === 'afk' ? 'afk' : 'not-afk';
  const idle = idleLevel(row?.idle_seconds);

  const openedWindow = pushSegment(state, state.windowBucket, JSON.stringify({ app, title }), tsMs);
  const openedAfk = pushSegment(state, state.afkBucket, JSON.stringify({ status }), tsMs);
  const openedIdle = pushSegment(state, state.idleBucket, JSON.stringify({ level: idle }), tsMs);

  // 事件切换（开/闭一段）就立刻落盘：这样第一个样本到来后库里马上有行，
  // 「刚切到新应用」也不用等下一个 60 秒。同一应用连续不变时只靠 flush 定时器
  // 更新 duration，写入次数可以忽略。
  if (openedWindow || openedAfk || openedIdle || state.pending.length >= CAPTURE_FLUSH_ROWS) flushCapture(state);
}

/**
 * 把一条样本并进某条流的未闭合事件。
 * @param {object} state 运行时 @param {string} bucketId @param {string} data 原始 JSON
 * @param {number} tsMs 样本时间
 * @returns {boolean} 是否新开了一段（新开 = 需要马上落盘）
 */
function pushSegment(state, bucketId, data, tsMs) {
  const open = state.open.get(bucketId);
  // 时间倒退的样本（时钟回拨 / 乱序）一律当新事件，别把旧时长撑坏。
  if (open && open.data === data && tsMs >= open.endMs && tsMs - open.endMs <= state.pulsetimeMs) {
    open.endMs = tsMs;
    return false;
  }
  if (open) {
    state.pending.push(settleSegment(open));
    state.open.delete(bucketId);
  }
  state.open.set(bucketId, { rowId: null, bucketId, data, startMs: tsMs, endMs: tsMs });
  return true;
}

/**
 * 写一段事件：没有 rowid 就 INSERT 并回填，有就 UPDATE duration。
 * 闭合段与未闭合段走同一套分派（抽出来也让回滚清理只有一处）。
 * @param {object} state 运行时
 * @param {{rowId:number|null,bucketId:string,ts:string,duration:number,data:string}} row
 * @returns {boolean} 是否本轮新 INSERT（回滚后要把 rowId 清掉）
 */
function writeSegmentRow(state, row) {
  if (row.rowId == null) {
    const result = state.insertStmt.run(row.bucketId, row.ts, row.duration, row.data, 'live');
    row.rowId = Number(result.lastInsertRowid);
    return true;
  }
  state.updateStmt.run(row.duration, row.rowId);
  return false;
}

/**
 * 落盘。
 *
 * 未闭合事件也一起写：先 INSERT 拿到 rowid，之后每次 flush 原地 UPDATE duration。
 * 这样「同一个应用连续 8 小时」库里只有一行，而页面上又能看到实时增长的时长
 * —— 否则事件不切换就永远不落盘，专注卡会一直看着是空的。
 * @param {object|null} [state] 运行时，默认当前单例
 * @returns {number} 本轮落盘的事件数（含 UPDATE，够诊断用）
 */
export function flushCapture(state = captureRuntime) {
  if (!state?.db) return 0;
  const closed = state.pending.splice(0, state.pending.length);
  const open = [...state.open.values()];
  if (closed.length === 0 && open.length === 0) return 0;

  let written = 0;
  /** 本轮新 INSERT 的行；回滚后它们已经不存在，必须清掉 rowId（见 catch 里的说明）。 */
  const inserted = [];
  try {
    state.db.exec('BEGIN');
    for (const row of closed) {
      if (writeSegmentRow(state, row)) inserted.push({ row });
      written += 1;
    }
    for (const segment of open) {
      const row = settleSegment(segment);
      if (writeSegmentRow(state, row)) {
        // 新插入的行 id 落在 segment 上：下一轮直接 UPDATE，不再 INSERT。
        segment.rowId = row.rowId;
        inserted.push({ row, segment });
      }
      written += 1;
    }
    state.db.exec('COMMIT');
    state.rows += written;
    state.lastFlushAt = Date.now();
    return written;
  } catch (error) {
    try { state.db.exec('ROLLBACK'); } catch { /* 事务可能已经不在了 */ }
    // 回滚后本轮 INSERT 的行已经不存在：不清 rowId，下一轮就会走 UPDATE 命中 0 行，
    // 而 SQLite 不会报错 → 这一段静默丢失（专注/热力少算）。闭合行同理，放回队列前也要清。
    for (const item of inserted) {
      item.row.rowId = null;
      if (item.segment) item.segment.rowId = null;
    }
    // 没写成功的闭合事件放回队列，下一轮再试，别默默丢掉数据。
    if (closed.length > 0) state.pending.unshift(...closed);
    state.lastError = error instanceof Error ? error.message : String(error);
    noteCapture(`写库失败：${state.lastError}`);
    return 0;
  }
}

/** `process.on('exit')` 兜底只注册一次。 */
let captureExitHookInstalled = false;

/** 兜底：无论怎么退出，都别把 powershell 采集进程留在后台。 */
function installCaptureExitHook() {
  if (captureExitHookInstalled) return;
  captureExitHookInstalled = true;
  process.on('exit', () => {
    try { captureRuntime?.child?.kill(); } catch { /* 进程已经没了 */ }
  });
}

/**
 * 启动（或重启）采集器子进程。
 * @param {object} state 运行时 @returns {void}
 */
function spawnCaptureChild(state) {
  // 不依赖 PATH（也不点名 pwsh，Windows 自带的是 5.1 版 powershell.exe）；
  // 目录同样来自环境变量，仓库里不出现任何绝对路径。
  const winDir = process.env.WINDIR || process.env.SystemRoot || '';
  if (!winDir) {
    noteCapture('找不到 %WINDIR%，无法启动采集器');
    return;
  }

  let script;
  try {
    script = fileURLToPath(new URL('../collector.ps1', import.meta.url));
  } catch (error) {
    noteCapture(`定位 collector.ps1 失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!existsSync(script)) {
    noteCapture('collector.ps1 不存在（插件包缺文件？）');
    return;
  }

  let child;
  try {
    child = spawn(join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-PollSeconds', String(state.pollSeconds), '-AfkThreshold', String(state.afkThreshold),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    noteCapture(`启动采集器失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  state.child = child;
  state.pid = child.pid ?? null;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  state.rl = rl;
  rl.on('line', (line) => {
    const text = String(line ?? '').trim();
    if (!text) return;
    try {
      appendSample(JSON.parse(text));
    } catch {
      // 采集器偶尔输出杂音（例如 Warning 流被合并进来），不当错误。
      state.noise = (state.noise ?? 0) + 1;
    }
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  child.on('error', (error) => {
    noteCapture(`采集器进程错误：${error instanceof Error ? error.message : String(error)}`);
  });

  child.on('exit', (code, signal) => {
    if (state.rl === rl) {
      try { rl.close(); } catch { /* 已关闭 */ }
      state.rl = null;
    }
    if (state.child === child) state.child = null;
    if (state.stopping) return;
    const detail = stderr.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
    state.lastError = detail;
    noteCapture(`采集器退出（${code ?? signal}）：${detail}`);
    scheduleCaptureRestart(state);
  });
}

/**
 * 采集器崩了就按指数退避重启，最多 CAPTURE_RESTART_MAX 次；到顶就停并写诊断，
 * 让用户至少能在诊断区看到「为什么没有数据」。
 * @param {object} state 运行时 @returns {void}
 */
function scheduleCaptureRestart(state) {
  if (state.stopping || captureRuntime !== state) return;
  if (state.restarts >= CAPTURE_RESTART_MAX) {
    noteCapture(`采集器已连续重启 ${state.restarts} 次，停止尝试（专注卡可能没有新数据）`);
    return;
  }
  const delay = Math.min(30000, 500 * 2 ** state.restarts);
  state.restarts += 1;
  const timer = setTimeout(() => {
    state.restartTimer = null;
    if (state.stopping || captureRuntime !== state) return;
    spawnCaptureChild(state);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  state.restartTimer = timer;
}

/**
 * 启动采集（单例）。
 * @param {object} [config] bundle row config
 * @returns {() => void} disposer：kill 子进程 → flush → 关库
 */
export function startCollector(config = {}) {
  if (captureRuntime) {
    noteCapture('采集器已在运行，忽略重复启动');
    return () => {};
  }

  const dbPath = captureDbPath(config);
  const pollSeconds = Math.max(1, Number(config.capturePollSeconds ?? 0) || CAPTURE_POLL_SECONDS_DEFAULT);
  const afkThreshold = Math.max(30, Number(config.afkThresholdSeconds ?? 0) || AFK_THRESHOLD_DEFAULT);
  const host = hostname();
  const windowBucket = `lifehud-window_${host}`;
  const afkBucket = `lifehud-afk_${host}`;
  // 第三条流：空闲强度（离散档位）。窗口/AFK 流回答「在用什么」，这条回答「有多专注」。
  const idleBucket = `lifehud-idle_${host}`;

  let db;
  try {
    db = openCaptureDb(dbPath);
    ensureCaptureBucket(db, windowBucket, 'currentwindow', host);
    ensureCaptureBucket(db, afkBucket, 'afkstatus', host);
    ensureCaptureBucket(db, idleBucket, 'idle', host);
  } catch (error) {
    noteCapture(`打不开采集库 ${dbPath}：${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }

  const state = {
    dbPath,
    db,
    host,
    windowBucket,
    afkBucket,
    idleBucket,
    pollSeconds,
    afkThreshold,
    // pulsetime = max(pollSeconds * 2, 10) 秒：采样间隔的两倍，避免偶尔掉一拍就断开事件。
    pulsetimeMs: Math.max(pollSeconds * 2, CAPTURE_PULSETIME_MIN_SECONDS) * 1000,
    storeTitles: config.storeTitles !== false,
    pending: [],
    open: new Map(),
    insertStmt: db.prepare('INSERT INTO events (bucket_id, ts, duration, data, source) VALUES (?, ?, ?, ?, ?)'),
    updateStmt: db.prepare('UPDATE events SET duration = ? WHERE id = ?'),
    child: null,
    rl: null,
    pid: null,
    restarts: 0,
    stopping: false,
    restartTimer: null,
    flushTimer: null,
    noise: 0,
    samples: 0,
    rows: 0,
    lastSampleAt: 0,
    lastFlushAt: 0,
    lastError: '',
  };
  captureRuntime = state;

  installCaptureExitHook();
  spawnCaptureChild(state);

  state.flushTimer = setInterval(() => { flushCapture(state); }, CAPTURE_FLUSH_MS);
  if (typeof state.flushTimer.unref === 'function') state.flushTimer.unref();

  return () => stopCapture(state);
}

/**
 * 收尾。顺序照规格：先 kill 子进程（别再进新样本）→ 落盘 → 关库。
 * @param {object|null} [state] 运行时，默认当前单例
 * @returns {void}
 */
function stopCapture(state = captureRuntime) {
  if (!state || captureRuntime !== state) return;
  captureRuntime = null;
  state.stopping = true;

  if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
  if (state.flushTimer) { clearInterval(state.flushTimer); state.flushTimer = null; }
  try { state.rl?.close(); } catch { /* 已关闭 */ }
  state.rl = null;
  if (state.child) {
    try { state.child.kill(); } catch { /* 已经退出 */ }
    state.child = null;
  }
  try { flushCapture(state); } catch { /* 尽力落盘，失败也要关库 */ }
  try { state.db?.close(); } catch { /* 已关闭 */ }
  state.db = null;
  state.pending.length = 0;
  state.open.clear();
}

/**
 * 采集器状态快照（给诊断区 / 探针用，不含数据库句柄）。
 * @returns {object} status
 */
export function captureStatus() {
  const state = captureRuntime;
  const status = {
    running: Boolean(state?.child && state.child.exitCode == null),
    pid: state?.pid ?? null,
    dbPath: state?.dbPath ?? null,
    samples: state?.samples ?? 0,
    // 写入次数（INSERT + UPDATE），不是库内行数；未闭合事件每 60 秒会 UPDATE 一次。
    writes: state?.rows ?? 0,
    pending: state?.pending.length ?? 0,
    restarts: state?.restarts ?? 0,
    // 采集器 stdout 里解析不出来的行数（正常应为 0；不为 0 说明 PowerShell 往 stdout
    // 掺了别的东西，比如 Warning 流）。
    noise: state?.noise ?? 0,
    pollSeconds: state?.pollSeconds ?? null,
    lastSampleAt: state?.lastSampleAt ? new Date(state.lastSampleAt).toISOString() : null,
    lastError: state?.lastError || null,
    warnings: [...captureWarnings],
  };
  return status;
}

/* --------------------------------------------- ActivityWatch 历史一次性迁移 */

/**
 * ActivityWatch 的 peewee 库默认位置。
 * 仓库里不写绝对路径：`%LOCALAPPDATA%` 本来就在用户目录下。
 * @returns {string} path
 */
function defaultHistorySource() {
  return envPath(process.env.LOCALAPPDATA ?? '', 'activitywatch', 'activitywatch',
    'aw-server', 'peewee-sqlite.v2.db');
}

/**
 * AW 的时间戳 → ISO8601 UTC。
 *
 * AW v0.14.1 事件里是 `2026-11-09 15:54:03.180000+00:00`（UTC 带偏移），
 * 但 bucket 的 `created` 是无时区的本地时间（`2026-10-28T23:22:07.320077`）。
 * 交给 `Date.parse`：带偏移按偏移算，不带偏移按本机时区算 —— 正好是我们要的口径。
 * @param {unknown} value @returns {string|null} ISO8601 UTC 或 null
 */
function awTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  // 兜底：少数版本用空格分隔时间，直接 date-time 解析更稳。
  const alt = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(alt) ? new Date(alt).toISOString() : null;
}

/** @param {object} db @param {string} key @returns {string} */
function readCaptureMeta(db, key) {
  try {
    return String(db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? '');
  } catch {
    return '';
  }
}

/** @param {object} db @param {string} key @param {string} value @returns {void} */
function writeCaptureMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

/**
 * 一次性把 ActivityWatch 的历史全量搬进本地采集库（规格 §4.6）。
 *
 * 这是**唯一**还会碰 ActivityWatch 的地方，而且只读文件：迁完就能卸载 AW，
 * 运行期零依赖。幂等 —— `meta.history_imported='1'` 之后直接跳过，重复调用不会
 * 多出一行；`config.historyImport === 'never'` 时完全不迁。
 *
 * 为什么先复制副本再读：AW 用 WAL 写库，直接读正在被写的原库有风险；
 * 复制 .db / -wal / -shm 到 tmpdir 里以只读方式打开，读完立刻删干净。
 * @param {object} [config] bundle row config
 * @returns {{skipped:string,buckets:number,events:number,duplicates:number,classes:number}} stats
 */
export function importHistory(config = {}) {
  const stats = { skipped: '', buckets: 0, events: 0, duplicates: 0, classes: 0 };
  if (config.historyImport === 'never') {
    stats.skipped = 'disabled';
    return stats;
  }
  const source = String(config.historySource ?? '') || defaultHistorySource();
  if (!source || !existsSync(source)) {
    // 没装过 AW（或已卸载）是很正常的事，不算错误、也不打扰用户。
    stats.skipped = 'no-source';
    return stats;
  }

  let db;
  try {
    db = openCaptureDb(captureDbPath(config));
  } catch (error) {
    noteCapture(`迁移：打不开采集库：${error instanceof Error ? error.message : String(error)}`);
    stats.skipped = 'db-error';
    return stats;
  }

  let tempDir = '';
  try {
    if (readCaptureMeta(db, 'history_imported') === '1') {
      stats.skipped = 'already';
      return stats;
    }

    // 1) 复制到临时目录（含 -wal / -shm），再以只读方式打开副本。
    tempDir = mkdtempSync(join(tmpdir(), 'lifehud-aw-'));
    const copyPath = join(tempDir, 'aw.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const from = source + suffix;
      if (existsSync(from)) copyFileSync(from, copyPath + suffix);
    }

    const aw = new DatabaseSync(copyPath, { readOnly: true });
    let awBuckets;
    let awEvents;
    try {
      awBuckets = aw.prepare(
        'SELECT key, id, type, client, hostname, created FROM bucketmodel',
      ).all();
      // ⚠️ eventmodel.bucket_id 指向 bucketmodel.key（INTEGER），不是 bucketmodel.id（TEXT）。
      // 用 id 文本去查会静默返回 0 行，所以这里必须 JOIN。
      awEvents = aw.prepare(`
        SELECT b.id AS bucket_id, e.timestamp AS ts, e.duration AS duration, e.datastr AS data
          FROM eventmodel e JOIN bucketmodel b ON b.key = e.bucket_id
         ORDER BY e.timestamp`).all();
    } finally {
      aw.close();
    }

    // 2) 分类规则（classes）：详情页做「分类汇总」的唯一依据，不归档就永久丢失。
    let classes = null;
    try {
      const settings = JSON.parse(readFileSync(join(dirname(source), 'settings.json'), 'utf8'));
      if (Array.isArray(settings?.classes)) classes = settings.classes;
    } catch (error) {
      noteCapture(`迁移：读不到 AW 的 settings.json（分类规则可能缺失）：${error instanceof Error ? error.message : String(error)}`);
    }

    // 3) 写库。一个事务一次性写完，中途失败就整体回滚，不会留半套数据。
    const insertBucket = db.prepare(
      'INSERT OR IGNORE INTO buckets (id, type, client, hostname, created) VALUES (?, ?, ?, ?, ?)',
    );
    const insertEvent = db.prepare(
      'INSERT INTO events (bucket_id, ts, duration, data, source) VALUES (?, ?, ?, ?, ?)',
    );
    // 同 bucket 同 ts 已经存在就不再写（重跑迁移 / 半途失败后再跑都不会重复）。
    const existing = new Set(db.prepare(
      "SELECT bucket_id, ts FROM events WHERE source = 'aw-migrated'",
    ).all().map((row) => `${row.bucket_id}\u0000${row.ts}`));

    db.exec('BEGIN');
    try {
      for (const bucket of awBuckets) {
        const id = String(bucket.id ?? '');
        if (!id) continue;
        insertBucket.run(
          id,
          String(bucket.type ?? 'unknown'),
          String(bucket.client ?? ''),
          String(bucket.hostname ?? ''),
          awTimestamp(bucket.created) ?? new Date().toISOString(),
        );
        stats.buckets += 1;
      }
      for (const event of awEvents) {
        const bucketId = String(event.bucket_id ?? '');
        const ts = awTimestamp(event.ts);
        if (!bucketId || !ts) continue;
        const key = `${bucketId}\u0000${ts}`;
        if (existing.has(key)) {
          stats.duplicates += 1;
          continue;
        }
        // 注意：**不要**把本次插入的 key 加进 existing —— AW 里确实存在同 bucket
        // 同 timestamp 的不同事件，加了会把它们当成重复丢掉（规格要求一个字段都不丢）。
        // 幂等靠的是「重跑时 existing 里已经有这些行」。
        // data 存 datastr **原文**：AW 里有几个字段就留几个字段。
        insertEvent.run(
          bucketId,
          ts,
          Math.max(0, Number(event.duration) || 0),
          String(event.data ?? '{}'),
          'aw-migrated',
        );
        stats.events += 1;
      }
      if (classes) {
        writeCaptureMeta(db, 'aw_classes', JSON.stringify(classes));
        stats.classes = classes.length;
      }
      writeCaptureMeta(db, 'history_imported', '1');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 事务可能已经不在了 */ }
      throw error;
    }
    return stats;
  } catch (error) {
    // 迁移失败不能拖垮插件：只进诊断，专注卡退化成「没有历史」而已。
    noteCapture(`迁移 ActivityWatch 历史失败：${error instanceof Error ? error.message : String(error)}`);
    stats.skipped = 'error';
    return stats;
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 删不掉也只是临时垃圾 */ }
    }
  }
}
export { captureDbPath, noteCapture, captureWarnings };
