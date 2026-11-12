/**
 * 检查更新：读 GitHub Release/Tag，和本地 package.json 版本比较。
 * 只在页面手动点「检查更新」时被调用；从 plugin/index.js 拆出（v1.1.2 评审 S3）。
 */
import { readFileSync } from 'node:fs';

/* ---- 检查更新（只读 GitHub，手动触发）常量，见下面「检查更新」一节 ---- */
/** GitHub 请求超时（离线时别让按钮转圈太久）。 */
const UPDATE_TIMEOUT_MS = 8 * 1000;
/** 默认检查的仓库（fork 用 config.updateRepo 覆盖）。 */
const UPDATE_REPO_DEFAULT = 'z1lyA/dsh-lifehud';
/** Release 正文只留一小段，弹窗里放得下。 */
const UPDATE_NOTES_MAX = 400;
/** tags 接口一次取多少个（够覆盖最近的发版；取其中最大的语义版本）。 */
const UPDATE_TAGS_PER_PAGE = 30;
/**
 * 检查更新可能返回的 reason 码。
 * 页面（client.js）负责翻译成中文，浏览器 bundle 没法 import Host 常量，
 * 所以这里导出一份清单，由 `spike/probe-update.mjs` 断言两边键集一致。
 */
export const UPDATE_REASON_CODES = Object.freeze([
  'disabled', 'no-fetch', 'network', 'timeout', 'rate-limited',
  'not-found', 'bad-payload', 'bad-repo', 'no-tags',
]);


/* ------------------------------------------------------------ 检查更新 */

/**
 * 本地插件版本：`plugin/package.json` 是唯一真源。
 * 页面的 `client.js` 里另有一个 `BUILD`，两者是否一致由 `spike/probe-update.mjs` 守
 * （Host 与 Client 分开加载，版本号没法在运行时互相引用）。
 * @returns {string} e.g. '1.1.1'；读不到就空串（退化成「无法比较」，绝不抛错）
 */
function readOwnVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? '').trim();
  } catch {
    return '';
  }
}

/** 本进程里 Host 的版本（模块加载时读一次）。 */
const PLUGIN_VERSION = readOwnVersion();

/**
 * 解析 `v1.2.3` / `1.2.3-rc.1` 形状的版本号。
 * 预发布后缀只记录（`prerelease`），不参与大小比较：本项目的发版 tag 都是正式版。
 * @param {unknown} text @returns {{major:number,minor:number,patch:number,prerelease:string}|null}
 */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? '' };
}

/** @param {{major:number,minor:number,patch:number}} a @param {typeof a} b @returns {-1|0|1} */
export function compareVersion(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/**
 * 由「本地版本 + 远端版本」得出三个布尔量。纯函数：探针可以直接验，
 * 不用为了造一个 ahead 场景去改模块里的本地版本。
 * @param {string} current @param {string|null} latest
 * @returns {{hasUpdate:boolean,ahead:boolean,prerelease:boolean}}
 */
export function summarizeUpdate(current, latest) {
  const currentParsed = parseVersion(current);
  const latestParsed = latest ? parseVersion(latest) : null;
  return {
    hasUpdate: Boolean(latestParsed && currentParsed && compareVersion(latestParsed, currentParsed) > 0),
    ahead: Boolean(latestParsed && currentParsed && compareVersion(currentParsed, latestParsed) > 0),
    prerelease: Boolean(latestParsed?.prerelease),
  };
}

/** 检查更新的最近一次成功结果（只在内存里：失败时降级用它，不落盘）。 */
const updateCache = { repo: '', result: null };
/** 同一个仓库的并发检查共用一次请求（防连点）。 @type {Map<string,Promise<object>>} */
const updateInflight = new Map();

/**
 * `config.updateRepo` 的校验：owner/name 两段，只允许 GitHub 合法字符。
 * 不合法就返回空串（由调用方降级成 bad-repo），绝不把任意字符串拼进 URL。
 * @param {object} config @returns {string}
 */
function updateRepoOf(config) {
  const raw = String(config.updateRepo ?? '').trim() || UPDATE_REPO_DEFAULT;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : '';
}

/** 给 GitHub 的一个请求标上「哪一类失败」，调用方据此填 reason。 */
function updateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 打一个 GitHub JSON 接口。
 * 404 不算异常（`releases/latest` 在没有 Release 的仓库上就是 404，本仓库当前正是如此），
 * 由调用方决定回退；403/429 单独标成 rate-limited，别的错误归 network。
 * @param {string} url @param {typeof fetch} fetchImpl @returns {Promise<{notFound?:boolean,data?:any}>}
 */
async function githubJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `dsh-lifehud/${PLUGIN_VERSION || '0.0.0'}`,
    },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
  });
  if (res.status === 404) return { notFound: true };
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    throw updateError('rate-limited', remaining === '0'
      ? 'GitHub API 限流（未登录每小时 60 次）'
      : `GitHub API 拒绝（HTTP ${res.status}）`);
  }
  if (!res.ok) throw updateError('network', `GitHub HTTP ${res.status}`);
  try {
    return { data: await res.json() };
  } catch {
    throw updateError('bad-payload', 'GitHub 返回的不是 JSON');
  }
}

/** 把异常归成页面认识的 reason。 @param {unknown} error @returns {string} */
function updateReasonOf(error) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : '';
  if (code) return code;
  const name = String((error && error.name) || '');
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network';
}

/**
 * 检查远端有没有新版本。**只在用户点「检查更新」时被调用**（页面加载不自动查）。
 *
 * 数据源：GitHub REST API。先 `/releases/latest`（有 Release 就能拿到发布页与正文），
 * 404 时回退 `/tags`（本仓库当前只有 tag，没有 Release）。取最大语义版本，不取第一个。
 *
 * 失败从不抛给页面：返回上一次成功的结果并标 `stale:true`，从没成功过就返回 `latest:null`。
 * 不做 TTL 缓存：唯一调用方是「手动点按钮」，点了就该真打一次；并发连点由单飞合并。
 * @param {object} [config] bundle row config
 * @param {{fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<object>} snapshot
 */
export async function readUpdate(config = {}, options = {}) {
  const current = PLUGIN_VERSION;
  const repo = updateRepoOf(config);
  const base = {
    ok: true,
    current,
    latest: null,
    hasUpdate: false,
    ahead: false,
    prerelease: false,
    url: repo ? `https://github.com/${repo}/releases` : '',
    source: null,
    publishedAt: null,
    notes: '',
    checkedAt: null,
    cachedAt: null,
    stale: false,
    reason: null,
    repo,
  };
  if (!repo) return { ...base, reason: 'bad-repo' };
  if (config.updateCheck === false) return { ...base, reason: 'disabled' };
  if (typeof options.fetchImpl !== 'function' && typeof fetch !== 'function') {
    return { ...base, reason: 'no-fetch' };
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (updateInflight.has(repo)) return updateInflight.get(repo);

  const run = (async () => {
    const checkedAt = new Date().toISOString();
    try {
      let latest = null;
      let source = null;
      let url = base.url;
      let publishedAt = null;
      let notes = '';

      const release = await githubJson(`https://api.github.com/repos/${repo}/releases/latest`, fetchImpl);
      if (!release.notFound && release.data && typeof release.data === 'object') {
        const tag = String(release.data.tag_name ?? '').trim();
        if (parseVersion(tag)) {
          latest = tag.replace(/^v/, '');
          source = 'release';
          url = String(release.data.html_url ?? '').trim() || `https://github.com/${repo}/releases/tag/${tag}`;
          publishedAt = release.data.published_at ?? null;
          notes = String(release.data.body ?? '').trim().slice(0, UPDATE_NOTES_MAX);
        }
      }
      if (!latest) {
        const tags = await githubJson(`https://api.github.com/repos/${repo}/tags?per_page=${UPDATE_TAGS_PER_PAGE}`, fetchImpl);
        // tags 也 404 → 仓库真的不存在（和「release 没发过」不是一回事）。
        if (tags.notFound) throw updateError('not-found', `仓库 ${repo} 不存在`);
        if (!Array.isArray(tags.data)) throw updateError('bad-payload', 'tags 接口返回的形状不对');
        let best = null;
        for (const item of tags.data) {
          const name = String(item?.name ?? '');
          const parsed = parseVersion(name);
          if (!parsed) continue;
          if (!best || compareVersion(parsed, best.parsed) > 0) {
            best = { name: name.replace(/^v/, ''), parsed };
          }
        }
        if (best) {
          latest = best.name;
          source = 'tags';
          url = `https://github.com/${repo}/tags`;
        }
      }

      const verdict = summarizeUpdate(current, latest);
      const result = {
        ...base,
        latest,
        hasUpdate: verdict.hasUpdate,
        ahead: verdict.ahead,
        prerelease: verdict.prerelease,
        url,
        source,
        publishedAt,
        notes,
        checkedAt,
        cachedAt: checkedAt,
        reason: latest ? null : 'no-tags',
      };
      updateCache.repo = repo;
      updateCache.result = result;
      return result;
    } catch (error) {
      const reason = updateReasonOf(error);
      const previous = updateCache.result && updateCache.result.repo === repo
        ? updateCache.result
        : null;
      if (previous) return { ...previous, stale: true, reason };
      return { ...base, stale: true, reason };
    }
  })();

  const tracked = run.finally(() => { updateInflight.delete(repo); });
  updateInflight.set(repo, tracked);
  return run;
}
export { PLUGIN_VERSION };
