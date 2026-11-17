/**
 * HUD 快照：NowTree 任务/时段、天气、DSH 会话，组装成 /hud 的 payload。
 * 从 plugin/index.js 拆出（v1.1.2 评审 S3）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOwnActivity, emptyActivity } from './activity.js';
import { captureStatus, captureWarnings } from './capture.js';
import { readSettingsFile } from './settings.js';
import { PLUGIN_VERSION } from './update.js';
import { envPath } from './util.js';

const DEFAULT_BOUNDS = { morningStart: 6, noonStart: 13, eveningStart: 18 };
const SLOT_LABEL = { morning: '早', noon: '午', evening: '晚', rest: '休息' };
/** 成功取到一次就复用这么久，避免开页面就打一次天气 API。 */
const WEATHER_TTL_MS = 10 * 60 * 1000;
/**
 * 单次取天气的超时。
 *
 * 实测同一条链路的耗时分布很不均匀：0.27 / 0.33 / 0.48 / **2.04 / 2.75** 秒
 * ——大多数很快，但有一条长尾。3 秒只比长尾多 0.25 秒，等于把及格线贴着最差成绩画，
 * 线路稍慢就把本来能成的请求判成超时（2026-11-17 真机上半天看不到天气，部分是这个原因）。
 * 5 秒给长尾留 2 秒余量；因为下面还有失败冷却，页面不会退回「每次刷新都卡满超时」。
 * 别调大：`/hud` 是整页首屏的入口，天气卡等多久，其它卡就跟着等多久。
 */
const WEATHER_TIMEOUT_MS = 5000;
/**
 * 失败后的冷却窗口：这段时间里 `/hud` **不再**去试探天气，直接给上次的值（或空）。
 * 没有它的话，天气一路不通 = 每次刷新都白等一个完整超时，页面会「一直很慢」。
 */
const WEATHER_FAIL_COOLDOWN_MS = 2 * 60 * 1000;

/** NowTree 的 SQLite（`%APPDATA%\com.nowtree.app\nowtree.sqlite`）。 */
const defaultNowtreeDb = () => envPath(process.env.APPDATA ?? '', 'com.nowtree.app', 'nowtree.sqlite');

/** NowTree 的 WebView2 localStorage（`%LOCALAPPDATA%\com.nowtree.app\EBWebView\…`）。 */
const defaultLeveldbDir = () => envPath(process.env.LOCALAPPDATA ?? '', 'com.nowtree.app',
  'EBWebView', 'Default', 'Local Storage', 'leveldb');


/**
 * Read NowTree's 早/午/晚 boundaries from its WebView2 localStorage (LevelDB).
 * @param {string} dir leveldb dir
 * @returns {{morningStart:number,noonStart:number,eveningStart:number}|null} bounds
 */
function readSlotBounds(dir) {
  if (!dir) return null;
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => /\.(ldb|log)$/i.test(name));
  } catch {
    return null;
  }
  let found = null;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(dir, file)).toString('latin1');
    } catch {
      continue;
    }
    const at = text.lastIndexOf('nowtree_slot_bounds');
    if (at === -1) continue;
    const match = text.slice(at, at + 180).match(/\{[^{}]*"morningStart"[^{}]*\}/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[0]);
      if (Number.isFinite(parsed.morningStart)) found = parsed;
    } catch { /* next file */ }
  }
  return found;
}

/** @param {number} hour @param {{morningStart:number,noonStart:number,eveningStart:number}} b */
function slotForHour(hour, b) {
  if (hour < b.morningStart) return 'rest';
  if (hour < b.noonStart) return 'morning';
  if (hour < b.eveningStart) return 'noon';
  return 'evening';
}

/** @param {string} slot @param {object} b @returns {string} */
function slotRange(slot, b) {
  const pad = (h) => `${String(h).padStart(2, '0')}:00`;
  if (slot === 'morning') return `${pad(b.morningStart)}–${pad(b.noonStart)}`;
  if (slot === 'noon') return `${pad(b.noonStart)}–${pad(b.eveningStart)}`;
  if (slot === 'evening') return `${pad(b.eveningStart)}–24:00`;
  return `00:00–${pad(b.morningStart)}`;
}

/**
 * Tasks of one slot.
 *
 * Deliberately does NOT apply NowTree's Next filter: the user plans by slot,
 * and expecting "对应时段的任务" means every active task carrying that slot.
 * `inNext` still marks which ones NowTree itself would surface in its Next view
 * (category='next_action' AND top-level, or show_in_next=1).
 * @param {string} dbPath @param {string} slot @returns {object[]} tasks
 */
function readSlotTasks(dbPath, slot) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, title, category, show_in_next, time_slot, deadline_type, deadline_date,
             priority, parent_id
      FROM transactions
      WHERE deleted = 0 AND status = 'active' AND time_slot = ?
      ORDER BY show_in_next DESC, priority DESC, order_index, id
    `).all(slot);
    return rows.map((row) => {
      const inNext = (row.category === 'next_action' && row.parent_id === null) || row.show_in_next === 1;
      return {
        id: row.id,
        title: row.title,
        next: inNext,
        category: row.category ?? null,
        parentId: row.parent_id ?? null,
        deadline: row.deadline_type && row.deadline_type !== 'none'
          ? { type: row.deadline_type, date: row.deadline_date ?? null }
          : null,
      };
    });
  } finally {
    db.close();
  }
}

/** WMO code + day flag → text + icon key. */
function weatherKind(code, day) {
  if (code === 0) return { text: '晴', icon: day ? 'sun' : 'moon' };
  if (code === 1) return { text: '晴间多云', icon: day ? 'partly' : 'moon-cloud' };
  if (code === 2) return { text: '多云', icon: 'cloud' };
  if (code === 3) return { text: '阴', icon: 'cloud' };
  if (code === 45 || code === 48) return { text: '雾', icon: 'fog' };
  if (code >= 51 && code <= 57) return { text: '毛毛雨', icon: 'drizzle' };
  if (code >= 61 && code <= 67) return { text: '雨', icon: 'rain' };
  if (code >= 71 && code <= 77) return { text: '雪', icon: 'snow' };
  if (code >= 80 && code <= 82) return { text: '阵雨', icon: 'rain' };
  if (code >= 85 && code <= 86) return { text: '阵雪', icon: 'snow' };
  if (code >= 95) return { text: '雷雨', icon: 'storm' };
  return { text: '—', icon: 'cloud' };
}

/**
 * Hourly weather from Open-Meteo, shaped for a phone-style strip.
 * @param {number} lat @param {number} lon
 * @returns {Promise<object>} weather
 */
async function fetchWeather(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&hourly=temperature_2m,precipitation_probability,weather_code,is_day'
    + '&daily=sunrise,sunset&forecast_days=2&timezone=Asia%2FShanghai';
  const response = await fetch(url, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`open-meteo HTTP ${response.status}`);
  const data = await response.json();
  const times = data.hourly?.time ?? [];
  if (times.length === 0) throw new Error('open-meteo: empty hourly data');

  const temps = data.hourly.temperature_2m ?? [];
  const probs = data.hourly.precipitation_probability ?? [];
  const codes = data.hourly.weather_code ?? [];
  const isDay = data.hourly.is_day ?? [];
  // 48 points (today + tomorrow) so the strip can run past midnight when the
  // remaining hours of today are fewer than the requested count.
  const hourly = times.map((time, i) => {
    const day = (isDay[i] ?? 1) === 1;
    const kind = weatherKind(codes[i] ?? 0, day);
    return {
      i,
      day: Number(String(time).slice(8, 10)),
      h: Number(String(time).slice(11, 13)),
      t: Math.round((temps[i] ?? 0) * 10) / 10,
      p: Number(probs[i] ?? 0) || 0,
      icon: kind.icon,
      text: kind.text,
    };
  });

  const nowHour = new Date().getHours();
  const nowIndex = Math.min(nowHour, hourly.length - 1);
  const current = hourly[nowIndex] ?? hourly[0];
  const todayPoints = hourly.slice(0, Math.min(24, hourly.length));
  const min = Math.min(...todayPoints.map((p) => p.t));
  const max = Math.max(...todayPoints.map((p) => p.t));
  const rainMax = Math.max(...todayPoints.map((p) => p.p));
  const rainText = rainMax >= 60 ? '有雨，带伞' : rainMax >= 30 ? '可能有雨' : '全天无雨';
  const gapText = max - min >= 10 ? '，昼夜温差大' : '';

  return {
    now: current.t,
    nowIcon: current.icon,
    nowText: current.text,
    min,
    max,
    rainMax,
    nowIndex,
    summary: `${min}–${max}℃，${rainText}${gapText}`,
    sunrise: String(data.daily?.sunrise?.[0] ?? '').slice(11, 16),
    sunset: String(data.daily?.sunset?.[0] ?? '').slice(11, 16),
    hourly,
  };
}

/** @type {{key:string,at:number,value:object}|null} */
let weatherCache = null;
/** @type {{key:string,at:number,message:string}|null} 上一次失败（冷却窗口从这里算起） */
let weatherFail = null;
/** @type {{key:string,promise:Promise<object>}|null} 单飞：并发请求共用同一次尝试 */
let weatherInflight = null;

/** 上一次成功取到的值（哪怕已过期）—— 失败时用它兜底，别再让页面空着。 */
const staleWeather = (key) => (weatherCache && weatherCache.key === key ? weatherCache.value : null);

/**
 * Cached weather so re-opening the page never waits on the network.
 *
 * 两层保护（2026-11-15 加）：天气服务不可达时，`/hud` 是整页首屏，
 * 不能让每个请求都等满一个超时（当时实测 6.02s/次，页面「一直很慢」）：
 *   1. 失败后进入 `WEATHER_FAIL_COOLDOWN_MS` 冷却 —— 期间直接返回上次的值/空，不再打网络；
 *   2. 并发请求单飞 —— N 个请求共用一次尝试，不会叠加成 N×超时。
 * @param {number} lat @param {number} lon
 * @returns {Promise<object|null>} weather
 */
export async function readWeather(lat, lon) {
  const key = `${lat},${lon}`;
  if (weatherCache && weatherCache.key === key && Date.now() - weatherCache.at < WEATHER_TTL_MS) {
    return weatherCache.value;
  }
  if (weatherFail && weatherFail.key === key && Date.now() - weatherFail.at < WEATHER_FAIL_COOLDOWN_MS) {
    return staleWeather(key);
  }
  if (weatherInflight && weatherInflight.key === key) return weatherInflight.promise;

  const attempt = (async () => {
    try {
      const value = await fetchWeather(lat, lon);
      weatherCache = { key, at: Date.now(), value };
      weatherFail = null;
      return value;
    } catch (error) {
      weatherFail = {
        key,
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  })();

  const entry = { key, promise: attempt };
  weatherInflight = entry;
  // 只清理自己这一轮：别把后来者的单飞记录抹掉，也别让这条链产生未处理的 rejection。
  attempt.then(() => {}, () => {}).then(() => { if (weatherInflight === entry) weatherInflight = null; });
  return attempt;
}

/** 诊断/测试用：看一眼当前天气状态（不触发网络）。 */
export function weatherStatus() {
  return {
    cached: weatherCache ? { key: weatherCache.key, at: weatherCache.at } : null,
    failed: weatherFail ? { key: weatherFail.key, at: weatherFail.at, message: weatherFail.message } : null,
    inflight: Boolean(weatherInflight),
    cooldownMs: WEATHER_FAIL_COOLDOWN_MS,
    timeoutMs: WEATHER_TIMEOUT_MS,
  };
}

/**
 * Session ids that still have a log directory under $DSH_HOME/sessions/<cwd>/<id>/.
 *
 * The projection cache outlives a deleted session, so filtering by cache alone
 * keeps showing sessions the user already deleted. A deleted session loses its
 * log directory — that is the reliable signal.
 * @param {string} dshHome DSH home
 * @returns {Set<string>|null} existing ids, or null when the root is unreadable
 */
function existingSessionIds(dshHome) {
  const root = join(dshHome, 'sessions');
  const ids = new Set();
  let scanned = false;
  try {
    for (const cwdDir of readdirSync(root)) {
      scanned = true;
      try {
        for (const id of readdirSync(join(root, cwdDir))) ids.add(id);
      } catch { /* unreadable project dir */ }
    }
  } catch {
    return null;
  }
  return scanned ? ids : null;
}

/**
 * Recent DSH sessions from the projection cache (no log decompression).
 * Deleted sessions are dropped: their log directory is gone even though the
 * cache file may linger.
 * @param {string} projDir @param {number} limit @param {string} dshHome
 * @returns {object[]} sessions
 */
function readSessions(projDir, limit, dshHome) {
  let files = [];
  try {
    files = readdirSync(projDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const alive = dshHome ? existingSessionIds(dshHome) : null;
  const out = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (alive && !alive.has(id)) continue; // session log gone → treat as deleted
    let record;
    try {
      record = JSON.parse(readFileSync(join(projDir, file), 'utf8'));
    } catch {
      continue;
    }
    const rows = record?.record?.rows ?? {};
    const title = rows.title?.val;
    const meta = rows.sessionListMetadata?.val;
    if (!title || typeof title !== 'string') continue;
    if (meta?.blank === true) continue;
    out.push({
      id,
      title,
      at: Number(meta?.lastPromptAt ?? 0),
      cwd: record?.record?.identity?.cwd ?? '',
      turns: Number(rows.sessionStats?.val?.turns ?? 0),
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}

/**
 * Assemble the HUD snapshot.
 * @param {object} [config] bundle row config
 * @param {object} [runtime] extra runtime hooks ({ isRunning })
 * @returns {Promise<object>} payload
 */
export async function buildHud(config = {}, runtime = {}) {
  const dataDir = String(config.dataDir ?? '') || join(homedir(), '.dsh', 'lifehud');
  const settings = readSettingsFile(dataDir);
  const nowtreeDb = String(config.nowtreeDb ?? '') || defaultNowtreeDb();
  const leveldbDir = String(config.leveldbDir ?? '') || defaultLeveldbDir();
  const dshHome = String(config.dshHome ?? join(homedir(), '.dsh'));
  const sessionLimit = Number(config.sessionLimit ?? 5);
  const lat = Number(settings.latitude ?? config.latitude ?? 39.9042);
  const lon = Number(settings.longitude ?? config.longitude ?? 116.4074);

  const discovered = readSlotBounds(leveldbDir);
  const bounds = discovered ?? DEFAULT_BOUNDS;
  const slot = slotForHour(new Date().getHours(), bounds);

  const warnings = [...captureWarnings];

  // 专注卡改读本地采集库（v1.1.1）：这里不再有 ActivityWatch 请求。
  // 采集库没建立 / 读库出错都只是「没有数据」，不能让整个 HUD 挂掉。
  const aliases = settings.appAliases ?? config.appAliases ?? {};
  const failActivity = (error) => {
    warnings.push(`activity: ${error instanceof Error ? error.message : String(error)}`);
    return emptyActivity();
  };

  const [activity, weather, sessions] = await Promise.all([
    // readOwnActivity 是同步的：包一层 Promise 才能和另外两路并发、也才能接住同步抛错。
    Promise.resolve().then(() => readOwnActivity(config, 84, aliases)).catch(failActivity),
    readWeather(lat, lon).catch((error) => {
      warnings.push(`weather: ${error instanceof Error ? error.message : String(error)}`);
      return weatherCache?.value ?? null;
    }),
    Promise.resolve(readSessions(join(dshHome, 'storages', 'session_projcache', 'sessions'), sessionLimit, dshHome)
      .map((s) => ({ ...s, running: runtime.isRunning ? runtime.isRunning(s.id) : false }))),
  ]);

  let tasks = [];
  try {
    tasks = readSlotTasks(nowtreeDb, slot);
  } catch (error) {
    warnings.push(`nowtree: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    // Host 侧版本（读自 plugin/package.json）。纯新增字段：页面用它显示「Host vX」，
    // 并和 client.js 的 BUILD 对比，提示「Host 升级了但页面资源还是旧的（Ctrl+R）」。
    version: PLUGIN_VERSION,
    clock: {
      hhmm: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      date: new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }),
      slot,
      label: SLOT_LABEL[slot] ?? slot,
      range: slotRange(slot, bounds),
      bounds,
      boundsSource: discovered ? 'nowtree' : 'default',
    },
    tasks: { slot, label: SLOT_LABEL[slot] ?? slot, range: slotRange(slot, bounds), items: tasks },
    weather,
    location: { latitude: lat, longitude: lon, name: settings.locationName ?? null },
    sessions,
    focus: activity.focus,
    heatmap: activity.heatmap,
    // 空闲强度（v1.1.2 起落库的第三条流）：页面暂未消费，留给 1.2 详情页。
    idle: activity.idle,
    // 采集器自己的状态（是否在跑 / 收到多少样本 / 最后一次错误），
    // 给页面诊断区用。只加字段，不改既有契约。
    capture: captureStatus(),
    // 天气这层自己的状态（是否有缓存 / 上次失败时间 / 超时与冷却的生效值）。
    // 存在的意义：`remove → install` 不保证重新求值 lib/*.js（见 AGENTS §6），
    // 而 `version` 从 package.json 读、不吃这个亏；于是「进程里跑的是哪一版 hud.js」
    // 只能靠这种新字段来判：字段在 = 新代码；字段没出来 = 还是旧的。
    weatherDiag: weatherStatus(),
    warnings,
  };
}
/** 位置变了 / 设置更新后让天气下次重新拉。 */
export function clearWeatherCache() { weatherCache = null; weatherFail = null; }
