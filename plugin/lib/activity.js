/**
 * 专注 / 热力聚合：读本地 capture.db，按应用聚合最近 24 小时并扣掉 AFK。
 * 从 plugin/index.js 拆出（v1.1.2 评审 S3）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { captureDbPath } from './capture.js';

/**
 * 「连续最长」的合并口径（v1.1.8）：同一应用相邻出现算一段，
 * 中间切走不超过这么久就不算断（换视频 / 回消息再回来还是同一段）。
 * 60 秒够盖住「点开另一个窗口看一眼就回来」，又不至于把上午下午两段完全无关的
 * 使用粘成一段。秒数仍然扣 AFK，所以口径与 top / tracking 一致。
 */
const FOCUS_RUN_GAP_MS = 60 * 1000;

/** Built-in friendly names for the apps the collector sees as `<name>.exe`. */
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
 * Turn a raw `app` (exe name) into something readable.
 *
 * The collector reports the executable name (`Weixin.exe`, `msedge`), which is not
 * how the user thinks about their software. Resolution order: user aliases (config)
 * → built-in aliases → exe name with the extension stripped.
 * @param {string} raw raw app name from the capture DB
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

/**
 * AFK 区间索引：算「一段时间里有多少秒不是 AFK」。
 *
 * 窗口事件本来就是按时间升序扫的，所以游标只前进、不回退：整体 O(窗口数 + AFK 数)，
 * 不是每条事件都把 AFK 全扫一遍。84 天两万条事件下也就几毫秒。
 * @param {Array<[number, number]>} spans AFK 区间（起止毫秒）
 * @returns {(startMs:number, endMs:number) => number} 活跃秒数
 */
function createAfkIndex(spans) {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  return (startMs, endMs) => {
    while (cursor < sorted.length && sorted[cursor][1] <= startMs) cursor += 1;
    let idle = 0;
    for (let i = cursor; i < sorted.length && sorted[i][0] < endMs; i += 1) {
      const lo = Math.max(startMs, sorted[i][0]);
      const hi = Math.min(endMs, sorted[i][1]);
      if (hi > lo) idle += hi - lo;
    }
    return Math.max(0, (endMs - startMs) / 1000 - idle / 1000);
  };
}

/**
 * 解析 `events.data` 原文；坏 JSON 返回 null。
 * 窗口流与 AFK 流都要解析同一列，抽出来免得两处各写一遍 try/catch。
 * @param {unknown} text @returns {object|null}
 */
function parseEventData(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 「没有采集数据」时的空聚合形状。
 * buildHud 的降级分支与 readOwnActivity 的返回契约必须同形——放一处，别各写一份。
 * @returns {{focus:object, heatmap:object[]}}
 */
function emptyActivity() {
  return {
    focus: {
      available: false,
      window: '24h',
      trackingMinutes: 0,
      top: [],
      longest: { app: '', title: '', minutes: 0 },
    },
    heatmap: [],
    idle: {
      window: '24h',
      levels: [
        { level: '0-10', minutes: 0 },
        { level: '10-60', minutes: 0 },
        { level: '60-180', minutes: 0 },
        { level: '180+', minutes: 0 },
      ],
    },
  };
}

/**
 * 本地采集库 → 专注卡的两个数据块：最近 24 小时的应用时长 + 84 天每日活跃分钟。
 *
 * 返回值与 v1.1.0 从 ActivityWatch 取数时**完全同构**（客户端一行都不用改）：
 *   { focus: { available, window: '24h', trackingMinutes, top: [{app, minutes}],
 *              longest: {app, title, minutes} },
 *     heatmap: [{ d, m }] }
 *
 * 两条流在这里合并：window 事件的时长要**扣掉 AFK 区间**，否则锁屏/挂机会把
 * explorer.exe 顶到第一（旧实现踩过这个坑）。迁移来的 AW bucket 与自采集 bucket
 * 都靠 `buckets.type` 覆盖，不用区分 `source`。
 *
 * 每请求开关一次只读连接（不长期持有写句柄）。
 * @param {object} [config] bundle row config
 * @param {number} [days] 热力日历天数
 * @param {Record<string,string>} [aliases] 应用别名
 * @returns {{focus:object, heatmap:object[]}} activity payload
 */
export function readOwnActivity(config = {}, days = 84, aliases = {}) {
  const dbPath = captureDbPath(config);
  if (!existsSync(dbPath)) {
    throw new Error(`本地采集库还没有建立（${CAPTURE_FILE} 会在第一次采样后生成）`);
  }

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rangeStart = new Date(dayStart.getTime() - (days - 1) * 86400000);
  const rangeStartIso = rangeStart.toISOString();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let winRows;
  let afkRows;
  let idleRows;
  try {
    // 采集器（写句柄）随时可能落盘，只读连接也要给 busy_timeout，别一撞锁就报错。
    db.exec('PRAGMA busy_timeout = 3000');
    // duration <= 0 的行是 AW 里没被合并的心跳，保留在库里但不参与聚合，
    // 否则它们会把 top 的应用时长摊薄。
    winRows = db.prepare(`
      SELECT e.ts AS ts, e.duration AS duration, e.data AS data
        FROM events e JOIN buckets b ON b.id = e.bucket_id
       WHERE b.type = 'currentwindow' AND e.ts >= ? AND e.duration > 0
       ORDER BY e.ts`).all(rangeStartIso);
    afkRows = db.prepare(`
      SELECT e.ts AS ts, e.duration AS duration, e.data AS data
        FROM events e JOIN buckets b ON b.id = e.bucket_id
       WHERE b.type = 'afkstatus' AND e.ts >= ? AND e.duration > 0
       ORDER BY e.ts`).all(rangeStartIso);
    idleRows = db.prepare(`
      SELECT e.ts AS ts, e.duration AS duration, e.data AS data
        FROM events e JOIN buckets b ON b.id = e.bucket_id
       WHERE b.type = 'idle' AND e.ts >= ? AND e.duration > 0
       ORDER BY e.ts`).all(rangeStartIso);
  } finally {
    db.close();
  }

  /** AFK 区间（毫秒）。data 是原始 JSON，形状由采集器/迁移决定，必须自己解析。 */
  const afkSpans = [];
  for (const row of afkRows) {
    const data = parseEventData(row.data);
    if (!data || String(data.status) !== 'afk') continue;
    const start = Date.parse(row.ts);
    if (!Number.isFinite(start)) continue;
    afkSpans.push([start, start + Math.max(0, Number(row.duration) || 0) * 1000]);
  }
  const activeSeconds = createAfkIndex(afkSpans);

  /** 本地日期键 `YYYY-MM-DD`。 */
  const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const perDay = new Map();
  const recentByApp = new Map();
  let recentSeconds = 0;
  let considered = 0;
  /** 当前这一段「连续使用」；与最长的段分开记（最长段只留结论，不占内存）。 */
  let run = null;
  let longest = { app: '', title: '', seconds: 0 };
  // 专注卡看的是**滚动 24 小时**：只算「今天」的话，一到晚上早上那段滚出去，
  // 卡片就会显得空。
  const since24 = now.getTime() - 24 * 3600 * 1000;

  for (const row of winRows) {
    const startMs = Date.parse(row.ts);
    const duration = Number(row.duration) || 0;
    if (!Number.isFinite(startMs) || duration <= 0) continue;

    const data = parseEventData(row.data);
    if (!data) continue;

    const endMs = startMs + duration * 1000;
    // 扣掉 AFK 后的活跃秒数。**热力与「最近 24 小时」必须同一口径**：
    // v1.1.0 的老实现只把 AFK 扣进热力，24h 的 tracking/top/longest 用的是原始时长，
    // 于是出现过「tracking 705 分钟、而同一天热力只有 354 分钟」的自相矛盾（2026-11-10 验收发现）。
    const seconds = afkSpans.length > 0 ? activeSeconds(startMs, endMs) : duration;
    // AFK 区间不精确切分到事件内部，按占比例摊到整段上：热力与 24h 数字用同一个比例，
    // 就不会再出现两套口径打架。
    const activeRatio = seconds / duration;

    // 锁屏 / 桌面焦点在窗口流里是 explorer.exe + "Program Manager"，不是真实工作。
    // 光靠 AFK 抓不住（机器可能被锁屏而不是空闲），所以把这个明显的空转段丢掉。
    const appName = String(data?.app ?? '未知');
    const titleName = String(data?.title ?? '');
    if (/^explorer\.exe$/i.test(appName) && /program manager/i.test(titleName)) continue;

    // 整段都在 AFK 里的事件对「活跃秒数」没有贡献（老实现这里直接 continue）：
    // 不进热力、不算「有没有数据」，但**仍然参与下面的连续段合并**——
    // 否则「看视频看到被判离开」会把一段连续使用切断。
    if (seconds >= 1) {
      considered += 1;
      perDay.set(dayKey(startMs), (perDay.get(dayKey(startMs)) ?? 0) + seconds);
    }

    // 只算落在 24 小时窗口里的那一段，再乘活跃占比（同样是扣 AFK 后的口径）。
    const overlap = Math.max(0, (Math.min(endMs, now.getTime()) - Math.max(startMs, since24)) / 1000);
    const inside = overlap * activeRatio;

    // ---- 「连续最长」的合并（v1.1.8）----
    // 老口径 = 单个窗口事件：换个视频、标题一变就断，于是 27 分钟的连续观看被切成好几段，
    // 最长那段只剩 10 分钟（2026-11-20 用户看不懂「最长：哔哩哔哩 · 10 分钟」）。
    // 新口径：同一应用相邻出现就合成一段，中间切走不超过 FOCUS_RUN_GAP_MS 不算断。
    // 秒数仍然是**扣掉 AFK** 的（与 top / tracking 同一口径），所以「开着页面去吃饭」不会赢。
    const continues = run && run.app === appName && startMs - run.endMs <= FOCUS_RUN_GAP_MS;
    if (continues) {
      run.endMs = Math.max(run.endMs, endMs);
      run.seconds += Math.max(0, inside);
    } else {
      run = { app: appName, endMs, seconds: Math.max(0, inside), title: '', bestTitleSeconds: 0 };
    }
    // 段内最活跃的那个标题拿去做 tooltip（比「第一段的标题」更能代表整段）。
    if (titleName && Math.max(0, inside) > run.bestTitleSeconds) {
      run.title = titleName;
      run.bestTitleSeconds = Math.max(0, inside);
    }
    if (run.seconds > longest.seconds) {
      // 与 top 同一套显示名（别名），别让同一个应用在卡片里有两个名字。
      longest = { app: appDisplayName(appName, aliases), title: run.title, seconds: run.seconds };
    }

    if (inside < 1) continue;
    recentSeconds += inside;
    recentByApp.set(appName, (recentByApp.get(appName) ?? 0) + inside);
  }

  // 空闲强度（第三条流）：只累加落在 24h 窗口里的部分，按离散档位分组。
  // 这是给 1.2 详情页 / 「今天有多专注」留的原料，现有专注卡不消费它。
  const IDLE_LEVELS = ['0-10', '10-60', '60-180', '180+'];
  const idleTotals = new Map();
  for (const row of idleRows) {
    const data = parseEventData(row.data);
    if (!data) continue;
    const level = String(data.level ?? '');
    if (!IDLE_LEVELS.includes(level)) continue;
    const startMs = Date.parse(row.ts);
    if (!Number.isFinite(startMs)) continue;
    const endMs = startMs + Math.max(0, Number(row.duration) || 0) * 1000;
    const overlap = Math.max(0, (Math.min(endMs, now.getTime()) - Math.max(startMs, since24)) / 1000);
    if (overlap < 1) continue;
    idleTotals.set(level, (idleTotals.get(level) ?? 0) + overlap);
  }

  // 固定 84 天、升序、一天不缺：热力日历靠这个「没有断档」才有意义。
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
      // 一条窗口事件都没有（刚装、还没采到）就是「没数据」，别假装可用。
      available: considered > 0,
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
    idle: {
      window: '24h',
      levels: IDLE_LEVELS.map((level) => ({
        level,
        minutes: Math.round((idleTotals.get(level) ?? 0) / 6) / 10,
      })),
    },
  };
}
export { emptyActivity };
