/**
 * LifeHud — Host half.
 *
 * Endpoints (all loopback-only):
 *   GET    /lifehud/api/hud       → tasks(current slot) + weather + sessions + focus
 *   GET    /lifehud/api/weight    → weight series (last 7 measured days) + sync state
 *   GET    /lifehud/api/photo     → stored photo bytes
 *   POST   /lifehud/api/photo     → store base64 photo (≤2 MB)
 *   DELETE /lifehud/api/photo     → remove photo
 *   GET    /lifehud/api/settings  → persisted settings (location etc.)
 *   POST   /lifehud/api/settings  → merge settings
 *
 * Data sources are all read-only: NowTree's SQLite, NowTree's slot bounds in
 * WebView2 localStorage, DSH's session projection cache, ActivityWatch's local
 * REST API on 127.0.0.1:5600, and Xiaomi's cloud device-data endpoint (read
 * only; the only thing LifeHud writes back is its own SQLite mirror).
 *
 * @module dsh-lifehud
 */
import { DatabaseSync } from 'node:sqlite';
import {
  readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync, mkdirSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const API_PREFIX = '/lifehud/api';
const HUD_PATH = `${API_PREFIX}/hud`;
const WEIGHT_PATH = `${API_PREFIX}/weight`;
const PHOTO_PATH = `${API_PREFIX}/photo`;
const SETTINGS_PATH = `${API_PREFIX}/settings`;
const SESSION_EXISTS_PATH = `${API_PREFIX}/session-exists`;

/** Built-in friendly names for the apps ActivityWatch sees as `<name>.exe`. */
const DEFAULT_APP_ALIASES = {
  'explorer.exe': '文件资源管理器',
  msedge: 'Edge',
  chrome: 'Chrome',
  firefox: 'Firefox',
  wechat: '微信',
  weixin: '微信',
  qq: 'QQ',
  dingtalk: '钉钉',
  feishu: '飞书',
  wxwork: '企业微信',
  code: 'VS Code',
  'code.exe': 'VS Code',
  devenv: 'Visual Studio',
  windowsterminal: '终端',
  'windowsterminal.exe': '终端',
  powershell: 'PowerShell',
  'pwsh.exe': 'PowerShell',
  notepad: '记事本',
  'snippingtool.exe': '截图工具',
  'bilibili desktop': '哔哩哔哩',
  '哔哩哔哩.exe': '哔哩哔哩',
  nowtree: 'NowTree',
  'nowtree.exe': 'NowTree',
  'deepseek harness.exe': 'DeepSeek Harness',
  workbuddy: 'WorkBuddy',
  'workbuddy.exe': 'WorkBuddy',
};

/**
 * Turn an ActivityWatch `app` into something readable.
 *
 * AW reports the executable name (`Weixin.exe`, `msedge`), which is not how the
 * user thinks about their software. Resolution order: user aliases (config) →
 * built-in aliases → exe name with the extension stripped.
 * @param {string} raw raw app name from AW
 * @param {Record<string,string>} aliases user aliases
 * @returns {string} display name
 */
function appDisplayName(raw, aliases = {}) {
  const key = String(raw ?? '').trim();
  const lower = key.toLowerCase();
  const base = lower.replace(/\.exe$/i, '');
  const user = aliases[key] ?? aliases[lower] ?? aliases[base];
  if (user) return String(user);
  const builtin = DEFAULT_APP_ALIASES[key] ?? DEFAULT_APP_ALIASES[lower] ?? DEFAULT_APP_ALIASES[base];
  if (builtin) return builtin;
  return base;
}

const DEFAULT_BOUNDS = { morningStart: 6, noonStart: 13, eveningStart: 18 };
const SLOT_LABEL = { morning: '早', noon: '午', evening: '晚', rest: '休息' };
const WEATHER_TTL_MS = 10 * 60 * 1000;
const ACTIVITY_TTL_MS = 10 * 60 * 1000;
// 体重只在踩秤后变化，10 分钟一次足够；手动刷新会用 ?force=1 跳过这个 TTL。
const WEIGHT_TTL_MS = 10 * 60 * 1000;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** 小米云端点（细节见 docs/小米云取数.md）。设备号不再写死，见 resolveMiDid()。 */
const MI_BASE = 'https://api.io.mi.com/app';
const MI_DEVICE_DATA_PATH = '/user/get_user_device_data';
const MI_DEVICE_LIST_PATH = '/home/device_list';
/** 体脂秤在 device_list 里的 model 形如 `yoda.scales.mx80`。 */
const MI_SCALE_MODEL = /scales/i;
/** 「最近有数据的 N 个测量日」。 */
const WEIGHT_DAYS = 7;

/* ------------------------------------------------- 默认路径（不写死用户名） */

/**
 * LifeHud 不把任何人的绝对路径写进仓库：能推导的一律推导。
 * Windows 的 `%APPDATA%` / `%LOCALAPPDATA%` 已经指向 `C:\Users\<你>\AppData\…`。
 */
const envPath = (...parts) => {
  const root = parts.shift();
  return root ? join(root, ...parts) : '';
};

/** NowTree 的 SQLite（`%APPDATA%\com.nowtree.app\nowtree.sqlite`）。 */
const defaultNowtreeDb = () => envPath(process.env.APPDATA ?? '', 'com.nowtree.app', 'nowtree.sqlite');

/** NowTree 的 WebView2 localStorage（`%LOCALAPPDATA%\com.nowtree.app\EBWebView\…`）。 */
const defaultLeveldbDir = () => envPath(process.env.LOCALAPPDATA ?? '', 'com.nowtree.app',
  'EBWebView', 'Default', 'Local Storage', 'leveldb');

/** 小米云会话文件默认放 dataDir 里，不进仓库、不进 git。 */
const miSessionPath = (config) => String(config.miSession ?? '')
  || join(String(config.dataDir ?? join(homedir(), '.dsh', 'lifehud')), 'mi-session.json');

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** @param {import('node:http').IncomingMessage} req @returns {boolean} */
function isLocalPeer(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<string>} */
function readTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PHOTO_BYTES * 2) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
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

/**
 * Cached weather so re-opening the page never waits on the network.
 * @param {number} lat @param {number} lon
 * @returns {Promise<object>} weather
 */
async function readWeather(lat, lon) {
  const key = `${lat},${lon}`;
  if (weatherCache && weatherCache.key === key && Date.now() - weatherCache.at < WEATHER_TTL_MS) {
    return weatherCache.value;
  }
  const value = await fetchWeather(lat, lon);
  weatherCache = { key, at: Date.now(), value };
  return value;
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
 * ActivityWatch: today's app focus **and** an 84-day daily heatmap.
 *
 * One wide pull (≈15k events / 2.5 MB / ~1.2 s) is cheaper than two narrow ones,
 * so both cards share it and it is cached. AFK intervals are subtracted from
 * every window event — otherwise idle time (explorer.exe / "Program Manager")
 * dominates and every day looks like 20 productive hours.
 * @param {string} base aw-server base url
 * @param {number} days how many days of history to aggregate
 * @returns {Promise<{focus:object,heatmap:object[]}>} activity payload
 */
async function fetchActivity(base, aliases = {}, days = 84) {
  const buckets = await (await fetch(`${base}/api/0/buckets/`, { signal: AbortSignal.timeout(4000) })).json();
  const ids = Object.keys(buckets ?? {});
  const winId = ids.find((id) => id.startsWith('aw-watcher-window_'));
  const afkId = ids.find((id) => id.startsWith('aw-watcher-afk_'));
  if (!winId) throw new Error('ActivityWatch: no window bucket');

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rangeStart = new Date(dayStart.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 19);
  const q = `?start=${iso(rangeStart)}&end=${iso(now)}&limit=200000`;

  const winEvents = await (await fetch(`${base}/api/0/buckets/${encodeURIComponent(winId)}/events${q}`, {
    signal: AbortSignal.timeout(15000),
  })).json();

  /** AFK intervals in epoch ms. */
  const afkSpans = [];
  if (afkId) {
    try {
      const afkEvents = await (await fetch(`${base}/api/0/buckets/${encodeURIComponent(afkId)}/events${q}`, {
        signal: AbortSignal.timeout(8000),
      })).json();
      for (const ev of Array.isArray(afkEvents) ? afkEvents : []) {
        if (String(ev.data?.status) !== 'afk') continue;
        const s = Date.parse(ev.timestamp);
        if (!Number.isFinite(s)) continue;
        afkSpans.push([s, s + (Number(ev.duration) || 0) * 1000]);
      }
    } catch { /* AFK optional */ }
  }

  /**
   * Seconds of [startMs, endMs) not covered by AFK.
   * @param {number} startMs @param {number} endMs @returns {number} active seconds
   */
  const activeOverlap = (startMs, endMs) => {
    let idle = 0;
    for (const [as, ae] of afkSpans) {
      const lo = Math.max(startMs, as);
      const hi = Math.min(endMs, ae);
      if (hi > lo) idle += hi - lo;
    }
    return Math.max(0, (endMs - startMs) / 1000 - idle / 1000);
  };

  /** Local date key `YYYY-MM-DD`. */
  const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const perDay = new Map();
  const recentByApp = new Map();
  let recentSeconds = 0;
  let longest = { app: '', title: '', seconds: 0 };
  const todayKey = dayKey(now.getTime());
  // The focus card shows a ROLLING 24 h window: "today" alone makes every evening
  // look empty because the morning has scrolled out of the day.
  const since24 = now.getTime() - 24 * 3600 * 1000;

  for (const ev of Array.isArray(winEvents) ? winEvents : []) {
    const startMs = Date.parse(ev.timestamp);
    const duration = Number(ev.duration) || 0;
    if (!Number.isFinite(startMs) || duration <= 0) continue;
    const seconds = afkSpans.length > 0
      ? activeOverlap(startMs, startMs + duration * 1000)
      : duration;
    if (seconds < 1) continue;

    // Lock screen / desktop focus reports as explorer.exe + "Program Manager" and is
    // not real work. AFK alone does not catch it (the watcher can be paused or the
    // machine locked rather than idle), so drop the obvious idle bucket.
    const appName = String(ev.data?.app ?? '未知');
    const titleName = String(ev.data?.title ?? '');
    if (/^explorer\.exe$/i.test(appName) && /program manager/i.test(titleName)) continue;

    perDay.set(dayKey(startMs), (perDay.get(dayKey(startMs)) ?? 0) + seconds);

    const endMs = startMs + duration * 1000;
    if (endMs < since24) continue;
    // Clip the part that falls inside the window.
    const inside = Math.max(0, (Math.min(endMs, now.getTime()) - Math.max(startMs, since24)) / 1000);
    if (inside < 1) continue;
    const app = appName;
    recentSeconds += inside;
    recentByApp.set(app, (recentByApp.get(app) ?? 0) + inside);
    if (inside > longest.seconds) {
      longest = { app, title: titleName, seconds: inside };
    }
  }

  const heatmap = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(dayStart.getTime() - i * 86400000);
    heatmap.push({ d: key, m: Math.round((perDay.get(key) ?? 0) / 60) });
  }

  const top = [...recentByApp.entries()]
    .map(([app, seconds]) => ({ app: appDisplayName(app, aliases), minutes: Math.round(seconds / 6) / 10 }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 6);

  return {
    focus: {
      available: true,
      window: '24h',
      trackingMinutes: Math.round(recentSeconds / 6) / 10,
      top,
      longest: {
        app: longest.app,
        title: longest.title,
        minutes: Math.round(longest.seconds / 6) / 10,
      },
    },
    heatmap,
  };
}

/** @type {{at:number,value:{focus:object,heatmap:object[]}}|null} */
let activityCache = null;

/**
 * Cached ActivityWatch payload (10 min).
 * @param {string} base @returns {Promise<{focus:object,heatmap:object[]}>} activity
 */
async function readActivity(base, aliases = {}) {
  if (activityCache && Date.now() - activityCache.at < ACTIVITY_TTL_MS) return activityCache.value;
  const value = await fetchActivity(base, aliases);
  activityCache = { at: Date.now(), value };
  return value;
}

/* ---------------------------------------------------------- 体重（小米云） */

/**
 * 小米云失败原因分类。前端只按 `reason` 决定提示文案，不看 message：
 *   'session-expired' → 会话过期，请重新登录（红字）
 *   'network'         → 连不上小米云（弱提示）
 *   'cloud'           → 云返回业务错误 / 响应读不懂
 *   'local'           → 本地 SQLite 读写失败
 */
class MiCloudError extends Error {
  /** @param {string} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.name = 'MiCloudError';
    this.reason = reason;
  }
}

/**
 * RC4（纯 JS）。
 *
 * 不能用 `crypto.createCipheriv('rc4', …)`：Node 24 的 OpenSSL 3 默认不加载
 * legacy provider，实测抛 `digital envelope routines::unsupported`。RC4 的
 * 状态机只有十几行，自己写比折腾 provider 稳，也符合「零依赖」。
 * 注意与 pycryptodome 对齐：**先吃掉 1024 字节密钥流**，再处理正文。
 * @param {Buffer} key @returns {{S:Uint8Array,i:number,j:number}} state
 */
function rc4Init(key) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  return { S, i: 0, j: 0 };
}

/** @param {object} state @param {Uint8Array} data @returns {Buffer} */
function rc4Apply(state, data) {
  const { S } = state;
  let i = state.i;
  let j = state.j;
  const out = Buffer.alloc(data.length);
  for (let n = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
    out[n] = data[n] ^ S[(S[i] + S[j]) & 0xff];
  }
  state.i = i;
  state.j = j;
  return out;
}

/** @param {string} passwordB64 @param {Uint8Array} payload @returns {Buffer} */
function rc4Cipher(passwordB64, payload) {
  const state = rc4Init(Buffer.from(passwordB64, 'base64'));
  rc4Apply(state, Buffer.alloc(1024)); // 丢弃前 1024 字节密钥流（micloud 同款）
  return rc4Apply(state, payload);
}

const miEncrypt = (passwordB64, text) => rc4Cipher(passwordB64, Buffer.from(text, 'utf8')).toString('base64');
const miDecrypt = (passwordB64, textB64) => rc4Cipher(passwordB64, Buffer.from(textB64, 'base64'));

/**
 * `gen_nonce`：8 字节随机 + 当前分钟数（大端最短字节）→ base64。
 * @returns {string} nonce
 */
function miNonce() {
  const random = randomBytes(8);
  let hex = BigInt(Math.floor(Date.now() / 60000)).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.concat([random, Buffer.from(hex, 'hex')]).toString('base64');
}

/**
 * `signed_nonce` = sha256(ssecurity ‖ nonce)，即 RC4 的密钥来源。
 * @param {string} ssecurity @param {string} nonce @returns {string} signed nonce
 */
function miSignedNonce(ssecurity, nonce) {
  return createHash('sha256')
    .update(Buffer.from(ssecurity, 'base64'))
    .update(Buffer.from(nonce, 'base64'))
    .digest('base64');
}

/**
 * `gen_enc_signature`：sha1(方法&路径&k=v…&signed_nonce) → base64。
 * @param {string} url @param {string} method @param {string} signedNonce
 * @param {Record<string,string>} params @returns {string} signature
 */
function miSignature(url, method, signedNonce, params) {
  const parts = [String(method).toUpperCase(), url.split('com')[1].replace('/app/', '/')];
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`);
  parts.push(signedNonce);
  return createHash('sha1').update(parts.join('&'), 'utf8').digest('base64');
}

/**
 * `generate_enc_params`：先签 rc4_hash__，再把所有值 RC4 加密，最后整体再签一次。
 * @param {string} url @param {string} method @param {string} signedNonce
 * @param {string} nonce @param {Record<string,string>} params @param {string} ssecurity
 * @returns {Record<string,string>} form body
 */
function miEncParams(url, method, signedNonce, nonce, params, ssecurity) {
  params.rc4_hash__ = miSignature(url, method, signedNonce, params);
  for (const k of Object.keys(params)) params[k] = miEncrypt(signedNonce, String(params[k]));
  params.signature = miSignature(url, method, signedNonce, params);
  params.ssecurity = ssecurity;
  params._nonce = nonce;
  return params;
}

/** 随机 UA 尾巴，装作米家 Android 客户端（与 cloud_probe.py 同款）。 */
const miAgent = () => Array.from({ length: 13 }, () => 'ABCDEF'[Math.floor(Math.random() * 6)]).join('');
const miDeviceId = () => Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

/**
 * 读会话文件（只读，绝不写回、绝不打印）。
 * @param {string} path @returns {{userId:string,serviceToken:string,ssecurity:string}} session
 */
function readMiSession(path) {
  if (!path) throw new MiCloudError('session-expired', '未配置 miSession');
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new MiCloudError('session-expired', `会话文件读不到：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const key of ['userId', 'serviceToken', 'ssecurity']) {
    if (!raw?.[key]) throw new MiCloudError('session-expired', `会话文件缺字段 ${key}`);
  }
  return {
    userId: String(raw.userId),
    serviceToken: String(raw.serviceToken),
    ssecurity: String(raw.ssecurity),
  };
}

/**
 * `POST /app/user/get_user_device_data`。响应可能是明文 JSON，也可能是 RC4 密文。
 * @param {object} session @param {object} data request body
 * @param {string} [path] 小米云路径，默认取称重记录端点
 * @returns {Promise<object>} parsed payload
 */
async function miDeviceData(session, data, path = MI_DEVICE_DATA_PATH) {
  const url = MI_BASE + path;
  const nonce = miNonce();
  const ssecurity = session.ssecurity;
  const signedNonce = miSignedNonce(ssecurity, nonce);
  const body = miEncParams(url, 'POST', signedNonce, nonce, { data: JSON.stringify(data) }, ssecurity);

  const cookies = {
    sdkVersion: '3.8.6',
    deviceId: miDeviceId(),
    userId: session.userId,
    yetAnotherServiceToken: session.serviceToken,
    serviceToken: session.serviceToken,
    locale: 'zh_CN',
    timezone: 'GMT+08:00',
    is_daylight: '0',
    dst_offset: '0',
    channel: 'MI_APP_STORE',
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${miAgent()} APP/com.xiaomi.mihome APPV/10.5.201`,
        'Accept-Encoding': 'identity',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'content-type': 'application/x-www-form-urlencoded',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        accept: '*/*',
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new MiCloudError('network', `小米云连接失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new MiCloudError('session-expired', `小米云 HTTP ${response.status}`);
  }
  if (!response.ok) throw new MiCloudError('cloud', `小米云 HTTP ${response.status}`);

  let text;
  try {
    text = (await response.text()).trim();
  } catch (error) {
    throw new MiCloudError('network', `小米云响应读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
    return JSON.parse(miDecrypt(signedNonce, text).toString('utf8'));
  } catch (error) {
    throw new MiCloudError('cloud', `小米云响应无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 本地日期 `YYYY-MM-DD`（按本机时区）。 */
function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 一条云端记录 → 本地表的一行。ID 一律按文本处理：
 * 1786238280146 一旦变成 1786238280146.0 就没法当主键去重。
 * @param {object} row raw row from the cloud
 * @returns {object|null} normalized row, or null when unusable
 */
function toWeightRow(row) {
  let value = row?.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;

  const weightKg = Number(value.weight);
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;

  const measuredAt = String(value.createTime ?? '');
  let ts = Number(row?.time);
  if (!Number.isFinite(ts) || ts <= 0) {
    const fromId = Math.floor(Number(value.weightId) / 1000);
    const fromText = Date.parse(measuredAt.replace(' ', 'T'));
    ts = Number.isFinite(fromId) && fromId > 0 ? fromId : Math.floor(fromText / 1000);
  }
  if (!Number.isFinite(ts) || ts <= 0) return null;

  const date = /^\d{4}-\d{2}-\d{2}/.test(measuredAt) ? measuredAt.slice(0, 10) : localDateKey(ts * 1000);
  // weightId 可能是 JSON number（会被 JSON.parse 成浮点），转文本时去掉尾巴的 .0
  const weightId = String(value.weightId ?? row?.time ?? ts).replace(/\.0+$/, '');
  return {
    weightId,
    ts: Math.round(ts),
    date,
    weightKg: Math.round(weightKg * 100) / 100,
    measuredAt,
    raw: JSON.stringify(value),
  };
}

/**
 * 设备号：优先用配置里的 `miDid`；没配就自己去账号的设备列表里找体脂秤，
 * 找到后缓存在体重库的 meta 里。这样插件既不需要谁的设备号，也不需要谁改配置。
 * @param {object} config @param {object} session @returns {Promise<string>} did
 */
async function resolveMiDid(config, session) {
  const dbPath = weightDbPath(config);
  const cached = dbPath ? readMetaText(dbPath, 'miDid') : '';
  if (cached) return cached;

  const payload = await miDeviceData(session, { getVirtualModel: false, getHuamiDevices: 1 }, MI_DEVICE_LIST_PATH);
  const code = Number(payload?.code ?? 0);
  if (code !== 0) {
    const expired = code === 70016 || code === -1 || code === 401;
    throw new MiCloudError(expired ? 'session-expired' : 'cloud',
      `小米云设备列表 code=${code}${payload?.message ? ` ${payload.message}` : ''}`);
  }
  const list = Array.isArray(payload?.result?.list) ? payload.result.list : [];
  const scale = list.find((device) => device?.did && MI_SCALE_MODEL.test(String(device.model ?? '')));
  if (!scale) {
    throw new MiCloudError('config',
      `账号下找不到体脂秤（共 ${list.length} 台设备）；可以在配置里显式填 miDid`);
  }
  if (dbPath) writeMetaText(dbPath, 'miDid', String(scale.did));
  return String(scale.did);
}

/**
 * 从云端拉全部称重记录（只读）。
 * @param {object} config bundle row config
 * @returns {Promise<object[]>} normalized rows
 */
async function pullWeight(config) {
  const session = readMiSession(miSessionPath(config));
  const did = String(config.miDid ?? '') || await resolveMiDid(config, session);
  const now = Math.floor(Date.now() / 1000);
  const payload = await miDeviceData(session, {
    did,
    uid: session.userId,
    type: 'weight',
    key: 'bodyInfo',
    time_start: 0,
    time_end: now,
    group: 'raw',
    limit: 1000,
  });

  const code = Number(payload?.code ?? 0);
  if (code !== 0) {
    // 70016 = serviceToken 无效；-1 = 签名/参数被拒。都属于「会话要重新登录了」。
    const expired = code === 70016 || code === -1 || code === 401;
    throw new MiCloudError(expired ? 'session-expired' : 'cloud',
      `小米云 code=${code}${payload?.message ? ` ${payload.message}` : ''}`);
  }

  const rows = Array.isArray(payload.result) ? payload.result : [];
  return rows.map(toWeightRow).filter(Boolean);
}

/**
 * 打开（必要时建表）体重库。
 * @param {string} dbPath @returns {import('node:sqlite').DatabaseSync} db
 */
function openWeightDb(dbPath) {
  if (!dbPath) throw new MiCloudError('local', 'weightDb 未配置');
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS weight (
        weight_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        date TEXT NOT NULL,
        weight_kg REAL NOT NULL,
        measured_at TEXT,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_weight_ts ON weight (ts DESC);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    return db;
  } catch (error) {
    throw new MiCloudError('local', `体重库打不开：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 读一条 meta 值（体重库里的 key/value 表，存 lastSyncAt、自动发现的 miDid 等）。
 * @param {string} dbPath @param {string} key @returns {string} value，没有就返回空串
 */
function readMetaText(dbPath, key) {
  if (!dbPath) return '';
  const db = openWeightDb(dbPath);
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value == null ? '' : String(row.value);
  } catch {
    return '';
  } finally {
    db.close();
  }
}

/** @param {string} dbPath @param {string} key @param {string} value */
function writeMetaText(dbPath, key, value) {
  const db = openWeightDb(dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
  } finally {
    db.close();
  }
}

/**
 * 按 weight_id upsert，避免每 10 分钟重复插入同一批记录。 * @param {string} dbPath @param {object[]} rows @returns {number} rows written
 */
function saveWeightRows(dbPath, rows) {
  const db = openWeightDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO weight (weight_id, ts, date, weight_kg, measured_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(weight_id) DO UPDATE SET
        ts = excluded.ts,
        date = excluded.date,
        weight_kg = excluded.weight_kg,
        measured_at = excluded.measured_at,
        raw_json = excluded.raw_json
    `);
    const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        stmt.run(row.weightId, row.ts, row.date, row.weightKg, row.measuredAt, row.raw);
      }
      // 只有真的同步到记录才刷新 lastSyncAt：云回 0 条却把时间戳推到"刚刚"，
      // 就是在伪造新鲜度（卡片会显示「最后同步：刚刚」但曲线还是旧的）。
      if (rows.length > 0) meta.run('lastSyncAt', String(Date.now()));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  } catch (error) {
    if (error instanceof MiCloudError) throw error;
    throw new MiCloudError('local', `体重写库失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

/**
 * 本地库 → 曲线点。口径是「最近**有数据的** 7 个测量日」：
 * 同一天多称几次只留最后一次，日期可以不连续。
 * @param {string} dbPath @returns {{points:object[],lastSyncAt:number|null}} local snapshot
 */
function readWeightLocal(dbPath) {
  const db = openWeightDb(dbPath);
  try {
    const rows = db.prepare('SELECT date, ts, weight_kg FROM weight ORDER BY ts DESC LIMIT 2000').all();
    const points = [];
    const seen = new Set();
    for (const row of rows) {
      const date = String(row.date ?? '');
      if (!date || seen.has(date)) continue;
      seen.add(date);
      points.push({ date, weight_kg: Number(row.weight_kg) });
      if (points.length >= WEIGHT_DAYS) break;
    }
    points.reverse(); // 升序：左旧右新
    const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('lastSyncAt');
    const lastSyncAt = Number(meta?.value);
    return { points, lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? lastSyncAt : null };
  } catch (error) {
    if (error instanceof MiCloudError) throw error;
    throw new MiCloudError('local', `体重读库失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

/** @param {object} config @returns {string} db path */
function weightDbPath(config) {
  const explicit = String(config.weightDb ?? '');
  if (explicit) return explicit;
  const dataDir = String(config.dataDir ?? '');
  return dataDir ? join(dataDir, 'lifehud-weight.db') : '';
}

/** @type {{at:number,dbPath:string,value:object}|null} */
let weightCache = null;
/**
 * 在飞的请求按库路径分键。
 * 只用一个变量会让「不同 weightDb 的并发调用」共享第一个库的结果（串数据），
 * 虽然当前只有一个配置，但代价只有一行，没必要留个坑。
 * @type {Map<string,Promise<object>>}
 */
const weightInflight = new Map();

/**
 * 体重快照：云可达就顺手落库，不可达就降级成「本地缓存 + stale」。
 *
 * TTL 语义（容易被误解，写清楚）：不是「永远用缓存」，而是「10 分钟内复用、
 * 超时就重新打云」。只有云不可达时才会一直停在旧值，此时 stale=true，
 * 前端据此显示「最后同步：X 小时前」，绝不静默假装最新。
 * @param {object} [config] bundle row config
 * @param {{force?:boolean}} [options] force 跳过 TTL（手动刷新用）
 * @returns {Promise<object>} snapshot
 */
export async function readWeight(config = {}, options = {}) {
  const dbPath = weightDbPath(config);
  const ttl = Math.max(60000, Number(config.weightTtlMs ?? WEIGHT_TTL_MS));
  if (!options.force && weightCache && weightCache.dbPath === dbPath && Date.now() - weightCache.at < ttl) {
    return weightCache.value;
  }
  if (weightInflight.has(dbPath)) return weightInflight.get(dbPath);

  const run = (async () => {
    try {
      const rows = await pullWeight(config);
      saveWeightRows(dbPath, rows);
      const local = readWeightLocal(dbPath);
      // 云回 0 条、本地却有历史 —— 两者矛盾（或接口悄悄变了）。
      // 这时不能把 lastSyncAt 当成「刚刚」，否则就是在伪装新鲜度。
      if (rows.length === 0 && local.points.length > 0) {
        return {
          ok: true,
          stale: true,
          reason: 'cloud',
          lastSyncAt: local.lastSyncAt,
          points: local.points,
          archived: 0,
          error: '小米云返回 0 条记录，但本地已有历史数据',
        };
      }
      return {
        ok: true,
        stale: false,
        reason: null,
        // lastSyncAt 由 saveWeightRows 写进 meta（只在真同步到记录时才更新），
        // 这里读回来，避免「0 条也把时间戳推到刚刚」。
        lastSyncAt: local.lastSyncAt,
        points: local.points,
        archived: rows.length,
      };
    } catch (error) {
      const reason = error instanceof MiCloudError ? error.reason : 'cloud';
      let local = { points: [], lastSyncAt: null };
      try {
        local = readWeightLocal(dbPath);
      } catch { /* 本地库也没有 → 空数组，前端显示占位文案 */ }
      return {
        ok: true,
        stale: true,
        reason,
        lastSyncAt: local.lastSyncAt,
        points: local.points,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  const tracked = run
    .then((value) => value, () => null)
    .finally(() => { weightInflight.delete(dbPath); });
  weightInflight.set(dbPath, tracked);
  const snapshot = await run;
  weightCache = { at: Date.now(), dbPath, value: snapshot };
  return snapshot;
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
  const awBase = String(config.activityWatchUrl ?? 'http://127.0.0.1:5600');
  const lat = Number(settings.latitude ?? config.latitude ?? 39.9042);
  const lon = Number(settings.longitude ?? config.longitude ?? 116.4074);

  const discovered = readSlotBounds(leveldbDir);
  const bounds = discovered ?? DEFAULT_BOUNDS;
  const slot = slotForHour(new Date().getHours(), bounds);

  const warnings = [];

  const failActivity = (error) => {
    warnings.push(`activity: ${error instanceof Error ? error.message : String(error)}`);
    return activityCache?.value ?? { focus: { available: false }, heatmap: [] };
  };

  const [activity, weather, sessions] = await Promise.all([
    readActivity(awBase, settings.appAliases ?? config.appAliases ?? {}).catch(failActivity),
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
    warnings,
  };
}

/** @type {string} */
let settingsDir = '';

/** @param {string} dir @returns {object} settings */
function readSettingsFile(dir) {
  if (!dir) return {};
  try {
    return JSON.parse(readFileSync(join(dir, 'lifehud-settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** @param {string} dir @param {object} patch @returns {object} merged */
function mergeSettingsFile(dir, patch) {
  const current = readSettingsFile(dir);
  const merged = { ...current, ...patch };
  writeFileSync(join(dir, 'lifehud-settings.json'), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Host plugin body.
 *
 * 外面包一层 try/catch：这个版本的 DSH 把"插件导入/激活失败"当成启动致命错误，
 * 一个插件抛错会让整个 app 起不来。宁可少一个面板，也不能拖垮启动。
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} [config] bundle row config
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  try {
    applyInner(ctx, config);
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[lifehud] activation failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    } catch { /* logging must not fail activation */ }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} config bundle row config
 * @returns {void}
 */
function applyInner(ctx, config) {
  const dataDir = String(config.dataDir ?? join(homedir(), '.dsh', 'lifehud'));
  settingsDir = dataDir;
  mkdirSync(dataDir, { recursive: true });
  const photoPath = join(dataDir, 'lifehud-photo.bin');
  const photoMetaPath = join(dataDir, 'lifehud-photo.json');

  const isRunning = (sessionId) => {
    try {
      const agents = ctx.get?.('agents');
      const agent = agents?.get?.(sessionId);
      return agent?.status === 'running';
    } catch {
      return false;
    }
  };

  // Warm the weather cache at Host start so the first page open is instant.
  void buildHud(config, { isRunning }).catch(() => {});
  // 体重同理：先把本地库读出来（云慢/断网也不耽误首屏），顺带打一次云做兜底。
  const weightConfig = { ...config, dataDir };
  void readWeight(weightConfig).catch(() => {});

  // 兜底轮询：页面没人看也每 10 分钟同步一次，这样「踩秤 → 打开页面」通常已经是新的。
  // 这里用 force，是真正的定时拉云；TTL 缓存只服务页面请求，不参与这个节奏。
  try {
    ctx.effect(() => {
      const period = Math.max(60000, Number(config.weightTtlMs ?? WEIGHT_TTL_MS));
      const timer = setInterval(() => { void readWeight(weightConfig, { force: true }).catch(() => {}); }, period);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, 'lifehud: weight sync');
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[lifehud] weight sync timer not registered: ${error instanceof Error ? error.message : String(error)}`);
    } catch { /* logging must not fail activation */ }
  }

  ctx.inject(['webServer'], (web) => {
    web.effect(() => {
      const photoHandler = async (req, res) => {
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        if (req.method === 'GET') {
          if (!existsSync(photoPath) || !existsSync(photoMetaPath)) {
            sendJson(res, 404, { ok: false, error: 'no photo' });
            return;
          }
          let type = 'image/jpeg';
          try {
            type = String(JSON.parse(readFileSync(photoMetaPath, 'utf8')).type ?? 'image/jpeg');
          } catch { /* jpeg */ }
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          res.end(readFileSync(photoPath));
          return;
        }
        if (req.method === 'DELETE') {
          try { unlinkSync(photoPath); } catch { /* gone */ }
          try { unlinkSync(photoMetaPath); } catch { /* gone */ }
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST') {
          try {
            const text = await readTextBody(req);
            const parsed = JSON.parse(text);
            const data = String(parsed?.data ?? '');
            const match = data.match(/^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/);
            if (!match) throw new Error('expected data:image/(png|jpeg|webp);base64,…');
            const bytes = Buffer.from(match[2], 'base64');
            if (bytes.length > MAX_PHOTO_BYTES) throw new Error('photo too large (4 MB max)');
            writeFileSync(photoPath, bytes);
            writeFileSync(photoMetaPath, JSON.stringify({ type: match[1] }));
            sendJson(res, 200, { ok: true, bytes: bytes.length });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: 'GET/POST/DELETE only' });
      };

      const settingsHandler = async (req, res) => {
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, settings: readSettingsFile(dataDir) });
          return;
        }
        if (req.method === 'POST') {
          try {
            const parsed = JSON.parse(await readTextBody(req));
            const merged = mergeSettingsFile(dataDir, parsed?.settings ?? parsed ?? {});
            // Location changed → drop the weather cache so the next read refetches.
            weatherCache = null;
            sendJson(res, 200, { ok: true, settings: merged });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: 'GET/POST only' });
      };

      const hudHandler = (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'GET required' });
          return;
        }
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        buildHud(config, { isRunning })
          .then((payload) => sendJson(res, 200, payload))
          .catch((error) => sendJson(res, 500, {
            ok: false,
            error: 'hud build failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
      };

      const weightHandler = (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'GET required' });
          return;
        }
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        let force = false;
        try {
          force = new URL(String(req.url ?? ''), 'http://127.0.0.1').searchParams.get('force') === '1';
        } catch { /* 非法 URL 就当普通请求 */ }
        readWeight(weightConfig, { force })
          .then((snapshot) => sendJson(res, 200, snapshot))
          .catch((error) => sendJson(res, 500, {
            ok: false,
            error: 'weight read failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
      };

      const d1 = web.webServer.register({ kind: 'exact', path: HUD_PATH, handler: hudHandler });
      const d2 = web.webServer.register({ kind: 'exact', path: PHOTO_PATH, handler: photoHandler });
      const d3 = web.webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: settingsHandler });
      const d5 = web.webServer.register({ kind: 'exact', path: WEIGHT_PATH, handler: weightHandler });

      // Cheap existence check so the page can refuse to navigate to a session whose
      // projection cache is gone (deleted session) instead of failing silently.
      const d4 = web.webServer.register({
        kind: 'exact',
        path: SESSION_EXISTS_PATH,
        handler: (req, res) => {
          if (!isLocalPeer(req)) {
            sendJson(res, 403, { ok: false, error: 'local access only' });
            return;
          }
          let id = '';
          try {
            id = new URL(String(req.url ?? ''), 'http://127.0.0.1').searchParams.get('id') ?? '';
          } catch { /* ignore */ }
          if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) {
            sendJson(res, 400, { ok: false, error: 'bad id' });
            return;
          }
          const projDir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
          const cacheFile = join(projDir, `${id}.json`);
          // A deleted session loses its log directory under $DSH_HOME/sessions/<cwd>/<id>/,
          // but its projection cache can survive. Treat "no log dir" as gone.
          let hasLogDir = false;
          const root = join(homedir(), '.dsh', 'sessions');
          try {
            for (const name of readdirSync(root)) {
              try {
                if (existsSync(join(root, name, id))) {
                  hasLogDir = true;
                  break;
                }
              } catch { /* unreadable subdir */ }
            }
          } catch { /* no sessions root */ }
          sendJson(res, 200, {
            ok: true,
            exists: hasLogDir || existsSync(cacheFile),
            hasLogDir,
            hasCache: existsSync(cacheFile),
          });
        },
      });

      return () => {
        try { d1(); } catch { /* disposed */ }
        try { d2(); } catch { /* disposed */ }
        try { d3(); } catch { /* disposed */ }
        try { d4(); } catch { /* disposed */ }
        try { d5(); } catch { /* disposed */ }
      };
    }, 'lifehud: http routes');
  });
}
