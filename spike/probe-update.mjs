#!/usr/bin/env node
/**
 * spike/probe-update.mjs — LifeHud v1.1.2「检查更新」链路的独立验证。
 *
 * 不依赖浏览器、也不依赖网络：所有 GitHub 响应都由本脚本注入的 fake fetch 提供，
 * 所以离线、限流、超时这些场景都能确定性复现。真实网络只在 `--live` 时打一次。
 *
 * 用法：
 *   node spike/probe-update.mjs                              # 确定性断言（离线可跑）
 *   node spike/probe-update.mjs http://127.0.0.1:<DSH 端口>    # 另外跑 HTTP 契约
 *   node spike/probe-update.mjs --live                        # 真打一次 GitHub
 *
 * 退出码：有 FAIL → 1，否则 0。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVersion, compareVersion, summarizeUpdate, readUpdate } from '../plugin/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const PKG_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(REPO, 'plugin', 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
})();
const CLIENT_BUILD = (() => {
  try {
    const source = readFileSync(join(REPO, 'plugin', 'client.js'), 'utf8');
    const m = /const BUILD = '([^']+)'/.exec(source);
    return m ? m[1] : '';
  } catch {
    return '';
  }
})();

// DSH 的 Web 端口每次启动都会变，所以地址只从参数/环境变量取，不硬编码。
// 参数里可能混着 --live，所以只把 http(s) 开头的那一个当成 BASE。
const ARGS = process.argv.slice(2);
const BASE = String(ARGS.find((arg) => /^https?:\/\//i.test(arg)) ?? process.env.LIFEHUD_BASE ?? '')
  .replace(/\/+$/, '');
const LIVE = ARGS.includes('--live');

// ──────────────────────────── 断言基础设施 ────────────────────────────
const results = [];
const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };

function record(name, pass, evidence) {
  results.push({ name, status: pass ? 'PASS' : 'FAIL', evidence });
  const tag = pass ? `${C.ok}PASS${C.off}` : `${C.bad}FAIL${C.off}`;
  console.log(`  [${tag}] ${name}\n         ${C.dim}→ ${evidence}${C.off}`);
}

async function check(name, fn) {
  try {
    record(name, true, await fn());
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function fail(message) { throw new Error(message); }
function assert(cond, message) { if (!cond) fail(message); }
function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${label}: 期望 ${b}，实际 ${a}`);
}

// ──────────────────────────── fake GitHub ────────────────────────────
/** 造一个够用的 Response 替身（只用到 status / ok / headers.get / json）。 */
function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

/**
 * 按 URL 子串路由的 fake fetch。`routes` 的值可以是 Response、Error（直接抛），
 * 或 `(url, init) => Response|Promise<Response>`。所有请求都记进 `calls`。
 * @param {Record<string, any>} routes @param {Array<{url:string,init:any}>} calls
 */
function fakeFetch(routes, calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = Object.keys(routes).find((key) => String(url).includes(key));
    if (!hit) throw new Error(`fakeFetch 收到没预设的 URL：${url}`);
    const value = routes[hit];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(String(url), init);
    return value;
  };
}

const releaseUrl = (repo) => `https://api.github.com/repos/${repo}/releases/latest`;
const tagsUrl = (repo) => `https://api.github.com/repos/${repo}/tags?per_page=30`;
const releaseBody = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/probe/repo/releases/tag/${tag}`,
  published_at: '2026-11-12T00:00:00Z',
  body: `${tag} 的说明`,
  ...extra,
});

/** 每次跑用不同的 repo，避开模块级结果缓存互相污染。 */
const repoOf = (name) => `probe/${name}`;

// ──────────────────────────── A. 版本号 ────────────────────────────
function sectionA() {
  console.log('\n--- A. 版本号解析与比较 ---');

  return (async () => {
    await check('A1 解析 v1.1.1', () => {
      deepEq(parseVersion('v1.1.1'), { major: 1, minor: 1, patch: 1, prerelease: '' }, 'parseVersion');
      return 'v1.1.1 → 1.1.1';
    });
    await check('A2 两位数字段按数值比（1.10.0 > 1.9.9）', () => {
      assert(compareVersion(parseVersion('1.10.0'), parseVersion('1.9.9')) === 1, '1.10.0 应大于 1.9.9');
      return '1.10.0 > 1.9.9 ✓';
    });
    await check('A3 预发布后缀只记录、不参与比较', () => {
      const parsed = parseVersion('v1.1.2-rc.1');
      eq(parsed.prerelease, 'rc.1', 'prerelease');
      eq(compareVersion(parsed, parseVersion('1.1.2')), 0, '1.1.2-rc.1 vs 1.1.2');
      return '1.1.2-rc.1 ≡ 1.1.2（后缀忽略）';
    });
    await check('A4 非版本名返回 null', () => {
      for (const bad of ['1.1', 'nightly', '', null, 'v1.1.1.1', 'release-1.1.1']) {
        assert(parseVersion(bad) === null, `${JSON.stringify(bad)} 应返回 null`);
      }
      return '1.1 / nightly / 空 / v1.1.1.1 全部 null';
    });
    await check('A5 summarizeUpdate：远端更新', () => {
      deepEq(summarizeUpdate('1.1.1', '1.1.2'), { hasUpdate: true, ahead: false, prerelease: false }, '1.1.1 → 1.1.2');
      return 'hasUpdate=true, ahead=false';
    });
    await check('A6 summarizeUpdate：本地更新（未发布的版本）', () => {
      deepEq(summarizeUpdate('1.1.2', '1.1.1'), { hasUpdate: false, ahead: true, prerelease: false }, '1.1.2 vs 1.1.1');
      return 'ahead=true，不冒充「有新版本」';
    });
    await check('A7 summarizeUpdate：相同 / 远端缺失', () => {
      deepEq(summarizeUpdate('1.1.1', '1.1.1'), { hasUpdate: false, ahead: false, prerelease: false }, '相等');
      deepEq(summarizeUpdate('1.1.1', null), { hasUpdate: false, ahead: false, prerelease: false }, 'latest=null');
      return '相等与 null 都 safe';
    });
    await check('A8 summarizeUpdate：预发布标记', () => {
      const v = summarizeUpdate('1.1.1', '1.1.2-rc.1');
      assert(v.hasUpdate && v.prerelease, `预发布应标出来：${JSON.stringify(v)}`);
      return 'prerelease=true';
    });
  })();
}

// ──────────────────────────── B. 三处版本一致 ────────────────────────────
function sectionB() {
  console.log('\n--- B. 版本号一致性（package.json / client BUILD） ---');
  return (async () => {
    await check('B1 package.json 的 version 是 x.y.z', () => {
      assert(/^\d+\.\d+\.\d+$/.test(PKG_VERSION), `package.json version 不合法：${JSON.stringify(PKG_VERSION)}`);
      return `plugin/package.json = ${PKG_VERSION}`;
    });
    await check('B2 client.js 的 BUILD 与 package.json 一致', () => {
      eq(CLIENT_BUILD, PKG_VERSION, 'client BUILD');
      return `client BUILD = ${CLIENT_BUILD}`;
    });
  })();
}

// ──────────────────────────── C. readUpdate（注入 fetch） ────────────────────────────
async function sectionC() {
  console.log('\n--- C. readUpdate()：成功路径 ---');

  await check('C1 Release 命中：latest / source / url / notes', async () => {
    const calls = [];
    const result = await readUpdate({ updateRepo: repoOf('release-hit') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(200, releaseBody('v99.0.0', { body: '新版本说明' })) }, calls),
    });
    eq(result.latest, '99.0.0', 'latest');
    eq(result.source, 'release', 'source');
    eq(result.url, 'https://github.com/probe/repo/releases/tag/v99.0.0', 'url');
    eq(result.notes, '新版本说明', 'notes');
    eq(result.hasUpdate, true, 'hasUpdate');
    eq(result.reason, null, 'reason');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(String(result.checkedAt)), 'checkedAt 应是 ISO 时间');
    eq(calls.length, 1, '只打一个接口（有 Release 就不查 tags）');
    return `99.0.0 · release · ${calls.length} 次请求`;
  });

  await check('C2 请求头只有身份，没有凭据', async () => {
    const calls = [];
    await readUpdate({ updateRepo: repoOf('headers') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(404) , '/tags': jsonResponse(200, []) }, calls),
    });
    const headers = calls[0]?.init?.headers ?? {};
    assert(String(headers['user-agent'] ?? '').startsWith('dsh-lifehud/'), `user-agent 不对：${headers['user-agent']}`);
    assert(!('authorization' in headers), '不应该带 authorization');
    return `user-agent=${headers['user-agent']}，无 authorization`;
  });

  await check('C3 Release 404 → 回退 tags，并取最大版本（不取第一个）', async () => {
    const calls = [];
    const result = await readUpdate({ updateRepo: repoOf('tags-fallback') }, {
      fetchImpl: fakeFetch({
        'releases/latest': jsonResponse(404),
        '/tags': jsonResponse(200, [{ name: 'v9.0.0' }, { name: 'v9.2.0' }, { name: 'v9.1.0' }]),
      }, calls),
    });
    eq(result.latest, '9.2.0', 'latest');
    eq(result.source, 'tags', 'source');
    eq(result.url, 'https://github.com/probe/tags-fallback/tags', 'url');
    eq(calls.length, 2, 'release 404 后才查 tags');
    return '9.0.0 / 9.2.0 / 9.1.0 → 9.2.0';
  });

  await check('C4 tags 里的非版本名被忽略', async () => {
    const result = await readUpdate({ updateRepo: repoOf('tags-junk') }, {
      fetchImpl: fakeFetch({
        'releases/latest': jsonResponse(404),
        '/tags': jsonResponse(200, [{ name: 'nightly' }, { name: 'v9.0.0' }, { name: 'latest' }]),
      }, []),
    });
    eq(result.latest, '9.0.0', 'latest');
    return 'nightly / latest 被跳过';
  });

  await check('C5 Release 的 tag 不是版本号 → 继续回退 tags', async () => {
    const result = await readUpdate({ updateRepo: repoOf('release-junk') }, {
      fetchImpl: fakeFetch({
        'releases/latest': jsonResponse(200, releaseBody('nightly')),
        '/tags': jsonResponse(200, [{ name: 'v9.3.0' }]),
      }, []),
    });
    eq(result.latest, '9.3.0', 'latest');
    eq(result.source, 'tags', 'source');
    return 'nightly → 回退 tags 得 9.3.0';
  });

  await check('C6 Release 缺 html_url 时自己拼发布页地址', async () => {
    const result = await readUpdate({ updateRepo: repoOf('no-html-url') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(200, { tag_name: 'v9.9.9' }) }, []),
    });
    eq(result.url, 'https://github.com/probe/no-html-url/releases/tag/v9.9.9', 'url');
    return result.url;
  });

  await check('C7 Release 正文截断到 400 字', async () => {
    const result = await readUpdate({ updateRepo: repoOf('notes') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(200, releaseBody('v99.0.0', { body: 'x'.repeat(1000) })) }, []),
    });
    eq(result.notes.length, 400, 'notes 长度');
    return '1000 字 → 400 字';
  });

  await check('C8 远端没有可识别版本 → reason=no-tags，不报错', async () => {
    const result = await readUpdate({ updateRepo: repoOf('no-tags') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(404), '/tags': jsonResponse(200, [{ name: 'nightly' }]) }, []),
    });
    eq(result.latest, null, 'latest');
    eq(result.reason, 'no-tags', 'reason');
    eq(result.stale, false, 'stale');
    return 'latest=null + no-tags';
  });

  console.log('\n--- C. readUpdate()：失败与降级 ---');

  await check('C9 403 限流：reason=rate-limited，且不再打 tags', async () => {
    const calls = [];
    const result = await readUpdate({ updateRepo: repoOf('rate') }, {
      fetchImpl: fakeFetch({
        'releases/latest': jsonResponse(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0' }),
      }, calls),
    });
    eq(result.reason, 'rate-limited', 'reason');
    eq(result.stale, true, 'stale');
    eq(calls.length, 1, '限流后不该继续请求');
    return 'rate-limited · stale';
  });

  await check('C10 网络抛错：reason=network', async () => {
    const result = await readUpdate({ updateRepo: repoOf('offline') }, {
      fetchImpl: fakeFetch({ 'releases/latest': new Error('getaddrinfo ENOTFOUND api.github.com') }, []),
    });
    eq(result.reason, 'network', 'reason');
    eq(result.latest, null, 'latest');
    return '离线 → network';
  });

  await check('C11 超时：reason=timeout', async () => {
    const timeout = new Error('The operation was aborted');
    timeout.name = 'TimeoutError';
    const result = await readUpdate({ updateRepo: repoOf('timeout') }, {
      fetchImpl: fakeFetch({ 'releases/latest': timeout }, []),
    });
    eq(result.reason, 'timeout', 'reason');
    return '8 秒超时 → timeout';
  });

  await check('C12 返回坏 JSON：reason=bad-payload', async () => {
    const result = await readUpdate({ updateRepo: repoOf('bad-json') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(200, new SyntaxError('Unexpected token <')) }, []),
    });
    eq(result.reason, 'bad-payload', 'reason');
    return 'HTML/坏 JSON → bad-payload';
  });

  await check('C13 tags 形状不对：reason=bad-payload', async () => {
    const result = await readUpdate({ updateRepo: repoOf('bad-tags') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(404), '/tags': jsonResponse(200, { message: 'nope' }) }, []),
    });
    eq(result.reason, 'bad-payload', 'reason');
    return 'object 而不是 array → bad-payload';
  });

  await check('C13b tags 也 404：reason=not-found（仓库不存在）', async () => {
    const result = await readUpdate({ updateRepo: repoOf('gone') }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(404), '/tags': jsonResponse(404) }, []),
    });
    eq(result.reason, 'not-found', 'reason');
    return '两个接口都 404 → not-found';
  });

  await check('C14 失败时保留上一次成功结果（stale + checkedAt 不变）', async () => {
    const repo = repoOf('stale');
    const first = await readUpdate({ updateRepo: repo }, {
      fetchImpl: fakeFetch({ 'releases/latest': jsonResponse(200, releaseBody('v99.0.0')) }, []),
    });
    const second = await readUpdate({ updateRepo: repo }, {
      fetchImpl: fakeFetch({ 'releases/latest': new Error('offline') }, []),
    });
    eq(second.latest, '99.0.0', '保留上次 latest');
    eq(second.checkedAt, first.checkedAt, 'checkedAt 不应被失败覆盖');
    eq(second.stale, true, 'stale');
    eq(second.reason, 'network', 'reason');
    return `latest=${second.latest} · checkedAt 保持第一次`;
  });

  await check('C15 从未成功过：latest=null + stale', async () => {
    const result = await readUpdate({ updateRepo: repoOf('never') }, {
      fetchImpl: fakeFetch({ 'releases/latest': new Error('offline') }, []),
    });
    eq(result.latest, null, 'latest');
    eq(result.stale, true, 'stale');
    eq(result.hasUpdate, false, 'hasUpdate');
    return '失败且无历史 → 空快照';
  });

  await check('C16 updateCheck:false → 一次网络都不打', async () => {
    const calls = [];
    const result = await readUpdate({ updateRepo: repoOf('disabled'), updateCheck: false }, {
      fetchImpl: fakeFetch({}, calls),
    });
    eq(result.reason, 'disabled', 'reason');
    eq(calls.length, 0, '请求次数');
    return 'disabled · 0 次请求';
  });

  await check('C17 updateRepo 非法 → bad-repo，不拼 URL', async () => {
    const calls = [];
    const result = await readUpdate({ updateRepo: 'https://evil.example/x' }, {
      fetchImpl: fakeFetch({}, calls),
    });
    eq(result.reason, 'bad-repo', 'reason');
    eq(calls.length, 0, '请求次数');
    return '非法 repo · 0 次请求';
  });

  await check('C18 没有 TTL 缓存：每次点都真打一次网络', async () => {
    const repo = repoOf('no-ttl');
    const calls = [];
    const fetchImpl = fakeFetch({
      'releases/latest': jsonResponse(404),
      '/tags': jsonResponse(200, [{ name: 'v99.0.0' }]),
    }, calls);
    const first = await readUpdate({ updateRepo: repo }, { fetchImpl });
    const second = await readUpdate({ updateRepo: repo }, { fetchImpl });
    eq(calls.length, 4, '两次调用应各打一次（release 404 + tags）× 2');
    eq(second.latest, first.latest, '两次结果一致');
    eq(second.stale, false, '第二次也不该是 stale');
    return '两次调用 4 个请求（无缓存）';
  });

  await check('C19 并发检查共用一次请求（防连点）', async () => {
    const repo = repoOf('inflight');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const fetchImpl = fakeFetch({
      'releases/latest': async () => { await gate; return jsonResponse(200, releaseBody('v99.0.0')); },
    }, calls);
    const p1 = readUpdate({ updateRepo: repo }, { fetchImpl });
    const p2 = readUpdate({ updateRepo: repo }, { fetchImpl });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    eq(calls.length, 1, '并发两次只该有一个请求');
    eq(r1, r2, '两个调用应拿到同一个结果对象');
    return '1 个请求 · 同一结果';
  });

  await check('C20 返回值永远是对象，不抛异常', async () => {
    const result = await readUpdate({}, {
      fetchImpl: fakeFetch({ 'releases/latest': new Error('boom') }, []),
    });
    assert(result && typeof result === 'object' && result.ok === true, '应返回 ok:true 的降级快照');
    return '失败也返回快照';
  });
}

// ──────────────────────────── D. HTTP 契约（可选） ────────────────────────────
async function sectionD() {
  console.log('\n--- D. HTTP 契约（给了 DSH 地址才跑） ---');
  if (!BASE) {
    console.log(`  ${C.dim}跳过：用法 node spike/probe-update.mjs http://127.0.0.1:<端口>${C.off}`);
    return;
  }
  const url = `${BASE}/lifehud/api/update`;
  await check('D1 GET /lifehud/api/update → 200 + 字段形状', async () => {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    eq(res.status, 200, 'HTTP 状态');
    const body = await res.json();
    eq(body.ok, true, 'ok');
    assert(typeof body.current === 'string' && body.current.length > 0, `current 不合法：${JSON.stringify(body.current)}`);
    assert(typeof body.hasUpdate === 'boolean', 'hasUpdate 应是布尔');
    assert(typeof body.stale === 'boolean', 'stale 应是布尔');
    assert('reason' in body && 'repo' in body && 'url' in body, '缺少字段');
    return `HTTP 200 · current=${body.current} · latest=${body.latest ?? 'null'} · reason=${body.reason ?? 'null'}`;
  });
  await check('D2 POST /lifehud/api/update → 405', async () => {
    const res = await fetch(url, { method: 'POST', body: '{}' });
    eq(res.status, 405, 'HTTP 状态');
    return 'POST 被拒';
  });
}

// ──────────────────────────── E. 真网络（--live） ────────────────────────────
async function sectionE() {
  console.log('\n--- E. 真网络（--live） ---');
  if (!LIVE) {
    console.log(`  ${C.dim}跳过：加 --live 才真打 GitHub${C.off}`);
    return;
  }
  await check('E1 真打 GitHub（只读，不发送本机信息）', async () => {
    const result = await readUpdate({ updateRepo: 'z1lyA/dsh-lifehud' });
    assert(result.ok === true, 'ok');
    assert(result.reason === null || ['no-tags', 'network', 'rate-limited', 'timeout', 'bad-payload'].includes(result.reason),
      `reason 意外：${result.reason}`);
    return `current=${result.current} · latest=${result.latest ?? 'null'} · source=${result.source ?? 'null'} · reason=${result.reason ?? 'null'}`;
  });
}

// ──────────────────────────── main ────────────────────────────
(async () => {
  console.log(`probe-update：当前 plugin/package.json = ${PKG_VERSION}，client BUILD = ${CLIENT_BUILD}`);
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\n===== ${results.length - failed.length}/${results.length} PASS =====`);
  if (failed.length) {
    for (const item of failed) console.log(`${C.bad}FAIL${C.off} ${item.name} — ${item.evidence}`);
    process.exit(1);
  }
  console.log(`${C.ok}全部通过${C.off}`);
})();
