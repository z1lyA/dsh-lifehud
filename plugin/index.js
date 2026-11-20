/**
 * LifeHud — Host half（入口）。
 *
 * Endpoints (all loopback-only):
 *   GET    /lifehud/api/hud       → tasks(current slot) + weather + sessions + focus + countdown
 *   GET    /lifehud/api/weight    → weight series (last 7 measured days) + average + sync state
 *   GET    /lifehud/api/countdown → 倒计时状态（单个，Host 侧计时）
 *   POST   /lifehud/api/countdown → { action: start|pause|resume|cancel, ms? }
 *   POST   /lifehud/api/inbox     → 往 NowTree 的 Inbox 追加一条 {title, note?}（v1.1.8）
 *   GET    /lifehud/api/settings  → persisted settings (location etc.)
 *   POST   /lifehud/api/settings  → merge settings
 *   GET    /lifehud/api/update    → 检查远端有没有新版本（只读 GitHub，手动触发）
 *
 * 实现拆在 lib/ 下（v1.1.2 评审 S3）：capture / activity / weight / update / hud / settings / util / inbox。
 * 所有外部数据源只读，唯一例外是 `POST /inbox`：往 NowTree 的 transactions 表**追加**一行
 * （只 INSERT，不改不删，见 lib/inbox.js）。
 *
 * @module dsh-lifehud
 */
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildHud, clearWeatherCache, nowtreeDbPath, readWeather } from './lib/hud.js';
import { addInboxTask, countInboxTasks, InboxError } from './lib/inbox.js';
import { readWeight, WEIGHT_TTL_MS } from './lib/weight.js';
import { readUpdate } from './lib/update.js';
import { importHistory, noteCapture, startCollector } from './lib/capture.js';
import { mergeSettingsFile, readSettingsFile } from './lib/settings.js';
import {
  configureCountdown, countdownStatus, countdownStart, countdownPause,
  countdownResume, countdownCancel, disposeCountdown,
} from './lib/countdown.js';

const API_PREFIX = '/lifehud/api';
const HUD_PATH = `${API_PREFIX}/hud`;
const WEIGHT_PATH = `${API_PREFIX}/weight`;
const COUNTDOWN_PATH = `${API_PREFIX}/countdown`;
const INBOX_PATH = `${API_PREFIX}/inbox`;
const SETTINGS_PATH = `${API_PREFIX}/settings`;
const SESSION_EXISTS_PATH = `${API_PREFIX}/session-exists`;
const UPDATE_PATH = `${API_PREFIX}/update`;

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

/** 请求体上限。只剩设置/倒计时这类小 JSON，1 MB 绰绰有余（相册上传已移除）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** @param {import('node:http').IncomingMessage} req @returns {Promise<string>} */
function readTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  mkdirSync(dataDir, { recursive: true });

  // 倒计时（v1.1.6）：计时器必须活在 Host —— 页面切走/挂后台时组件卸载，
  // 纯前端计时器会跟着消失，到点不会有任何提醒。这里顺便处理「离开期间到点」的补偿通知。
  try {
    configureCountdown({ ...config, dataDir });
    ctx.effect(() => () => disposeCountdown(), 'lifehud: countdown');
  } catch (error) {
    try { ctx.logger?.warn?.(`[lifehud] countdown not ready: ${error instanceof Error ? error.message : String(error)}`); } catch { /* ignore */ }
  }

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

  // 天气也定时暖着（v1.1.10）：和体重同一套范式——页面关着也同步，这样「打开就是新的」，
  // 也不用再靠卡片上那句「预报取于 X 小时前」来提醒你。
  //
  // 和体重不同的两点：① 默认 30 分钟（预报本身有效以小时计，10 分钟一拉是浪费）；
  // ② `weatherPollMs: 0` 可以整体关掉（关掉就退回 v1.1.9 的「按需取数 + 失败补一次」）。
  // 每次 tick 重新读一次设置，所以「设置里改位置」不用等重启。
  try {
    const pollMs = Number(config.weatherPollMs ?? 30 * 60 * 1000);
    ctx.effect(() => {
      if (!(pollMs > 0)) return () => {};
      const period = Math.max(60000, pollMs);
      const timer = setInterval(() => {
        try {
          const settings = readSettingsFile(dataDir);
          const lat = Number(settings.latitude ?? config.latitude ?? 39.9042);
          const lon = Number(settings.longitude ?? config.longitude ?? 116.4074);
          void readWeather(lat, lon, { mode: 'refresh' }).catch(() => {});
        } catch (error) {
          // 读设置失败：这一轮跳过，绝不把定时器搞挂。
          // 但也别把编程错误（比如漏了 import）吞成静默——v1.1.10 就被这个空 catch 骗过一次：
          // 定时器"在跑"，永远不会取数，直到真机盯了 90 秒才发现。
          try {
            ctx.logger?.warn?.(`[lifehud] weather poll tick failed: ${error instanceof Error ? error.message : String(error)}`);
          } catch { /* logging must not fail the timer */ }
        }
      }, period);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, 'lifehud: weather poll');
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[lifehud] weather poll timer not registered: ${error instanceof Error ? error.message : String(error)}`);
    } catch { /* logging must not fail activation */ }
  }

  // 自采集（v1.1.1）：本机 PowerShell 采样前台窗口 + 空闲状态，把合并后的事件写进
  // <dataDir>/capture.db。启动失败只进诊断，绝不影响页面本身起不来。
  //
  // 顺序很重要：**先迁移历史、再开实时采集**。迁移只在第一次（history_imported != '1'）
  // 真正干活，所以两条数据的时间段天然不重叠；幂等也保证重复 apply 不会重复导入。
  try {
    ctx.effect(() => {
      try {
        const imported = importHistory({ ...config, dataDir });
        if (imported.events > 0 || imported.skipped === 'error') {
          ctx.logger?.info?.(`[lifehud] activity history: ${JSON.stringify(imported)}`);
        }
      } catch (error) {
        noteCapture(`迁移未完成：${error instanceof Error ? error.message : String(error)}`);
      }
      const stop = startCollector({ ...config, dataDir });
      return () => {
        try { stop(); } catch { /* 收尾失败不该阻塞卸载 */ }
      };
    }, 'lifehud: capture');
  } catch (error) {
    noteCapture(`采集器未启动：${error instanceof Error ? error.message : String(error)}`);
    try {
      ctx.logger?.warn?.(`[lifehud] capture not started: ${error instanceof Error ? error.message : String(error)}`);
    } catch { /* logging must not fail activation */ }
  }

  ctx.inject(['webServer'], (web) => {
    web.effect(() => {
      const countdownHandler = async (req, res) => {
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, countdown: countdownStatus() });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'GET/POST only' });
          return;
        }
        try {
          const text = await readTextBody(req);
          const body = text ? JSON.parse(text) : {};
          const action = String(body.action ?? '');
          let next;
          if (action === 'start') next = countdownStart(Number(body.ms));
          else if (action === 'pause') next = countdownPause();
          else if (action === 'resume') next = countdownResume();
          else if (action === 'cancel') next = countdownCancel();
          else throw new Error('action 必须是 start / pause / resume / cancel');
          sendJson(res, 200, { ok: true, countdown: next });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
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
            clearWeatherCache();
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
        // ?force=1 = 用户自己点了「刷新」：天气跳过 10 分钟 TTL **和失败冷却**，
        // 老老实实打一次网络。冷却期内点刷新却拿回旧值，正是 v1.1.8 要修的那个「备注滞后」。
        let force = false;
        try {
          force = new URL(String(req.url ?? ''), 'http://127.0.0.1').searchParams.get('force') === '1';
        } catch { /* 非法 URL 就当普通请求 */ }
        buildHud(config, { isRunning }, { mode: force ? 'refresh' : 'cached' })
          // 倒计时随 /hud 一起下发（页面开着时卡片能立刻拿到权威状态）；
          // 它自己的增删改走 POST /lifehud/api/countdown。
          .then((payload) => sendJson(res, 200, { ...payload, countdown: countdownStatus() }))
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

      // 收件箱录入（v1.1.8）：任务卡右上角「+」→ 弹窗 → 这里。**唯一的写路径**。
      // 只 INSERT 一行，不碰任何已有记录；失败一律带 reason 回页面，不重试、不落半截。
      const inboxHandler = async (req, res) => {
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST required' });
          return;
        }
        // 留一个总开关：不想让 LifeHud 碰 NowTree 的库就 nowtreeWrite: false。
        if (config.nowtreeWrite === false) {
          sendJson(res, 403, { ok: false, reason: 'disabled', error: '配置里关掉了收件箱录入（nowtreeWrite: false）' });
          return;
        }
        try {
          const text = await readTextBody(req);
          const body = text ? JSON.parse(text) : {};
          const dbPath = nowtreeDbPath(config);
          const task = addInboxTask(dbPath, { title: body?.title, note: body?.note });
          sendJson(res, 200, { ok: true, task, inboxCount: countInboxTasks(dbPath) });
        } catch (error) {
          const reason = error instanceof InboxError ? error.reason : 'write';
          const status = reason === 'title-required' || reason === 'title-too-long' || reason === 'note-too-long'
            ? 400
            : reason === 'busy' ? 409 : 500;
          sendJson(res, status, {
            ok: false,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const updateHandler = (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'GET required' });
          return;
        }
        if (!isLocalPeer(req)) {
          sendJson(res, 403, { ok: false, error: 'local access only' });
          return;
        }
        readUpdate(config)
          .then((snapshot) => sendJson(res, 200, snapshot))
          .catch((error) => sendJson(res, 500, {
            ok: false,
            error: 'update check failed',
            detail: error instanceof Error ? error.message : String(error),
          }));
      };

      const d1 = web.webServer.register({ kind: 'exact', path: HUD_PATH, handler: hudHandler });
      const d2 = web.webServer.register({ kind: 'exact', path: COUNTDOWN_PATH, handler: countdownHandler });
      const d3 = web.webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: settingsHandler });
      const d5 = web.webServer.register({ kind: 'exact', path: WEIGHT_PATH, handler: weightHandler });
      const d6 = web.webServer.register({ kind: 'exact', path: UPDATE_PATH, handler: updateHandler });
      const d7 = web.webServer.register({ kind: 'exact', path: INBOX_PATH, handler: inboxHandler });

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
        try { d6(); } catch { /* disposed */ }
        try { d7(); } catch { /* disposed */ }
      };
    }, 'lifehud: http routes');
  });
}


// 兼容既有探针 / 外部调用：实现搬到 lib/ 后仍从入口再导出一次。
export { readOwnActivity } from './lib/activity.js';
export { openCaptureDb, appendSample, flushCapture, captureStatus, startCollector, importHistory } from './lib/capture.js';
export { readWeight } from './lib/weight.js';
export {
  configureCountdown, countdownStatus, countdownStart, countdownPause, countdownResume,
  countdownCancel, disposeCountdown, setCountdownNotifier, shiftCountdownForTest,
  tickCountdownForTest, resetCountdownForTest, COUNTDOWN_MAX_MS,
} from './lib/countdown.js';
export { buildHud, readWeather, clearWeatherCache, weatherStatus } from './lib/hud.js';
export { createWeatherSource, WEATHER_TTL_MS, WEATHER_TIMEOUT_MS, WEATHER_FAIL_COOLDOWN_MS, WEATHER_RETRY_MS } from './lib/weather.js';
export {
  parseVersion, compareVersion, summarizeUpdate, readUpdate, UPDATE_REASON_CODES,
} from './lib/update.js';
