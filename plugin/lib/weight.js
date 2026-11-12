/**
 * 体重：小米云（RC4 签名 + 会话文件）+ 本地镜像库。
 * 从 plugin/index.js 拆出（v1.1.2 评审 S3）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// 体重只在踩秤后变化，10 分钟一次足够；手动刷新会用 ?force=1 跳过这个 TTL。
const WEIGHT_TTL_MS = 10 * 60 * 1000;

/** 小米云端点（细节见 docs/小米云取数.md）。设备号不再写死，见 resolveMiDid()。 */
const MI_BASE = 'https://api.io.mi.com/app';
const MI_DEVICE_DATA_PATH = '/user/get_user_device_data';
const MI_DEVICE_LIST_PATH = '/home/device_list';
/** 体脂秤在 device_list 里的 model 形如 `yoda.scales.mx80`。 */
const MI_SCALE_MODEL = /scales/i;
/** 「最近有数据的 N 个测量日」。 */
const WEIGHT_DAYS = 7;

/** 小米云会话文件默认放 dataDir 里，不进仓库、不进 git。 */
const miSessionPath = (config) => String(config.miSession ?? '')
  || join(String(config.dataDir ?? join(homedir(), '.dsh', 'lifehud')), 'mi-session.json');

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
export { WEIGHT_TTL_MS };
