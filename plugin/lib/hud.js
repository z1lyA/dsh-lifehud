/**
 * HUD 快照：NowTree 任务/时段、天气、DSH 会话，组装成 /hud 的 payload。
 * 从 plugin/index.js 拆出（v1.1.2 评审 S3）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOwnActivity, emptyActivity } from './activity.js';
import { captureStatus, captureWarnings } from './capture.js';
import { countInboxTasks } from './inbox.js';
import { readSettingsFile } from './settings.js';
import { pluginVersion } from './update.js';
import { envPath } from './util.js';
import { createWeatherSource } from './weather.js';

const DEFAULT_BOUNDS = { morningStart: 6, noonStart: 13, eveningStart: 18 };
const SLOT_LABEL = { morning: '早', noon: '午', evening: '晚', rest: '休息' };

/** NowTree 的 SQLite（`%APPDATA%\com.nowtree.app\nowtree.sqlite`）。 */
const defaultNowtreeDb = () => envPath(process.env.APPDATA ?? '', 'com.nowtree.app', 'nowtree.sqlite');

/**
 * NowTree 的库路径：读（当前时段任务）和写（收件箱录入）必须用同一个口径。
 * 写成函数导出，是为了让 `index.js` 的收件箱路由不必自己再推导一遍。
 * @param {object} [config] bundle row config
 * @returns {string} path
 */
export function nowtreeDbPath(config = {}) {
  return String(config.nowtreeDb ?? '') || defaultNowtreeDb();
}

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

/**
 * 让「当前小时」跟着真实时间走。
 *
 * 缓存的（以及落盘的那份）是**整个 payload**，里面的 `nowIndex`/`now`/`nowText` 是
 * **取数那一刻**算好的。直接拿去渲染，断线几小时后卡片就会冻在取数时的小时上——
 * 2026-11-18 真机踩到：13:22 卡片还停在 09:00 的 22.4℃。
 * 这里按「今天 + 当前小时」重新定位当前点；越界就退到最接近的一个。
 * （取数本身在 `lib/weather.js`；这一步只属于"渲染前把时间对上"，所以留在组装层。）
 * @param {object|null} weather @returns {object|null}
 */
function refreshCurrentHour(weather) {
  const hourly = Array.isArray(weather?.hourly) ? weather.hourly : [];
  if (hourly.length === 0) return weather;
  const now = new Date();
  const day = now.getDate();
  const hour = now.getHours();
  let idx = hourly.findIndex((p) => p.day === day && p.h === hour);
  if (idx < 0) idx = hourly.findIndex((p) => p.day === day && p.h > hour);
  if (idx < 0) idx = Math.min(hour, hourly.length - 1);
  const current = hourly[idx];
  if (!current) return weather;
  return { ...weather, nowIndex: idx, now: current.t, nowText: current.text, nowIcon: current.icon };
}

/**
 * 天气通道的落盘位置（`<dataDir>/weather-cache.json`）。
 *
 * 为什么必须落盘：内存缓存一重启就没了。天气链路断的时候，重启后的进程既没有新数据、
 * 也没有旧数据可兜底，卡片只能干说「取不到」——用户看到的就是「重启之后半天没天气」。
 * 落盘之后，重启也能立刻显示上次的天气 + 它的时间。
 */
let weatherStorePath = '';
/** @type {ReturnType<typeof createWeatherSource>|null} 进程内唯一的天气通道 */
let weatherSource = null;

/** 拿到天气通道（顺手同步落盘位置；缓存/失败都带 key，换坐标不会串味）。 */
function weatherChannel() {
  if (!weatherSource) weatherSource = createWeatherSource({ storePath: weatherStorePath });
  else weatherSource.setStore(weatherStorePath);
  return weatherSource;
}

/**
 * 取一次天气。`mode` 的全部语义都在 `lib/weather.js`：
 *   - `cached`（默认）：10 分钟内复用；失败后 2 分钟冷却（冷却期给旧值/空）；
 *     失败的尝试会在 25 秒后**后台补一次**（不在首屏路径上）；
 *   - `refresh`：用户点「刷新」——跳过 TTL 与冷却，老老实实打一次；
 *   - `retry`：后台补拉——同样强制，但失败后不再排下一次（断网时不变成轮询）。
 * @param {number} lat @param {number} lon
 * @param {'cached'|'refresh'|'retry'|{mode?:string,force?:boolean}} [mode]
 * @returns {Promise<object|null>} weather
 */
export function readWeather(lat, lon, mode) {
  return weatherChannel().read(lat, lon, mode);
}

/** 诊断/测试用：看一眼当前天气状态（不触发网络）。字段名是既有契约（`weatherDiag`），别改名。 */
export function weatherStatus() {
  return weatherChannel().peek();
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
 * @param {{mode?:'cached'|'refresh'|'retry'}} [options] 天气取数模式（页面「刷新」传 `refresh`）
 * @returns {Promise<object>} payload
 */
export async function buildHud(config = {}, runtime = {}, options = {}) {
  const dataDir = String(config.dataDir ?? '') || join(homedir(), '.dsh', 'lifehud');
  const settings = readSettingsFile(dataDir);
  // 天气落盘位置（重启后靠它显示「上次的数据」）；每次 buildHud 赋值，配置变了也能跟上。
  weatherStorePath = join(dataDir, 'weather-cache.json');
  const nowtreeDb = nowtreeDbPath(config);
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
    readWeather(lat, lon, { mode: options.mode }).catch((error) => {
      warnings.push(`weather: ${error instanceof Error ? error.message : String(error)}`);
      return weatherCache?.value ?? null;
    }),
    Promise.resolve(readSessions(join(dshHome, 'storages', 'session_projcache', 'sessions'), sessionLimit, dshHome)
      .map((s) => ({ ...s, running: runtime.isRunning ? runtime.isRunning(s.id) : false }))),
  ]);

  let tasks = [];
  // 收件箱计数（v1.1.8）：任务卡右上角刚记完一条，卡片底部要能立刻看到「收件箱 N 条」——
  // inbox 记录没有 time_slot，不会出现在「当前时段」列表里，没有这行就等于什么都没发生。
  // 读不到（库被锁/结构不对）就是 null，页面不显示这行，绝不让它影响 /hud。
  let inboxCount = null;
  try {
    tasks = readSlotTasks(nowtreeDb, slot);
    inboxCount = countInboxTasks(nowtreeDb);
  } catch (error) {
    warnings.push(`nowtree: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    // Host 侧版本（读自 plugin/package.json）。纯新增字段：页面用它显示「Host vX」，
    // 并和 client.js 的 BUILD 对比，提示「Host 升级了但页面资源还是旧的（Ctrl+R）」。
    version: pluginVersion(),
    clock: {
      hhmm: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      date: new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }),
      slot,
      label: SLOT_LABEL[slot] ?? slot,
      range: slotRange(slot, bounds),
      bounds,
      boundsSource: discovered ? 'nowtree' : 'default',
    },
    tasks: { slot, label: SLOT_LABEL[slot] ?? slot, range: slotRange(slot, bounds), items: tasks, inboxCount },
    // 当前小时按请求时刻重算：缓存/落盘的数据可能已经放了几小时，别把「现在」冻在取数那一刻。
    weather: refreshCurrentHour(weather),
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
/** 位置变了 / 设置更新后让天气下次重新拉（顺带取消旧坐标的补拉待办）。 */
export function clearWeatherCache() {
  weatherChannel().clear();
}
