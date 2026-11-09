// Spike probe: 用纯 Node（零依赖、自带 RC4）打小米云 user/get_user_device_data。
// 目标：在写进 Host 之前先把「签名 / RC4 / 解析」这条链验通。
// 只读；不打印任何凭据，不打印具体体重数值。
// Run: node spike/probe-mi-cloud.mjs [sessionPath]
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = 'https://api.io.mi.com/app';
const PATH = '/user/get_user_device_data';

/* ------------------------------------------------------------------ RC4 */

/** @param {Buffer} key @returns {{S:Uint8Array,i:number,j:number}} */
function rc4Init(key) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
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
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[n] = data[n] ^ S[(S[i] + S[j]) & 0xff];
  }
  state.i = i;
  state.j = j;
  return out;
}

/** pycryptodome ARC4 行为：先吃掉 1024 字节密钥流，再处理正文。 */
function rc4Cipher(passwordB64, payload) {
  const state = rc4Init(Buffer.from(passwordB64, 'base64'));
  rc4Apply(state, Buffer.alloc(1024));
  return rc4Apply(state, payload);
}

const encryptRc4 = (passwordB64, text) => rc4Cipher(passwordB64, Buffer.from(text, 'utf8')).toString('base64');
const decryptRc4 = (passwordB64, textB64) => rc4Cipher(passwordB64, Buffer.from(textB64, 'base64'));

/* --------------------------------------------------------------- 签名 */

const b64encode = (buf) => Buffer.from(buf).toString('base64');

function genNonce() {
  const random = randomBytes(8); // 对应 python 的 8 字节有符号随机整数（字节内容本身无约束）
  const minutes = BigInt(Math.floor(Date.now() / 60000));
  let hex = minutes.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.concat([random, Buffer.from(hex, 'hex')]).toString('base64');
}

const signedNonce = (ssecurity, nonce) => b64encode(createHash('sha256')
  .update(Buffer.from(ssecurity, 'base64'))
  .update(Buffer.from(nonce, 'base64'))
  .digest());

function genEncSignature(url, method, nonceSigned, params) {
  const parts = [String(method).toUpperCase(), url.split('com')[1].replace('/app/', '/')];
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`);
  parts.push(nonceSigned);
  return b64encode(createHash('sha1').update(parts.join('&'), 'utf8').digest());
}

function generateEncParams(url, method, nonceSigned, nonce, params, ssecurity) {
  params.rc4_hash__ = genEncSignature(url, method, nonceSigned, params);
  for (const k of Object.keys(params)) params[k] = encryptRc4(nonceSigned, String(params[k]));
  params.signature = genEncSignature(url, method, nonceSigned, params);
  params.ssecurity = ssecurity;
  params._nonce = nonce;
  return params;
}

/* ---------------------------------------------------------------- 调用 */

const RANDOM_ALPHA = 'ABCDEF';
const randomAgent = () => Array.from({ length: 13 }, () => RANDOM_ALPHA[Math.floor(Math.random() * 6)]).join('');
const randomDevice = () => Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

async function callCloud(session, data, path = PATH) {
  const url = BASE + path;
  const nonce = genNonce();
  const ssecurity = String(session.ssecurity);
  const token = String(session.serviceToken);
  const uid = String(session.userId);
  const nonceSigned = signedNonce(ssecurity, nonce);
  const body = generateEncParams(url, 'POST', nonceSigned, nonce,
    { data: JSON.stringify(data) }, ssecurity);

  const cookies = {
    sdkVersion: '3.8.6',
    deviceId: randomDevice(),
    userId: uid,
    yetAnotherServiceToken: token,
    serviceToken: token,
    locale: 'zh_CN',
    timezone: 'GMT+08:00',
    is_daylight: '0',
    dst_offset: '0',
    channel: 'MI_APP_STORE',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${randomAgent()} APP/com.xiaomi.mihome APPV/10.5.201`,
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

  const text = (await response.text()).trim();
  if (text.startsWith('{') || text.startsWith('[')) return { http: response.status, payload: JSON.parse(text), encrypted: false };
  const plain = decryptRc4(nonceSigned, text).toString('utf8');
  return { http: response.status, payload: JSON.parse(plain), encrypted: true };
}

/* ------------------------------------------------------------------ 主 */

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] ?? '') : '';
};
const flag = (name) => argv.includes(name);

const sessionPath = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? '';
if (!sessionPath) {
  console.error([
    '用法：',
    '  node spike/probe-mi-cloud.mjs <mi_session.json 路径> --devices           # 列出账号下设备（找 did）',
    '  node spike/probe-mi-cloud.mjs <mi_session.json 路径> --did <设备did>     # 拉称重记录',
    '',
    '会话文件里要有 userId / serviceToken / ssecurity（只读，不会改动文件）。',
  ].join('\n'));
  process.exit(2);
}

const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
console.log('session keys:', Object.keys(session).join(','));

if (flag('--devices')) {
  const { http, payload } = await callCloud(session, { getVirtualModel: false, getHuamiDevices: 1 }, '/home/device_list');
  console.log('http:', http, 'code:', payload.code, 'msg:', payload.message);
  const list = payload?.result?.list ?? [];
  if (list.length === 0) console.log('（该账号下没有设备，或接口返回结构变了）');
  for (const device of list) {
    console.log(`  did=${device.did}  model=${device.model}  name=${device.name}  online=${device.isOnline}`);
  }
  console.log('\n体脂秤一般是 model 里带 `scales` 的那一条（如 yoda.scales.mx80）。');
  process.exit(0);
}

const did = flagValue('--did') || process.env.LIFEHUD_MI_DID || '';
if (!did) {
  console.error('缺少设备 did：先跑 `--devices` 看列表，再用 `--did <did>` 指定。');
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const body = {
  did,
  uid: String(session.userId),
  type: 'weight',
  key: 'bodyInfo',
  time_start: 0,
  time_end: now,
  group: 'raw',
  limit: 1000,
};

const { http, payload, encrypted } = await callCloud(session, body);
console.log('http:', http, 'encrypted response:', encrypted, 'code:', payload.code, 'msg:', payload.message);
const rows = payload.result ?? [];
console.log('rows:', rows.length);

const parsed = [];
for (const row of rows) {
  let value = row.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = {}; }
  }
  parsed.push({ time: row.time, value });
}
if (parsed.length > 0) {
  const keys = Object.keys(parsed[0].value);
  console.log('value fields:', keys.length, '→', keys.slice(0, 8).join(','));
  const sample = parsed[0];
  console.log('sample:', JSON.stringify({
    weightId: sample.value.weightId,
    weightIdType: typeof sample.value.weightId,
    createTime: sample.value.createTime,
    weight: sample.value.weight,
    weightType: typeof sample.value.weight,
    rowTime: sample.time,
  }));
  const times = parsed.map((p) => String(p.value.createTime ?? '')).filter(Boolean).sort();
  console.log('span:', times[0], '~', times[times.length - 1]);
  const weights = parsed.map((p) => Number(p.value.weight)).filter(Number.isFinite);
  console.log('weight range:', Math.min(...weights).toFixed(1), '~', Math.max(...weights).toFixed(1));
}
