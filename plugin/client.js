/**
 * LifeHud — browser half（B 版：苹果风 · 便当盒）
 *
 * 视觉基调参考 apple.com：
 *   纯黑底 / 卡片 #1c1c1e 无边框 / 大圆角 26px / 标题 13px 灰 / 数字超大 / 发丝线分隔
 *
 * 布局：flex 便当盒，两行
 *   行 1（更高）：天气(宽) · 体重(v1.1.0，可关) · 任务
 *   行 2：专注 · 会话 · 相框 · 热力
 *
 * 重要：这个包可能被执行不止一次（热装插件后 DSH 的 client-modules 会重复求值），
 * 重复调用 __ModuleLoader__.load 会抛 "duplicate factory registration"，
 * 而 DSH 把插件导入失败视为启动致命错误 → 整个 app 起不来。
 * 所以这里做一个幂等哨兵：只注册一次，后续执行直接返回。
 */
if (!window.__lifehudClientRegistered) {
  window.__lifehudClientRegistered = true;
  window.__ModuleLoader__.load({
    id: 'dsh-lifehud',
    factory: (require) => {
      const React = require('react');
      const h = React.createElement;

      const PANEL_ID = 'lifehud';
      const NS = 'lifehud';
      /** 客户端构建标记：改这里 → 页面上能一眼看出加载的是哪一版。 */
      const BUILD = '1.1.1';
      const HUD_URL = '/lifehud/api/hud';
      const WEIGHT_URL = '/lifehud/api/weight';
      const PHOTO_URL = '/lifehud/api/photo';
      const SETTINGS_URL = '/lifehud/api/settings';
      const SESSION_EXISTS_URL = '/lifehud/api/session-exists';
      const SETTINGS_KEY = 'lifehud.settings.v1';

      /* ------------------------------------------------------------ 设计令牌 */

      const T = {
        bg: '#000000',
        card: '#1c1c1e',
        cardHover: '#232325',
        line: '#2c2c2e',
        text: '#f5f5f7',
        text2: '#86868b',
        text3: '#5a5a5e',
        accent: '#2997ff',
        radius: 26,
        radiusSm: 12,
      };

      /** @type {{at:number,value:object}|null} */
      let hudCache = null;
      const HUD_TTL = 60 * 1000;
      /**
       * 定时自动刷新间隔（5 分钟）。
       * 为什么是 5 分钟：一次 /hud 要开 NowTree 的库、扫会话文件、算热力，
       * 30 秒一次等于让后台一直干活、笔记本风扇都听得见；5 分钟够让人「抬头看见变化」，
       * 真着急的时候还有工具条上的「刷新」按钮。
       */
      const HUD_REFRESH_MS = 5 * 60 * 1000;
      let prefetch = null;

      function fetchHud() {
        if (prefetch) return prefetch;
        prefetch = fetch(HUD_URL, { headers: { accept: 'application/json' } })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then((data) => {
            hudCache = { at: Date.now(), value: data };
            prefetch = null;
            return data;
          })
          .catch(() => {
            prefetch = null;
            return null;
          });
        return prefetch;
      }

      function defaultSettings() {
        return {
          background: 'none',
          gradient: 'aurora',
          solidColor: '#000000',
          bgImage: '',
          weatherHours: 8,
          chatUrl: 'https://chat.deepseek.com/',
          weightCard: true,
          // 专注卡采集开关（v1.1.1，默认开）：关掉后专注卡只显示「已关闭」。
          // 和 weightCard 一样存在浏览器 localStorage（同一个键），刷新页面仍然记得。
          // 语义是「这块屏上要不要看采集结果」，不动 Host 侧已有的数据。
          focusCapture: true,
        };
      }

      function readSettings() {
        try {
          const raw = localStorage.getItem(SETTINGS_KEY);
          if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
        } catch { /* ignore */ }
        return defaultSettings();
      }

      function writeSettings(value) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); } catch { /* ignore */ }
      }

      function backgroundStyle(s) {
        const gradients = {
          aurora: 'linear-gradient(135deg, rgba(41,64,92,0.30) 0%, rgba(0,0,0,0) 55%, rgba(78,52,92,0.22) 100%)',
          dusk: 'linear-gradient(160deg, rgba(92,54,54,0.28) 0%, rgba(0,0,0,0) 60%, rgba(46,40,70,0.26) 100%)',
          forest: 'linear-gradient(150deg, rgba(30,68,56,0.26) 0%, rgba(0,0,0,0) 60%, rgba(40,58,42,0.22) 100%)',
        };
        if (s.background === 'gradient') return { background: gradients[s.gradient] ?? gradients.aurora };
        if (s.background === 'solid') return { background: s.solidColor };
        if (s.background === 'image' && s.bgImage) {
          return { backgroundImage: `url(${s.bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' };
        }
        return {};
      }

      function relTime(ms) {
        if (!ms) return '';
        const min = Math.round((Date.now() - ms) / 60000);
        if (min < 1) return '刚刚';
        if (min < 60) return `${min} 分钟前`;
        const hours = Math.round(min / 60);
        if (hours < 24) return `${hours} 小时前`;
        const days = Math.round(hours / 24);
        if (days === 1) return '昨天';
        if (days < 30) return `${days} 天前`;
        return new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      }

      function fmtDuration(minutes) {
        const total = Math.round(minutes);
        const hours = Math.floor(total / 60);
        const mins = total % 60;
        if (hours <= 0) return `${mins} 分钟`;
        if (mins === 0) return `${hours} 小时`;
        return `${hours} 小时 ${mins} 分`;
      }

      /** 'YYYY-MM-DD' → '11/3'（日期标签用，不本地化，纯数字最短）。 */
      function fmtMonthDay(date) {
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date ?? ''));
        if (!m) return String(date ?? '');
        return `${Number(m[2])}/${Number(m[3])}`;
      }

      function useHud() {
        const [state, setState] = React.useState({
          loading: !hudCache, data: hudCache?.value ?? null, error: null,
        });
        const [tick, setTick] = React.useState(0);
        React.useEffect(() => {
          if (tick === 0 && hudCache && Date.now() - hudCache.at < HUD_TTL) return undefined;
          let alive = true;
          prefetch = null;
          fetchHud().then((data) => {
            if (!alive) return;
            if (data) setState({ loading: false, data, error: null });
            else setState({ loading: false, data: hudCache?.value ?? null, error: '请求失败' });
          });
          return () => { alive = false; };
        }, [tick]);

        /**
         * 定时 + 回页自动刷新（v1.1.1）。
         * 以前只有体重卡有后台同步，其余卡片不点「刷新」就一直停在打开页面那一刻的快照上，
         * 天气、任务、会话都可能是几小时前的。这里补上「自己会变」。
         *
         * 刻意做成"安静"的刷新，三道护栏（避免和首屏 prefetch、手动刷新打架）：
         *   1. 页面不可见（切到别的窗口/标签）时一个请求都不发，回来再补；
         *   2. 已经有请求在飞（`prefetch` 非空）就跳过——fetchHud 本身是单飞的，
         *      再调也只是拿回同一个 Promise，这里先挡一道免得重复 setState；
         *   3. 缓存还新鲜（< HUD_TTL）就跳过，避免「刚刷新完定时器紧接着又刷一次」。
         * 失败也不弹错：保留上一次的数据，等下一个周期再试（不要每 5 分钟红条一次）。
         */
        React.useEffect(() => {
          let alive = true;
          const refreshQuietly = () => {
            if (!alive || document.hidden) return;
            if (prefetch) return;
            if (hudCache && Date.now() - hudCache.at < HUD_TTL) return;
            fetchHud().then((data) => {
              if (!alive || !data) return;
              setState({ loading: false, data, error: null });
            });
          };
          const timer = setInterval(refreshQuietly, HUD_REFRESH_MS);
          // 回到页面时补一次：隐藏期间定时器被浏览器降频，这次才是真正的"回页即新"
          const onVisibility = () => { if (!document.hidden) refreshQuietly(); };
          document.addEventListener('visibilitychange', onVisibility);
          // 卸载（离开 LifeHud 页）必须停掉定时器与监听，否则组件没了还在偷偷请求
          return () => {
            alive = false;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisibility);
          };
        }, []);

        return { ...state, reload: () => setTick((v) => v + 1) };
      }

      /* -------------------------------------------------------------- 体重数据 */

      /** @type {{at:number,value:object}|null} */
      let weightCache = null;
      let weightPrefetch = null;
      /** 请求序号：强制刷新后，先前在飞的旧响应作废（只影响缓存写入与返回值的取舍）。 */
      let weightSeq = 0;
      const WEIGHT_TTL = 60 * 1000;

      /**
       * 体重取数：与 fetchHud 同范式（单飞 + 内存缓存 + 失败返回 null）。
       * force=true 时打 ?force=1 跳过 Host 的 10 分钟云缓存，并且不复用/不参与普通单飞。
       */
      function fetchWeight(force) {
        if (!force && weightPrefetch) return weightPrefetch;
        const seq = ++weightSeq;
        const request = fetch(force ? `${WEIGHT_URL}?force=1` : WEIGHT_URL, { headers: { accept: 'application/json' } })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then((data) => {
            if (!force) weightPrefetch = null;
            // 被更新的请求取代 → 丢弃这次结果，避免旧数据回写缓存
            if (seq !== weightSeq) return null;
            if (!data || data.ok === false) return null;
            weightCache = { at: Date.now(), value: data };
            return data;
          })
          .catch(() => {
            if (!force) weightPrefetch = null;
            return null;
          });
        if (!force) weightPrefetch = request;
        return request;
      }

      /** 同 useHud：tick 重取；reload(true) = 强制打云（刷新按钮走这条路）。 */
      function useWeight(enabled) {
        const [state, setState] = React.useState({
          loading: !weightCache, data: weightCache?.value ?? null, error: null,
        });
        const [tick, setTick] = React.useState(0);
        const forceRef = React.useRef(false);
        React.useEffect(() => {
          if (!enabled) return undefined;
          const force = forceRef.current;
          forceRef.current = false;
          // 首次挂载且缓存仍新鲜 → 直接用缓存（模块 apply 里已经预取过一次）
          if (!force && tick === 0 && weightCache && Date.now() - weightCache.at < WEIGHT_TTL) {
            setState({ loading: false, data: weightCache.value, error: null });
            return undefined;
          }
          let alive = true;
          fetchWeight(force).then((data) => {
            if (!alive) return;
            if (data) setState({ loading: false, data, error: null });
            else setState({ loading: false, data: weightCache?.value ?? null, error: '请求失败' });
          });
          return () => { alive = false; };
        }, [tick, enabled]);
        return { ...state, reload: (force) => { forceRef.current = Boolean(force); setTick((v) => v + 1); } };
      }

      /* ---------------------------------------------------------------- 样式 */

      const S = {
        page: {
          padding: '22px 30px 24px', color: T.text,
          height: '100%', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        },
        header: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14, gap: 16, flex: 'none' },
        brand: { fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: T.text },
        headRight: { display: 'flex', alignItems: 'center', gap: 14 },
        clockTime: { fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right', lineHeight: 1.1, letterSpacing: '-0.01em' },
        clockDate: { fontSize: 12, color: T.text2, textAlign: 'right', marginTop: 3 },
        toolbar: { display: 'flex', alignItems: 'center', gap: 18, marginBottom: 18, flex: 'none' },
        tab: {
          fontSize: 13, padding: 0, background: 'none', border: 'none',
          color: T.text2, cursor: 'pointer',
        },
        tabActive: { color: T.text, fontWeight: 600 },
        card: {
          background: T.card, borderRadius: T.radius,
          padding: '20px 24px', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column',
          height: '100%', minHeight: 0, overflow: 'hidden',
        },
        cardTitle: { fontSize: 13, color: T.text2, marginBottom: 14, flex: 'none' },
        item: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, color: T.text, lineHeight: 1.4 },
        dim: { color: T.text3, fontSize: 12 },
        more: { fontSize: 12, color: T.text3, textAlign: 'right', marginTop: 6, flex: 'none' },
        empty: { fontSize: 14, color: T.text3, padding: '8px 0' },
        err: { fontSize: 13, color: '#ff453a', marginBottom: 10, flex: 'none' },
        btn: {
          fontSize: 12.5, color: T.text2, background: 'none',
          border: 'none', padding: '2px 0', cursor: 'pointer',
        },
        toast: {
          position: 'fixed', left: '50%', bottom: 36, transform: 'translateX(-50%)',
          zIndex: 10000, padding: '12px 20px', borderRadius: 14, fontSize: 14,
          background: 'rgba(28,28,30,0.96)', color: T.text,
          border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
          maxWidth: '70vw', textAlign: 'center', backdropFilter: 'blur(20px)',
        },
      };

      const CSS = [
        '@keyframes lifehud-spin{to{transform:rotate(360deg)}}',
        '@keyframes lifehud-toast{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}',
        // 行高：有下限也有上限 —— 下限防止某张卡变矮时整行塌陷，上限防止卡片被拉满。
        '.lh-rows{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:space-between}',
        '.lh-row{display:flex;gap:20px;min-height:0}',
        '.lh-r1{flex:1.15 1 0;min-height:36%;max-height:46%}',
        '.lh-r2{flex:1 1 0;min-height:36%;max-height:48%}',
        '.lh-cell{flex:1 1 0;min-width:0;min-height:0;display:flex}',
        // 卡片必须撑满自己的格子（flex 子项默认按内容宽，会留下一条空白）
        '.lh-cell > div{flex:1 1 auto;min-width:0;min-height:0}',
        '.lh-cell-wide{flex:1.45 1 0}',
        // 热力格子保持正方形，不跟着卡片拉长
        // 热力格子铺满卡片：行高等分，格子随卡片变大（不再只堆在顶部）
        '.lh-heat{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:5px;height:100%}',
        '.lh-heat-cell{border-radius:6px;background:currentColor;min-height:6px}',
        '@media (max-width:900px){',
        '.lh-row{flex-wrap:wrap;max-height:none;gap:16px}',
        '.lh-cell,.lh-cell-wide{flex:1 1 45%}',
        '}',
      ].join('');

      function Card(props) {
        return h('div', {
          className: `lh-cell${props.wide ? ' lh-cell-wide' : ''}`,
          // cellStyle 调的是「格子」的宽度比例（行内 flex 子项），不影响卡片内边距
          style: props.cellStyle ?? undefined,
        },
          h('div', { style: { ...S.card, ...(props.style ?? {}) } }, [
            props.title ? h('div', { key: 'head', style: { ...S.cardTitle, ...(props.titleStyle ?? {}) } }, props.title) : null,
            h('div', {
              key: 'body',
              style: { flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
            }, props.children),
          ]));
      }

      function Spinner() {
        return h('span', {
          style: {
            width: 11, height: 11, borderRadius: '50%', display: 'inline-block', flex: 'none',
            border: '1.5px solid currentColor', borderTopColor: 'transparent',
            animation: 'lifehud-spin 0.9s linear infinite', opacity: 0.8,
          },
        });
      }

      function Toast(props) {
        if (!props.text) return null;
        return h('div', { style: { ...S.toast, animation: 'lifehud-toast .18s ease-out' } }, props.text);
      }

      /* ------------------------------------------------------------ 视觉元素 */

      function WeatherIcon(props) {
        const size = props.size ?? 22;
        const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' };
        const circle = (cx, cy, r, opacity = 0.85) => h('circle', { cx, cy, r, fill: 'currentColor', opacity, key: `c${cx}${cy}` });
        const cloud = (opacity = 0.8) => h('path', {
          key: 'cloud',
          d: 'M6 15.5a3.2 3.2 0 0 1 .4-6.37 4.4 4.4 0 0 1 8.4-.73A3 3 0 0 1 17.8 15.5H6Z',
          fill: 'currentColor', opacity,
        });
        const parts = {
          sun: [circle(12, 12, 4.2), h('g', { key: 'rays', ...common }, [
            h('path', { key: 'u', d: 'M12 2.6v1.8' }), h('path', { key: 'd', d: 'M12 19.6v1.8' }),
            h('path', { key: 'l', d: 'M2.6 12h1.8' }), h('path', { key: 'r', d: 'M19.6 12h1.8' }),
          ])],
          moon: [h('path', { key: 'm', d: 'M15.6 3.4a8.4 8.4 0 1 0 5 11.4 6.6 6.6 0 0 1-5-11.4Z', fill: 'currentColor', opacity: 0.9 })],
          partly: [circle(8.5, 8.5, 3.4, 0.9), cloud(0.75)],
          'moon-cloud': [h('path', { key: 'm', d: 'M13 3.6a6 6 0 0 0 3.8 8.8 5 5 0 0 1-3.8-8.8Z', fill: 'currentColor', opacity: 0.85 }), cloud(0.65)],
          cloud: [cloud(0.8)],
          fog: [cloud(0.6), h('g', { key: 'f', ...common }, [h('path', { key: 'a', d: 'M5 19h14' }), h('path', { key: 'b', d: 'M7 21.5h10' })])],
          drizzle: [cloud(0.8), h('g', { key: 'd', ...common }, [h('path', { key: 'a', d: 'M9 18.5l-1 2' }), h('path', { key: 'b', d: 'M14 18.5l-1 2' })])],
          rain: [cloud(0.8), h('g', { key: 'r', ...common }, [
            h('path', { key: 'a', d: 'M8 18l-1.4 3' }), h('path', { key: 'b', d: 'M12 18l-1.4 3' }), h('path', { key: 'c', d: 'M16 18l-1.4 3' }),
          ])],
          snow: [cloud(0.8), h('g', { key: 's', ...common }, [
            h('path', { key: 'a', d: 'M8 20h.01' }), h('path', { key: 'b', d: 'M12 21h.01' }), h('path', { key: 'c', d: 'M16 20h.01' }),
          ])],
          storm: [cloud(0.8), h('path', { key: 'b', d: 'M13 17l-3 4h3l-1 3 4-5h-3l1-2Z', fill: 'currentColor', opacity: 0.95 })],
        };
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24',
          'aria-hidden': 'true', focusable: 'false', style: { display: 'block' },
        }, parts[props.kind] ?? parts.cloud);
      }

      /** 逐小时条：从 nowIndex 起连续取 count 个（可跨午夜）。尺寸收紧以适配固定行高。 */
      function HourlyStrip(props) {
        const start = Number.isFinite(props.nowIndex) ? props.nowIndex : new Date().getHours();
        const items = (props.hourly ?? []).slice(start, start + (props.count ?? 8));
        if (items.length === 0) return null;
        const today = new Date().getDate();
        return h('div', {
          style: { display: 'flex', justifyContent: 'space-between', gap: 4, paddingTop: 10 },
        }, items.map((p) => h('div', {
          key: p.i ?? `${p.day}-${p.h}`,
          title: `${p.day === today ? '' : '次日 '}${String(p.h).padStart(2, '0')}:00 ${p.text} ${p.t}℃`,
          style: {
            flex: 1, textAlign: 'center', minWidth: 0, padding: '6px 0', borderRadius: 12,
            background: p.i === start ? 'rgba(255,255,255,0.14)' : 'transparent',
          },
        }, [
          h('div', { key: 'h', style: { fontSize: 11, opacity: p.i === start ? 0.95 : 0.6, marginBottom: 5, lineHeight: 1.2 } },
            p.i === start ? '现在' : (p.day !== today ? `次${p.h}时` : `${p.h}时`)),
          h('div', { key: 'i', style: { display: 'flex', justifyContent: 'center' } }, h(WeatherIcon, { kind: p.icon, size: 19 })),
          h('div', {
            key: 't',
            style: { fontSize: 12.5, fontWeight: 600, marginTop: 5, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 },
          }, `${Math.round(p.t)}°`),
        ])));
      }

      /** 专注条形：只保留前 5 条，整行等高分布。 */
      function BarRows(props) {
        const items = (props.items ?? []).slice(0, props.limit ?? 5);
        if (items.length === 0) return h('div', { style: S.empty }, '这段时间还没有记录');
        const max = Math.max(1, ...items.map((i) => i.minutes));
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, height: '100%' } },
          items.map((item) => h('div', {
            key: item.app,
            style: { flex: '1 1 0', minHeight: 34, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
            title: `${item.app} · ${fmtDuration(item.minutes)}`,
          }, [
            h('div', { key: 'top', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 } }, [
              h('span', { key: 'n', style: { fontSize: 14, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.app),
              h('span', { key: 'm', style: { fontSize: 12, color: T.text2, fontVariantNumeric: 'tabular-nums', marginLeft: 8 } }, fmtDuration(item.minutes)),
            ]),
            h('div', {
              key: 'track',
              style: { height: 6, borderRadius: 3, background: T.line, overflow: 'hidden' },
            }, h('div', {
              style: {
                width: `${Math.max(3, (item.minutes / max) * 100)}%`, height: '100%',
                background: T.text, opacity: 0.8, borderRadius: 3,
              },
            })),
          ])));
      }

      /** 当月热力：7 列日历，颜色按当月分位数分档。 */
      function MonthHeat(props) {
        const days = props.days ?? [];
        const now = new Date();
        const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const monthDays = days.filter((d) => d.d.startsWith(prefix));
        if (monthDays.length === 0) return h('div', { style: S.empty }, '本月还没有数据');

        const values = monthDays.map((d) => d.m).filter((m) => m > 0).sort((a, b) => a - b);
        const q = (p) => (values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 0);
        const cuts = [q(0.2), q(0.4), q(0.6), q(0.8)];
        const level = (m) => {
          if (m <= 0) return 0;
          if (m <= cuts[0]) return 1;
          if (m <= cuts[1]) return 2;
          if (m <= cuts[2]) return 3;
          return 4;
        };
        const alpha = [0.07, 0.3, 0.5, 0.72, 0.96];

        const first = new Date(now.getFullYear(), now.getMonth(), 1);
        const lead = (first.getDay() + 6) % 7;
        const byDate = new Map(monthDays.map((d) => [d.d.slice(8), d.m]));
        const total = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const cells = [];
        for (let i = 0; i < lead; i += 1) cells.push({ blank: true, key: `b${i}` });
        for (let day = 1; day <= total; day += 1) {
          const key = String(day).padStart(2, '0');
          cells.push({ day, m: byDate.get(key) ?? 0 });
        }

        return h('div', { className: 'lh-heat' }, cells.map((c) => (c.blank
          ? h('div', { key: c.key })
          : h('div', {
            key: c.day,
            className: 'lh-heat-cell',
            title: `${now.getMonth() + 1}月${c.day}日`,
            style: { opacity: alpha[level(c.m)], color: T.text },
          }))));
      }

      /* ---------------------------------------------------------------- 体重 */

      /** 纵轴候选步长（kg）：优先挑让刻度落在 65.5 / 66.0 这种整数感的步长。 */
      const WEIGHT_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5];
      const WEIGHT_VIEW = { w: 260, h: 84 };
      /**
       * 左侧纵轴数字栏宽度：刻度是 HTML 覆盖层，得给它留出一条 gutter 来。
       * 刻度字号与天气卡逐小时温度一致（12.5），"67.0" 这种 4 字符在 12.5px 下约 26px，
       * 所以栏要留到 34px（含 2px 右内边距）。
       */
      const WEIGHT_GUTTER = 34;
      /** 绘图区上下留白：端点刻度（12.5px 文字，居中于网格线）不至于被卡片裁掉。 */
      const WEIGHT_INSET_Y = 9;
      const WEIGHT_EPS = 1e-6;

      const round6 = (v) => Math.round(v * 1e6) / 1e6;

      /** 点值：最多 2 位小数、去掉末尾的 0（小米秤精度到 0.01，别硬截成 1 位）。 */
      function fmtWeightValue(value) {
        return Number(value.toFixed(2)).toString();
      }

      /**
       * nice 纵轴：固定 4 个刻度（3 段）。
       * 先从 WEIGHT_STEPS 里挑「圆整后正好 3 段」的步长（66 上下：0.5 一步 → 65.5 / 66.0 / 66.5 / 67.0）；
       * 挑不到就用第一个段数 ≤3 的步长，再靠裁边 / 补边收敛到 3 段。
       * y 映射用这个圆整范围、不用数据 min/max —— 刻度是整齐的，点也不会贴到图边上。
       */
      function niceWeightAxis(values) {
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        const span = hi - lo;
        let axis = null;
        for (const step of WEIGHT_STEPS) {
          if (span > step * 3 - WEIGHT_EPS) continue;          // 这个步长太细，段数会超过 3
          const cand = {
            min: round6(Math.floor(lo / step + WEIGHT_EPS) * step),
            max: round6(Math.ceil(hi / step - WEIGHT_EPS) * step),
            step,
          };
          cand.segments = Math.round((cand.max - cand.min) / step);
          if (cand.segments === 3) { axis = cand; break; }     // 正好 4 个刻度，收工
          if (!axis) axis = cand;                              // 先留住最细的合格步长，别被更粗的覆盖
        }
        if (!axis) {                                            // 跨度 >15kg 的兜底：自己算步长
          const step = Math.max(1, Math.ceil((span / 3) * 10) / 10);
          axis = {
            min: round6(Math.floor(lo / step) * step),
            max: round6(Math.ceil(hi / step) * step),
            step,
          };
          axis.segments = Math.round((axis.max - axis.min) / step);
        }
        // 段数 >3 → 裁掉多余的边（数据仍在范围内）；<3 → 上下轮流补边。最终固定 3 段。
        let guard = 0;
        while (axis.segments > 3 && guard < 4) {
          guard += 1;
          if (lo - axis.min >= axis.step - WEIGHT_EPS) axis.min = round6(axis.min + axis.step);
          else if (axis.max - hi >= axis.step - WEIGHT_EPS) axis.max = round6(axis.max - axis.step);
          else break;
          axis.segments -= 1;
        }
        while (axis.segments < 3 && guard < 8) {
          guard += 1;
          if (axis.segments % 2 === 0) axis.min = round6(axis.min - axis.step);
          else axis.max = round6(axis.max + axis.step);
          axis.segments += 1;
        }
        const ticks = [];
        for (let i = 0; i <= axis.segments; i += 1) ticks.push(round6(axis.min + i * axis.step));
        return { min: axis.min, max: axis.max, step: axis.step, ticks };
      }

      /**
       * 曲线布局（纯计算，方便单独验证）：
       * x 取每格中心 (i+0.5)/n —— 与下方 flex:1 的日期标签中心、与点值标签的 left% 三者完全一致；
       * y 用 nice 轴范围归一，同时给出百分比（HTML 覆盖层用）和 viewBox 坐标（SVG 用）。
       */
      function weightLayout(points) {
        const axis = niceWeightAxis(points.map((p) => p.weight_kg));
        const span = axis.max - axis.min || 1;
        const n = points.length;
        const W = WEIGHT_VIEW.w;
        const H = WEIGHT_VIEW.h;
        const yPctOf = (v) => ((axis.max - v) / span) * 100;
        const xPct = points.map((_, i) => ((i + 0.5) / n) * 100);
        const yPct = points.map((p) => yPctOf(p.weight_kg));
        const coords = points.map((_, i) => [(xPct[i] / 100) * W, (yPct[i] / 100) * H]);
        const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
        const area = n >= 2
          ? `${line} ${coords[n - 1][0].toFixed(1)},${H} ${coords[0][0].toFixed(1)},${H}`
          : null;
        const ticks = axis.ticks.map((value) => ({ value, yPct: yPctOf(value) }));
        return { axis, ticks, xPct, yPct, coords, line, area, n };
      }

      /**
       * 悬停标签：同一时刻只显示一个，所以不需要跟邻居做防重叠；
       * 只保留「太靠上就翻到点下方」这一条规则。只显示数值（日期在下方横轴上已经有了）。
       */
      function weightHoverLabel(points, layout, index) {
        if (index === null || index === undefined || index < 0 || index >= points.length) return null;
        const y = layout.yPct[index];
        return {
          key: `${points[index].date}-${index}`,
          text: fmtWeightValue(points[index].weight_kg),
          left: layout.xPct[index],
          top: y,
          below: y < 20,
        };
      }

      /**
       * 折线 SVG：每档刻度一条虚线网格 + 面积淡层 + 一条连续 polyline + 每个点一个圆点。
       * 悬停命中区是「整列矩形」（比 2.3px 的圆点好点中，鼠标不用瞄准），
       * 悬停到的点会放大 + 一条竖向虚线辅助读数。
       */
      function WeightPlotSvg(props) {
        const { ticks, n, coords, line, area } = props.layout;
        const hover = Number.isInteger(props.hoverIndex) ? props.hoverIndex : null;
        const W = WEIGHT_VIEW.w;
        const H = WEIGHT_VIEW.h;
        const grid = ticks.map((t) => h('line', {
          key: `g${t.value}`,
          x1: 0, x2: W,
          y1: round6((t.yPct / 100) * H),
          y2: round6((t.yPct / 100) * H),
          stroke: 'rgba(128,128,128,0.18)',
          strokeWidth: 1,
          strokeDasharray: '2 3',
          vectorEffect: 'non-scaling-stroke',
        }));
        const guide = hover !== null && coords[hover]
          ? h('line', {
            key: 'guide',
            x1: coords[hover][0], x2: coords[hover][0], y1: 0, y2: H,
            stroke: 'rgba(128,128,128,0.35)',
            strokeWidth: 1,
            strokeDasharray: '2 3',
            vectorEffect: 'non-scaling-stroke',
          })
          : null;
        // 每列一个透明矩形做悬停命中区（fill:none + pointer-events:all 一样能收到事件，
        // 而且不用往 SVG 里塞一个「看起来是颜色但其实透明」的 fill）
        const cols = coords.map((_, i) => h('rect', {
          key: `h${i}`,
          x: (i / n) * W,
          y: 0,
          width: W / n,
          height: H,
          fill: 'none',
          stroke: 'none',
          pointerEvents: 'all',
          style: { cursor: 'crosshair' },
          onMouseEnter: () => props.onHover?.(i),
          onMouseLeave: () => props.onHover?.(null),
        }));
        return h('svg', {
          viewBox: `0 0 ${W} ${H}`,
          preserveAspectRatio: 'none',
          width: '100%', height: '100%',
          'aria-hidden': 'true', focusable: 'false',
          style: { display: 'block', flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'visible' },
        }, [
          ...grid,
          guide,
          area
            ? h('polygon', { key: 'area', points: area, fill: 'rgba(128,128,128,0.12)', stroke: 'none' })
            : null,
          n >= 2
            ? h('polyline', {
              key: 'line',
              points: line,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              vectorEffect: 'non-scaling-stroke',
              opacity: 0.92,
            })
            : null,
          ...coords.map(([x, y], i) => h('circle', {
            key: `d${i}`, cx: x, cy: y,
            r: i === hover ? 3.6 : 2.3,
            fill: 'currentColor', stroke: 'none',
            opacity: i === hover ? 1 : 0.95,
            vectorEffect: 'non-scaling-stroke',
          })),
          ...cols,
        ]);
      }

      /**
       * 日期标签：纯 HTML flex 行（不画进 SVG，避免被非等比拉伸变形），与点一一对应。
       * 左侧要让出纵轴 gutter 的宽度，否则整行会比点左移一截、和点中心错位。
       */
      function WeightLabels(props) {
        const points = props.points ?? [];
        return h('div', {
          style: { display: 'flex', flex: 'none', paddingLeft: props.gutter ?? 0, marginTop: 1 },
        }, points.map((p, i) => h('div', {
          key: `${p.date}-${i}`,
          style: {
            flex: 1, minWidth: 0, textAlign: 'center', fontSize: 12.5, lineHeight: 1.4,
            color: 'rgba(128,128,128,0.85)', fontVariantNumeric: 'tabular-nums',
          },
        }, fmtMonthDay(p.date))));
      }

      /**
       * 体重图：左侧纵轴刻度 + 绘图区 + 悬停显示的点值 + 下方日期行。
       * 所有文字都是 HTML 绝对定位覆盖层 —— SVG 用 preserveAspectRatio="none" 做自适应拉伸，
       * 画进 SVG 的 <text> 会被非等比拉变形（这是踩过的坑）。
       * 点值默认不显示（7 个标签并排会挤），鼠标移到某一天上才浮现，字号对标天气卡逐小时的温度。
       */
      function WeightChart(props) {
        const points = props.points ?? [];
        const [hover, setHover] = React.useState(null);
        // 换一批点（刷新 / 换日期窗口）时清掉悬停态，免得标到旧位置上
        React.useEffect(() => { setHover(null); }, [points.length]);
        if (points.length === 0) return null;
        const layout = weightLayout(points);
        const label = weightHoverLabel(points, layout, hover);
        return h('div', {
          style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', marginTop: 6 },
        }, [
          h('div', { key: 'plot', style: { position: 'relative', flex: '1 1 auto', minHeight: 60 } }, [
            h('div', {
              key: 'frame',
              style: { position: 'absolute', left: 0, right: 0, top: WEIGHT_INSET_Y, bottom: WEIGHT_INSET_Y },
            }, [
              // 纵轴刻度数字（右对齐在 gutter 里，vertical 居中于各自的网格线）
              h('div', {
                key: 'axis',
                style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: WEIGHT_GUTTER },
              }, layout.ticks.map((tick) => h('div', {
                key: `t${tick.value}`,
                style: {
                  position: 'absolute', right: 2, top: `${tick.yPct}%`, transform: 'translateY(-50%)',
                  fontSize: 12.5, lineHeight: 1, whiteSpace: 'nowrap',
                  color: 'rgba(128,128,128,0.85)', fontVariantNumeric: 'tabular-nums',
                },
              }, tick.value.toFixed(1)))),
              h('div', {
                key: 'svg',
                style: { position: 'absolute', left: WEIGHT_GUTTER, right: 0, top: 0, bottom: 0, display: 'flex' },
              }, h(WeightPlotSvg, { layout, hoverIndex: hover, onHover: setHover })),
              // 悬停点值：同一时刻只有一个，字号与天气卡逐小时温度一致（12.5 / 600）
              h('div', {
                key: 'vals',
                style: {
                  position: 'absolute', left: WEIGHT_GUTTER, right: 0, top: 0, bottom: 0,
                  pointerEvents: 'none',
                },
              }, label ? h('div', {
                key: label.key,
                style: {
                  position: 'absolute', left: `${label.left}%`, top: `${label.top}%`,
                  // 往上多抬一点（-150% ≈ 与圆点留 ~7px 空隙），读数时不压住那条线
                  transform: `translate(-50%, ${label.below ? '22%' : '-150%'})`,
                  fontSize: 12.5, fontWeight: 600, lineHeight: 1.1, whiteSpace: 'nowrap',
                  color: 'currentColor', fontVariantNumeric: 'tabular-nums',
                },
              }, label.text) : null),
            ]),
          ]),
          h(WeightLabels, { key: 'lbl', points, gutter: WEIGHT_GUTTER }),
        ]);
      }

      function WeightBody(props) {
        const data = props.data ?? null;
        const points = Array.isArray(data?.points)
          ? data.points.filter((p) => p && typeof p.date === 'string' && Number.isFinite(p.weight_kg))
          : [];
        if (!data) return h('div', { style: S.empty }, props.loading ? '加载中…' : '体重数据取不到');
        if (points.length === 0) return h('div', { style: S.empty }, '还没有体重记录');

        const latest = points[points.length - 1];
        // Host 的 reason 有四种：session-expired / network / cloud / local。
        // 都会走到这里的只有「这次没同步成功」，文案要区分清楚，否则会误报「会话过期」。
        const staleText = data.stale === true
          ? ({
            network: '小米云连不上，显示的是本地缓存',
            'session-expired': '小米云会话已过期，请重新登录',
            local: '本地缓存读不到，稍后再试',
            cloud: '小米云返回异常，显示的是本地缓存',
            config: '没找到体脂秤设备，检查小米账号或 miDid',
          }[data.reason] ?? '同步失败，显示的是本地缓存')
          : null;

        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, [
          h('div', {
            key: 'top',
            style: {
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 8, flexWrap: 'wrap', flex: 'none',
            },
          }, [
            h('div', { key: 'n', style: { display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 } }, [
              h('span', {
                key: 'v',
                style: {
                  fontSize: 32, fontWeight: 600, lineHeight: 1, letterSpacing: '-0.03em',
                  fontVariantNumeric: 'tabular-nums',
                },
              }, fmtWeightValue(latest.weight_kg)),
              h('span', { key: 'u', style: { fontSize: 12, color: T.text2 } }, 'kg'),
            ]),
            data.lastSyncAt
              ? h('span', {
                key: 's',
                style: {
                  fontSize: 11, color: T.text2, flex: '0 1 auto', textAlign: 'right',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, `最后同步：${relTime(data.lastSyncAt)}`)
              : null,
          ]),
          h(WeightChart, { key: 'chart', points }),
          staleText
            ? h('div', {
              key: 'stale',
              style: { ...S.err, marginBottom: 0, marginTop: 6, fontSize: 11.5, lineHeight: 1.4 },
            }, staleText)
            : null,
        ]);
      }

      /* ---------------------------------------------------------------- 相框 */

      function PhotoBody() {
        const [src, setSrc] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [err, setErr] = React.useState(null);

        const load = React.useCallback(async () => {
          try {
            const res = await fetch(PHOTO_URL, { cache: 'no-store' });
            if (res.ok) setSrc(URL.createObjectURL(await res.blob()));
            else setSrc(null);
          } catch { setSrc(null); }
        }, []);

        React.useEffect(() => {
          load();
          return () => { setSrc((c) => { if (c) URL.revokeObjectURL(c); return null; }); };
        }, [load]);

        const onPick = async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true); setErr(null);
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(new Error('读取图片失败'));
              reader.readAsDataURL(file);
            });
            const res = await fetch(PHOTO_URL, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data: dataUrl }),
            });
            const payload = await res.json();
            if (!payload.ok) throw new Error(payload.error ?? '上传失败');
            await load();
          } catch (error) {
            setErr(error?.message ?? String(error));
          } finally {
            setBusy(false);
            event.target.value = '';
          }
        };

        const onRemove = async () => {
          setBusy(true);
          try { await fetch(PHOTO_URL, { method: 'DELETE' }); setSrc(null); } finally { setBusy(false); }
        };

        return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, [
          h('div', {
            key: 'f',
            style: {
              flex: '1 1 auto', minHeight: 80, width: '100%', borderRadius: 16, overflow: 'hidden',
              background: T.line, display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
          }, src
            ? h('img', { src, alt: '相框', style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' } })
            : h('div', { style: { fontSize: 13, color: T.text3 } }, '还没有图片')),
          h('div', { key: 'a', style: { display: 'flex', gap: 14, alignItems: 'center', marginTop: 12, flex: 'none' } }, [
            h('label', { key: 'u', style: { ...S.btn, cursor: 'pointer' } }, [
              busy ? '处理中…' : '上传',
              h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onChange: onPick, style: { display: 'none' } }),
            ]),
            src ? h('button', { key: 'd', type: 'button', style: S.btn, onClick: onRemove }, '移除') : null,
            err ? h('span', { key: 'e', style: { ...S.dim, color: '#ff453a' } }, err) : null,
          ]),
        ]);
      }

      /* ------------------------------------------------------------ 设置弹窗 */

      function SettingsDialog(props) {
        const s = props.settings;
        const set = (patch) => props.onChange({ ...s, ...patch });
        const field = { display: 'grid', gap: 8, marginBottom: 20, fontSize: 13.5 };
        const input = {
          width: '100%', boxSizing: 'border-box', padding: '8px 11px', fontSize: 13.5,
          color: T.text, background: '#2c2c2e',
          border: 'none', borderRadius: 10,
        };
        const clock = props.clock ?? {};
        const pill = (active) => ({
          fontSize: 12.5, padding: '6px 14px', borderRadius: 980, border: 'none', cursor: 'pointer',
          background: active ? T.text : '#2c2c2e', color: active ? '#000' : T.text2,
        });
        return h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(6px)',
          },
          onClick: props.onClose,
        }, [
          h('div', {
            style: {
              width: 470, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto',
              background: '#1c1c1e', color: T.text, borderRadius: 22, padding: 24,
              border: '1px solid rgba(255,255,255,0.08)',
            },
            onClick: (e) => e.stopPropagation(),
          }, [
            h('div', { key: 'h', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 22 } }, [
              h('div', { key: 't', style: { fontSize: 19, fontWeight: 600 } }, '设置'),
              h('button', { key: 'x', type: 'button', style: S.btn, onClick: props.onClose }, '完成'),
            ]),

            h('div', { key: 'loc', style: field }, [
              h('div', { key: 'l', style: { color: T.text2 } }, '天气位置'),
              h('div', { key: 'r', style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } }, [
                h('button', {
                  key: 'g', type: 'button', style: pill(false),
                  onClick: () => {
                    if (!navigator.geolocation) { props.onLocateError('浏览器不支持定位'); return; }
                    navigator.geolocation.getCurrentPosition(
                      (pos) => props.onLocate(pos.coords.latitude, pos.coords.longitude),
                      (e) => props.onLocateError(e?.message ?? '定位失败'),
                      { timeout: 8000 },
                    );
                  },
                }, '使用我的位置'),
                props.locationLat ? h('span', { key: 'c', style: S.dim }, `${props.locationLat.toFixed(2)}, ${props.locationLon.toFixed(2)}`) : null,
              ]),
              props.locateError ? h('div', { key: 'e', style: { ...S.dim, color: '#ff453a' } }, props.locateError) : null,
            ]),

            h('div', { key: 'bg', style: field }, [
              h('div', { key: 'l', style: { color: T.text2 } }, '背景样式'),
              h('div', { key: 'r', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                [['none', '无'], ['gradient', '渐变'], ['solid', '纯色'], ['image', '图片 URL']].map(([v, label]) => h('button', {
                  key: v, type: 'button', style: pill(s.background === v),
                  onClick: () => set({ background: v }),
                }, label))),
            ]),

            s.background === 'gradient' ? h('div', { key: 'g', style: field }, [
              h('div', { key: 'r', style: { display: 'flex', gap: 8 } },
                [['aurora', '极光'], ['dusk', '暮色'], ['forest', '森林']].map(([v, label]) => h('button', {
                  key: v, type: 'button', style: pill(s.gradient === v),
                  onClick: () => set({ gradient: v }),
                }, label))),
            ]) : null,

            s.background === 'solid' ? h('div', { key: 'sc', style: field }, [
              h('div', { key: 'l', style: { color: T.text2 } }, '纯色值'),
              h('input', { key: 'i', style: input, value: s.solidColor, onChange: (e) => set({ solidColor: e.target.value }) }),
            ]) : null,

            s.background === 'image' ? h('div', { key: 'bi', style: field }, [
              h('div', { key: 'l', style: { color: T.text2 } }, '背景图片 URL'),
              h('input', { key: 'i', style: input, value: s.bgImage, placeholder: 'https://…', onChange: (e) => set({ bgImage: e.target.value }) }),
            ]) : null,

            h('div', { key: 'misc', style: field }, [
              h('div', { key: 'wh', style: { display: 'flex', gap: 12, alignItems: 'center' } }, [
                h('span', { key: 'l', style: { color: T.text2 } }, '天气显示小时数'),
                h('select', {
                  value: s.weatherHours,
                  onChange: (e) => set({ weatherHours: Number(e.target.value) }),
                  style: { ...input, width: 84 },
                }, [4, 6, 8, 10, 12].map((n) => h('option', { key: n, value: n }, n))),
              ]),
              h('div', { key: 'wc', style: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 10 } }, [
                h('span', { key: 'l', style: { color: T.text2 } }, '体重卡'),
                h('button', {
                  key: 'b', type: 'button', style: pill(s.weightCard !== false),
                  onClick: () => set({ weightCard: s.weightCard === false }),
                }, s.weightCard !== false ? '显示' : '不显示'),
              ]),
              // 专注卡采集开关：和上面「体重卡」同一种写法（两个胶囊状态的按钮），
              // 旧设置里没有这个键 → `!== false` 视为开，升级后默认就有专注卡。
              h('div', { key: 'fc', style: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 10 } }, [
                h('span', { key: 'l', style: { color: T.text2 } }, '专注卡采集'),
                h('button', {
                  key: 'b', type: 'button', style: pill(s.focusCapture !== false),
                  onClick: () => set({ focusCapture: s.focusCapture === false }),
                }, s.focusCapture !== false ? '开启' : '关闭'),
              ]),
              h('div', { key: 'cu', style: { marginTop: 10 } }, [
                h('div', { key: 'l', style: { color: T.text2, marginBottom: 6 } }, '网页对话地址'),
                h('input', { key: 'i', style: input, value: s.chatUrl, onChange: (e) => set({ chatUrl: e.target.value }) }),
              ]),
            ]),

            h('div', { key: 'diag', style: { ...field, borderTop: `1px solid ${T.line}`, paddingTop: 18 } }, [
              h('div', { key: 'l', style: { color: T.text3, marginBottom: 6 } }, `诊断 · v${BUILD}`),
              h('div', { key: 'b', style: { ...S.dim, lineHeight: 1.8 } },
                `时段分界：${clock.boundsSource === 'nowtree' ? '读自 NowTree' : '默认值'} `
                + `${clock.bounds?.morningStart ?? '-'}/${clock.bounds?.noonStart ?? '-'}/${clock.bounds?.eveningStart ?? '-'}`
                + ` · 当前 ${clock.label ?? '-'} ${clock.range ?? ''}`),
              h('div', { key: 'w', style: S.dim }, props.warnings?.length ? `⚠ ${props.warnings.join(' / ')}` : '数据源正常'),
            ]),
          ]),
        ]);
      }

      /* ---------------------------------------------------------------- 页面 */

      function createPage(ctx) {
        return function Page() {
          const { loading, data, error, reload } = useHud();
          const [settings, setSettings] = React.useState(readSettings);
          const [showSettings, setShowSettings] = React.useState(false);
          // 体重卡开关：关掉时既不渲染卡片、也不发 /weight 请求（hook 内部按 enabled 短路）
          const weightOn = settings.weightCard !== false;
          // 专注卡采集开关：关掉时卡片还在原位，但只说「已关闭」——
          // 比整格消失更好懂（用户知道自己是关掉的，而不是坏了）。
          const focusOn = settings.focusCapture !== false;
          const weight = useWeight(weightOn);
          const [locateError, setLocateError] = React.useState(null);
          const [toast, setToastText] = React.useState(null);
          const toastTimer = React.useRef(null);

          const say = React.useCallback((text) => {
            setToastText(text);
            if (toastTimer.current) clearTimeout(toastTimer.current);
            toastTimer.current = setTimeout(() => setToastText(null), 3600);
          }, []);

          React.useEffect(() => () => {
            if (toastTimer.current) clearTimeout(toastTimer.current);
          }, []);

          const onChangeSettings = (value) => { setSettings(value); writeSettings(value); };

          /**
           * 顶部「刷新」：一次动作同时刷新 HUD 快照与体重。
           * 体重这边带 force=1 —— 跳过 Host 的 10 分钟云缓存，刚踩秤的新数据立刻可见。
           * （HUD 侧不动 hudCache：万一这次请求失败，页面还能继续显示上一次的数据。）
           */
          const onRefresh = () => {
            reload();
            weight.reload(true);
          };

          const onLocate = async (latitude, longitude) => {
            setLocateError(null);
            try {
              const res = await fetch(SETTINGS_URL, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ settings: { latitude, longitude } }),
              });
              const payload = await res.json();
              if (!payload.ok) throw new Error(payload.error ?? '保存失败');
              hudCache = null;
              prefetch = null;
              reload();
              say('位置已更新');
            } catch (e) {
              setLocateError(e?.message ?? String(e));
            }
          };

          const openSession = async (session) => {
            let exists = true;
            try {
              const res = await fetch(`${SESSION_EXISTS_URL}?id=${encodeURIComponent(session.id)}`);
              const payload = await res.json();
              if (payload?.ok) exists = payload.exists !== false;
            } catch { /* network hiccup */ }
            if (!exists) {
              say(`「${session.title}」已经不存在了（可能被删除或归档）`);
              return;
            }
            const ui = ctx?.uiWorkspace;
            if (!ui || typeof ui.openSession !== 'function') {
              say('DSH 未暴露会话切换能力，无法跳转');
              return;
            }
            try {
              ui.openSession(session.id);
            } catch (e) {
              say(`打开失败：${e?.message ?? e}`);
            }
          };

          const clock = data?.clock ?? {};
          const tasks = data?.tasks ?? { items: [] };
          const weather = data?.weather;
          const sessions = data?.sessions ?? [];
          const focus = data?.focus;
          const nowMonth = new Date().getMonth() + 1;

          const openChat = () => window.open(settings.chatUrl || 'https://chat.deepseek.com/', '_blank', 'noopener');

          /* ---- 卡片 ---- */
          const weatherCard = h(Card, {
            key: 'weather',
            wide: true,
            style: {
              background: 'linear-gradient(135deg, #0b2545 0%, #123a63 55%, #1d5b8f 100%)',
              color: '#ffffff',
            },
            title: '天气',
            titleStyle: { color: '#9ec6ee' },
          }, weather
            ? h('div', { key: 'wb', style: { display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap', justifyContent: 'center', height: '100%' } }, [
              // 左：大温度 + 一句话；右：连续 8 小时（英雄卡是通栏，横向给足）
              h('div', { key: 'left', style: { flex: '0 0 auto' } }, [
                h('div', { key: 'row', style: { display: 'flex', alignItems: 'baseline', gap: 10 } }, [
                  h(WeatherIcon, { key: 'i', kind: weather.nowIcon ?? 'cloud', size: 26 }),
                  h('div', { key: 'n', style: { fontSize: 46, fontWeight: 600, letterSpacing: '-0.04em', lineHeight: 1 } }, `${Math.round(weather.now)}`),
                  h('div', { key: 'u', style: { fontSize: 16, color: '#c9def5' } }, `℃ ${weather.nowText ?? ''}`),
                ]),
                h('div', { key: 's', style: { fontSize: 13, color: '#c9def5', marginTop: 6 } }, weather.summary),
              ]),
              h('div', { key: 'right', style: { flex: '1 1 380px', minWidth: 0 } },
                h(HourlyStrip, {
                  key: 'hs', hourly: weather.hourly, nowIndex: weather.nowIndex, count: settings.weatherHours,
                })),
            ])
            : h('div', { key: 'e', style: { ...S.empty, color: '#c9def5' } }, '天气取不到'));

          const tasksCard = h(Card, { key: 'tasks', title: '当前时段任务' },
            tasks.items.length === 0
              ? h('div', { key: 'e', style: S.empty }, `${clock.label ?? '这个时段'}没有安排任务`)
              : h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } }, [
                h('div', { key: 'items', style: { flex: 1, minHeight: 0 } },
                  tasks.items.slice(0, 5).map((item) => h('div', {
                    key: item.id, style: { ...S.item, padding: '7px 0' },
                  }, [
                    h('span', { key: 'd', style: { width: 6, height: 6, borderRadius: 3, background: T.text2, flex: 'none' } }),
                    h('span', { key: 't', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
                  ]))),
                tasks.items.length > 5
                  ? h('div', { key: 'm', style: S.more }, `余下 ${tasks.items.length - 5} 条`)
                  : null,
              ]));

          // 专注卡：三种状态 —— 关掉了 / 有数据 / 还没采到。
          // 空态文案不再提 ActivityWatch：数据已改成本机自采集，那个名字对用户只是噪音。
          const focusCard = h(Card, { key: 'focus', title: '专注 · 最近 24 小时' },
            focusOn
              ? (focus?.available
                ? h(BarRows, { items: focus.top, limit: 5 })
                : h('div', { key: 'e', style: S.empty }, '还没有采集到数据'))
              : h('div', { key: 'off', style: S.empty }, '已关闭'));

          const heatCard = h(Card, { key: 'heat', title: `${nowMonth}月活跃热力` },
            h(MonthHeat, { days: data?.heatmap ?? [] }));

          const sessionsCard = h(Card, { key: 'sessions', title: '最近会话' },
            sessions.length === 0
              ? h('div', { key: 'e', style: S.empty }, '还没有会话')
              : h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
                sessions.slice(0, 5).map((s, index) => h('div', {
                  key: s.id + s.at,
                  style: {
                    ...S.item, cursor: 'pointer', flex: '1 1 0', minHeight: 30,
                    borderTop: index === 0 ? 'none' : `1px solid ${T.line}`,
                    borderRadius: 0, padding: '6px 0',
                  },
                  title: '点击打开',
                  onMouseEnter: (e) => { e.currentTarget.style.opacity = '0.65'; },
                  onMouseLeave: (e) => { e.currentTarget.style.opacity = '1'; },
                  onClick: () => openSession(s),
                }, [
                  s.running ? h(Spinner, { key: 'sp' }) : null,
                  h('span', {
                    key: 't',
                    style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 },
                  }, s.title),
                  h('span', { key: 'a', style: { ...S.dim, flex: 'none' } }, relTime(s.at)),
                ]))));

          const photoCard = h(Card, { key: 'photo', title: '相框' }, h(PhotoBody, null));

          // 体重卡：第一行第 2 格（第一行更高更宽，曲线图读起来更舒服）；
          // 关掉时返回 null，整格不占位（第一行自然回到 2 格）。
          // cellStyle 只是「稍微宽一点点」（1 → 1.2 份），比天气卡窄、比任务卡宽。
          const weightCard = weightOn
            ? h(Card, {
              key: 'weight',
              title: '体重',
              cellStyle: { flex: '1.2 1 0' },
            }, h(WeightBody, { data: weight.data, loading: weight.loading }))
            : null;

          // 第一行：天气 + 体重 + 任务
          // 第二行：专注 + 会话 + 相框 + 热力
          const rows = h('div', { key: 'rows', className: 'lh-rows' }, [
            h('div', { key: 'r1', className: 'lh-row lh-r1' }, [weatherCard, weightCard, tasksCard]),
            h('div', { key: 'r2', className: 'lh-row lh-r2' }, [focusCard, sessionsCard, photoCard, heatCard]),
          ]);

          return h('div', { style: { ...S.page, background: T.bg, ...backgroundStyle(settings) } }, [
            h('style', { key: 'css' }, CSS),
            h('div', { key: 'hdr', style: S.header }, [
              h('div', { key: 'b' }, h('div', { style: S.brand }, 'LifeHud')),
              h('div', { key: 'r', style: S.headRight }, [
                h('div', { key: 'c' }, [
                  h('div', { key: 't', style: S.clockTime }, clock.hhmm ?? '--:--'),
                  h('div', { key: 'd', style: S.clockDate }, clock.date ?? ''),
                ]),
              ]),
            ]),

            h('div', { key: 'tb', style: S.toolbar }, [
              h('button', { key: 'ov', type: 'button', style: { ...S.tab, ...S.tabActive } }, '总览'),
              h('button', { key: 'chat', type: 'button', style: S.tab, onClick: openChat, title: settings.chatUrl }, '网页对话 ↗'),
              h('button', { key: 's', type: 'button', style: { ...S.tab, marginLeft: 'auto' }, onClick: () => setShowSettings(true) }, '设置'),
              h('button', { key: 'rf', type: 'button', style: S.tab, onClick: onRefresh }, '刷新'),
              h('span', { key: 'v', style: { fontSize: 11, color: T.text3, marginLeft: 2 }, title: '客户端构建版本' }, `v${BUILD}`),
            ]),

            error ? h('div', { key: 'err', style: S.err }, `数据源异常：${error}（显示上次缓存）`) : null,
            loading && !data
              ? h('div', { key: 'loading', style: S.empty }, '加载中…')
              : rows,

            h(Toast, { key: 'toast', text: toast }),
            showSettings ? h(SettingsDialog, {
              key: 'dlg', settings, onChange: onChangeSettings,
              onClose: () => setShowSettings(false),
              clock, warnings: data?.warnings ?? [],
              locationLat: data?.location?.latitude ?? null,
              locationLon: data?.location?.longitude ?? null,
              onLocate, locateError,
            }) : null,
          ]);
        };
      }

      function PanelIcon(props) {
        const size = typeof props?.size === 'number' ? props.size : 16;
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false',
        }, [
          h('rect', { key: 'a', x: 3.5, y: 3.5, width: 7.5, height: 7.5, rx: 1.6 }),
          h('rect', { key: 'b', x: 13, y: 3.5, width: 7.5, height: 7.5, rx: 1.6 }),
          h('rect', { key: 'c', x: 3.5, y: 13, width: 7.5, height: 7.5, rx: 1.6 }),
          h('rect', { key: 'd', x: 13, y: 13, width: 7.5, height: 7.5, rx: 1.6 }),
        ]);
      }

      function apply(ctx) {
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
            label: () => 'LifeHud',
          }, PanelIcon));
        } catch (error) {
          console.error('[lifehud] sidebar entry registration failed', error);
        }
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: {}, en: {} }), 'lifehud:dictionaries');
        } catch { /* ignore */ }
        try {
          void fetchHud();
        } catch { /* ignore */ }
        try {
          // 体重预取：尊重 localStorage 里的开关（关了就不打 /weight）
          if (readSettings().weightCard !== false) void fetchWeight();
        } catch { /* ignore */ }
        try {
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, createPage(ctx)));
        } catch (error) {
          console.error('[lifehud] main panel registration failed', error);
        }
      }

      return { inject: ['slots', 'locale', 'workspaces', 'sessions', 'uiWorkspace'], apply };
    },
  });
}
