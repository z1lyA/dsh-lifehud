/**
 * LifeHud — Host half（入口）。
 *
 * Endpoints (all loopback-only):
 *   GET    /lifehud/api/hud       → tasks(current slot) + weather + sessions + focus
 *   GET    /lifehud/api/weight    → weight series (last 7 measured days) + sync state
 *   GET    /lifehud/api/photo     → stored photo bytes
 *   POST   /lifehud/api/photo     → store base64 photo (≤4 MB)
 *   DELETE /lifehud/api/photo     → remove photo
 *   GET    /lifehud/api/settings  → persisted settings (location etc.)
 *   POST   /lifehud/api/settings  → merge settings
 *   GET    /lifehud/api/update    → 检查远端有没有新版本（只读 GitHub，手动触发）
 *
 * 实现拆在 lib/ 下（v1.1.2 评审 S3）：capture / activity / weight / update / hud / settings / util。
 * 所有外部数据源只读；LifeHud 自己只写 <dataDir> 里的 capture.db 与体重镜像库。
 *
 * @module dsh-lifehud
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildHud, clearWeatherCache } from './lib/hud.js';
import { readWeight, WEIGHT_TTL_MS } from './lib/weight.js';
import { readUpdate } from './lib/update.js';
import { importHistory, noteCapture, startCollector } from './lib/capture.js';
import { mergeSettingsFile, readSettingsFile } from './lib/settings.js';

const API_PREFIX = '/lifehud/api';
const HUD_PATH = `${API_PREFIX}/hud`;
const WEIGHT_PATH = `${API_PREFIX}/weight`;
const PHOTO_PATH = `${API_PREFIX}/photo`;
const SETTINGS_PATH = `${API_PREFIX}/settings`;
const SESSION_EXISTS_PATH = `${API_PREFIX}/session-exists`;
const UPDATE_PATH = `${API_PREFIX}/update`;

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

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
      const d2 = web.webServer.register({ kind: 'exact', path: PHOTO_PATH, handler: photoHandler });
      const d3 = web.webServer.register({ kind: 'exact', path: SETTINGS_PATH, handler: settingsHandler });
      const d5 = web.webServer.register({ kind: 'exact', path: WEIGHT_PATH, handler: weightHandler });
      const d6 = web.webServer.register({ kind: 'exact', path: UPDATE_PATH, handler: updateHandler });

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
      };
    }, 'lifehud: http routes');
  });
}


// 兼容既有探针 / 外部调用：实现搬到 lib/ 后仍从入口再导出一次。
export { readOwnActivity } from './lib/activity.js';
export { openCaptureDb, appendSample, flushCapture, captureStatus, startCollector, importHistory } from './lib/capture.js';
export { readWeight } from './lib/weight.js';
export { buildHud, readWeather, clearWeatherCache, weatherStatus } from './lib/hud.js';
export {
  parseVersion, compareVersion, summarizeUpdate, readUpdate, UPDATE_REASON_CODES,
} from './lib/update.js';
