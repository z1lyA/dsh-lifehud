/**
 * 天气取数通道（v1.1.10 从 `hud.js` 抽出来）。
 *
 * 抽出来的原因：原来 `readWeather()` 一个函数兼了六件事——TTL 复用、失败冷却、并发单飞、
 * 失败后补拉、落盘兜底、强制刷新。六个状态都挂在 `hud.js` 的模块级变量上，于是
 * 「天气」被改一次就要动 HUD 的文件，探针还得靠 `setWeatherRetryDelayForTest()` 去改
 * 模块级常量才能测 25 秒的补拉。现在这些都收进一个按需创建的小对象：
 *
 *     const src = createWeatherSource({ storePath });
 *     await src.read(lat, lon);                    // 正常取数（吃 TTL / 冷却）
 *     await src.read(lat, lon, 'refresh');         // 用户点「刷新」：跳过 TTL 与冷却
 *     await src.read(lat, lon, 'retry');           // 失败后的后台补拉：同样强制，但不再排下一次
 *     src.peek();   src.clear();   src.setStore(p);
 *
 * `mode` 是一个枚举（`cached` / `refresh` / `retry`），取代原来的 `{force, scheduleRetry}`
 * 两个并排布尔——路由、`buildHud`、客户端说的都是同一个词。
 *
 * 时间与网络都可以注入（`now` / `fetchImpl` / `setTimeout`），所以探针能毫秒级验完
 * 补拉与冷却，不必去改模块级状态。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 成功取到一次就复用这么久，避免开页面就打一次天气 API。 */
export const WEATHER_TTL_MS = 10 * 60 * 1000;
/**
 * 单次取天气的超时。
 *
 * 实测同一条链路的耗时分布很不均匀：0.27 / 0.33 / 0.48 / **2.04 / 2.75** 秒
 * ——大多数很快，但有一条长尾。3 秒只比长尾多 0.25 秒，等于把及格线贴着最差成绩画，
 * 线路稍慢就把本来能成的请求判成超时（2026-11-17 真机上半天看不到天气，部分是这个原因）。
 * 5 秒给长尾留 2 秒余量；因为下面还有失败冷却，页面不会退回「每次刷新都卡满超时」。
 * 别调大：`/hud` 是整页首屏的入口，天气卡等多久，其它卡就跟着等多久。
 */
export const WEATHER_TIMEOUT_MS = 5000;
/**
 * 失败后的冷却窗口：这段时间里 `/hud` **不再**去试探天气，直接给上次的值（或空）。
 * 没有它的话，天气一路不通 = 每次刷新都白等一个完整超时，页面会「一直很慢」。
 */
export const WEATHER_FAIL_COOLDOWN_MS = 2 * 60 * 1000;
/**
 * 失败后的**一次性**后台补拉延迟。
 *
 * 机器睡醒 / DSH 刚重启时，进程里第一次外网连接常常是冷的（DNS、TLS 会话、代理隧道现建），
 * 5 秒超时刚好把它切断。2026-11-20 实测：同一分钟 PowerShell 0.4–2.2s、独立 node 0.3–1.9s
 * 都能取到，只有 Host 那道 5s 被砍。补拉让这种情况自愈，而不必等下一次页面请求。
 */
export const WEATHER_RETRY_MS = 25 * 1000;

/** 取数模式：`cached` 走缓存与冷却；`refresh` 强制；`retry` 强制且不再排下一次补拉。 */
export const WEATHER_MODES = Object.freeze(['cached', 'refresh', 'retry']);

/**
 * 把 `read()` 的第二个参数归一成一个模式。
 * 兼容旧写法 `{ force: true }`（v1.1.8 的调用点都用它），避免一次改不干净就炸。
 * @param {string|{mode?:string,force?:boolean}|undefined} input
 * @returns {'cached'|'refresh'|'retry'}
 */
function normalizeMode(input) {
  const raw = typeof input === 'string' ? input : input?.mode ?? (input?.force ? 'refresh' : 'cached');
  return WEATHER_MODES.includes(raw) ? raw : 'cached';
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
 * @param {{timeoutMs:number,fetchImpl:Function}} io
 * @returns {Promise<object>} weather
 */
async function fetchWeather(lat, lon, { timeoutMs, fetchImpl }) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&hourly=temperature_2m,precipitation_probability,weather_code,is_day'
    + '&daily=sunrise,sunset&forecast_days=2&timezone=Asia%2FShanghai';
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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

/**
 * 建一个天气通道。
 *
 * 状态全在闭包里：成功缓存、上次失败、在飞请求、补拉待办、落盘位置。
 * 换位置（**key 变了**）不会互相污染：缓存与失败都带 key，读到的 key 不匹配就当没有。
 *
 * @param {object} [options]
 * @param {string} [options.storePath] 上次成功的天气落盘位置（空串 = 不落盘）
 * @param {number} [options.ttlMs] @param {number} [options.timeoutMs]
 * @param {number} [options.cooldownMs] @param {number} [options.retryMs]
 * @param {() => number} [options.now] @param {Function} [options.fetchImpl]
 * @param {Function} [options.setTimeout] @param {Function} [options.clearTimeout]
 * @returns {{read:Function,peek:Function,clear:Function,setStore:Function,storePath:string}}
 */
export function createWeatherSource(options = {}) {
  const ttlMs = Number(options.ttlMs ?? WEATHER_TTL_MS);
  const timeoutMs = Number(options.timeoutMs ?? WEATHER_TIMEOUT_MS);
  const cooldownMs = Number(options.cooldownMs ?? WEATHER_FAIL_COOLDOWN_MS);
  const retryMs = Number(options.retryMs ?? WEATHER_RETRY_MS);
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  let storePath = String(options.storePath ?? '');
  let storeLoaded = false;
  /** @type {{key:string,at:number,value:object}|null} */
  let cache = null;
  /** @type {{key:string,at:number,message:string}|null} 上一次失败（冷却窗口从这里算起） */
  let fail = null;
  /** @type {{key:string,promise:Promise<object>}|null} 单飞：并发请求共用同一次尝试 */
  let inflight = null;
  /** @type {{key:string,timer:any}|null} 失败后的补拉待办 */
  let retry = null;

  /** 把上次成功的天气读回内存（没有/坏了都当没缓存，绝不抛）。 */
  function loadStore() {
    if (storeLoaded) return;
    storeLoaded = true;
    if (!storePath) return;
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      if (!raw || typeof raw.key !== 'string' || !Number.isFinite(Number(raw.at)) || !raw.value) return;
      const at = Number(raw.at);
      // 内存里已经有更新的，就别被磁盘覆盖（重启后第一次读才会走到这里）
      if (cache && cache.at >= at) return;
      cache = { key: raw.key, at, value: raw.value };
    } catch { /* 首次运行没有这个文件，属正常 */ }
  }

  /** 成功后落盘；写不进去只影响"重启后能不能兜底"，不影响本次结果。 */
  function store() {
    if (!storePath || !cache) return;
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(storePath, JSON.stringify(cache), 'utf8');
    } catch { /* 只读目录 / 磁盘满：忽略 */ }
  }

  /** 上一次成功取到的值（哪怕已过期）—— 失败时用它兜底，别再让页面空着。 */
  const stale = (key) => (cache && cache.key === key ? cache.value : null);

  function cancelRetry() {
    if (!retry) return;
    clearTimer(retry.timer);
    retry = null;
  }

  /**
   * 排一次后台补拉（只排一次；补拉自己失败时不再排）。
   * 三条纪律：不在 `/hud` 的请求路径上（谁也不用陪它等）、同一坐标只挂一个待办、
   * 期间已有新数据就跳过。
   * @param {string} key @param {number} lat @param {number} lon
   */
  function scheduleRetry(key, lat, lon) {
    if (retry && retry.key === key) return;
    cancelRetry();
    const timer = setTimer(() => {
      retry = null;
      if (cache && cache.key === key && now() - cache.at < ttlMs) return; // 已经被别人取到新鲜的了
      void read(lat, lon, 'retry').catch(() => {});
    }, retryMs);
    if (typeof timer?.unref === 'function') timer.unref(); // 别把进程吊着
    retry = { key, timer };
  }

  /**
   * 取一次天气。
   * @param {number} lat @param {number} lon
   * @param {'cached'|'refresh'|'retry'|{mode?:string,force?:boolean}} [mode]
   * @returns {Promise<object|null>} 天气；失败时抛（`cached` 模式下冷却期直接给旧值/空）
   */
  async function read(lat, lon, modeInput) {
    const mode = normalizeMode(modeInput);
    const key = `${lat},${lon}`;
    loadStore();
    if (mode === 'cached' && cache && cache.key === key && now() - cache.at < ttlMs) {
      return cache.value;
    }
    if (mode === 'cached' && fail && fail.key === key && now() - fail.at < cooldownMs) {
      return stale(key);
    }
    if (inflight && inflight.key === key) return inflight.promise;

    const entry = { key, promise: null };
    entry.promise = (async () => {
      try {
        const value = await fetchWeather(lat, lon, { timeoutMs, fetchImpl });
        cache = { key, at: now(), value };
        fail = null;
        cancelRetry(); // 已经有新数据了，别再补
        store();
        return value;
      } catch (error) {
        fail = { key, at: now(), message: error instanceof Error ? error.message : String(error) };
        // 补拉自己失败时不再排下一次：否则断网时会变成每 retryMs 一次的轮询。
        if (mode !== 'retry') scheduleRetry(key, lat, lon);
        throw error;
      }
    })();
    inflight = entry;
    // 只清理自己这一轮：别把后来者的单飞记录抹掉，也别让这条链产生未处理的 rejection。
    entry.promise.then(() => {}, () => {}).then(() => { if (inflight === entry) inflight = null; });
    return entry.promise;
  }

  return {
    read,
    /**
     * 诊断/测试用：看一眼当前状态（不触发网络）。
     * 字段名是既有契约（`/hud` 的 `weatherDiag`、设置页诊断区、探针都在读），加字段可以，别改名。
     */
    peek() {
      return {
        cached: cache ? { key: cache.key, at: cache.at } : null,
        failed: fail ? { key: fail.key, at: fail.at, message: fail.message } : null,
        inflight: Boolean(inflight),
        retryPending: Boolean(retry),
        ttlMs,
        retryMs,
        cooldownMs,
        timeoutMs,
      };
    },
    /** 换位置 / 设置变更后调用：丢掉缓存、失败状态与补拉待办。 */
    clear() {
      cache = null;
      fail = null;
      cancelRetry();
    },
    /** 落盘位置变了（dataDir 配置变化）：重新按新路径读一次磁盘。 */
    setStore(path) {
      const next = String(path ?? '');
      if (next === storePath) return;
      storePath = next;
      storeLoaded = false;
    },
    get storePath() { return storePath; },
  };
}
