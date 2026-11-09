# AGENTS.md — dsh-lifehud 协作手册

> 给接手的 AI：读这一份就能继续开发。**只写长期稳定的事实**，版本细节写 `spike/RESULT.md`。
> 最后更新：2026-11-09 ｜ 插件版本：1.1.0

---

## 1. 这是什么

**LifeHud** 是长在 DeepSeek Harness（DSH）里的个人工作台：一块「抬头就能看见」的页面。
它自己**不产生数据**，只把已有的东西聚到一屏：NowTree 的任务、Open-Meteo 的天气、DSH 的会话、ActivityWatch 的专注。

- 语言：**纯 JavaScript（ESM）**，零第三方依赖，不打包、不编译
- 前端：`React.createElement`（**不要写 JSX**，这里没有编译器）
- **仓库里不写任何人的绝对路径**：能推导的都推导（`%APPDATA%` / `%LOCALAPPDATA%` / `~`），见 `plugin/index.js` 顶部的「默认路径」一节与 `spike/paths.mjs`

## 2. DSH 是怎么读到这个插件的（关键机制）

```
<仓库>/plugin/                              ← 插件包（package.json 里带 dsh.bundle / dsh.client）
        │  plugin_manager(install_bundle) 把本地路径 link 进 profile
        ▼
%USERPROFILE%\.dsh\profiles\<profile>\package.json
        dependencies: "dsh-lifehud": "link:<仓库>/plugin"
        dsh.profile.bundles: [ …, "dsh-lifehud" ]
        │  DSH 启动时读 profile
        ▼
cordis.patch.yml  (dsh.bundle.patch)  → 注册 Host 侧的那一行（index.js 的 apply）
package.json 的 dsh.client + exports["./client"] → 浏览器加载 client.js
```

要点：

- **Host 侧（`index.js`）**：`apply(ctx, config)`，用 `ctx.inject(['webServer'], …)` 注册 HTTP 路由。
- **Client 侧（`client.js`）**：`window.__ModuleLoader__.load({ id, factory })`，用 `ctx.slots.register` 往 `sidebar.panellist`（侧栏入口）和 `main`（页面）注册。
- 配置（数据库路径、weather 默认坐标）写 `plugin/cordis.patch.yml` 的 `config` 里，Host 启动时以第二个参数传入。
- **装/换插件不需要重启 DSH**，但 **Host 代码改动要重新加载**：`plugin_manager(remove_bundle)` → `plugin_manager(install_bundle)`。直接再 install 会报 `already-installed`。
- **Client 改动只需刷新页面**（Ctrl+R）。

## 3. 目录

```
plugin/            ← 唯一会被 DSH 加载的东西
  package.json     dsh.bundle / dsh.client / exports
  cordis.patch.yml Host 行的 config（默认值都在代码里推导，这里通常不用改）
  index.js         Host：HTTP 路由 + 五个数据源
  client.js        浏览器：设置、卡片、渲染
spike/             探查脚本与结论（probe-*.mjs、paths.mjs、RESULT.md）
docs/              ADR（架构决策）+ 小米云取数方法
```

> 作者的私人调研笔记、心智记录、布局原型**不在这个公开仓库里**——公开的部分只包含"能跑的东西 + 说明它为什么这么做"。

## 4. 数据源契约（都是只读）

| 源 | 位置 | 取法 | 注意 |
|---|---|---|---|
| NowTree 任务 | `%APPDATA%\com.nowtree.app\nowtree.sqlite` | `node:sqlite`（Node 24 内置）`readOnly` 打开，**每请求开关一次** | 表 `transactions`；`status='active'`、`deleted=0`、按 `time_slot` 过滤 |
| NowTree 时段分界 | `%LOCALAPPDATA%\com.nowtree.app\EBWebView\Default\Local Storage\leveldb` | 字节搜索 `nowtree_slot_bounds`，取后面的 `{"morningStart":…}` | 值可能是 UTF-16，用 latin1 + 正则兜底；读不到就回退 6/13/18 |
| 天气 | `https://api.open-meteo.com/v1/forecast` | 无需 key；`hourly=temperature_2m,precipitation_probability,weather_code,is_day` | Host 缓存 10 分钟；换位置后置空缓存 |
| DSH 会话 | `$DSH_HOME/storages/session_projcache/sessions/session-<uuid>.json` | 读 json，`rows.title.val` + `rows.sessionListMetadata.val.lastPromptAt` | **sessionId 就是文件名里的 uuid**（去掉 `session-` 前缀）。不要解压 `session.v4.jsonl.zstd` |
| ActivityWatch | `http://127.0.0.1:5600` | `/api/0/buckets/` 找 bucket，再取 `.../events?start=&end=` | `/api/0/query/` 传中文 bucket 名会 400，用 events 端点自己聚合；**必须减掉 AFK 区间**，否则 explorer.exe 会占几百分钟 |
| 体重 | 小米云 `https://api.io.mi.com/app/user/get_user_device_data` | POST，`type=weight` / `key=bodyInfo` / `group=raw`，**时间单位是秒**；RC4 签名 + 会话文件 | 会话默认读 `<dataDir>/mi-session.json`（**不进 git**）；设备号**自动发现**（`/home/device_list` 里 model 带 `scales` 的那台），不写死；`weightId` 必须按 TEXT 存；Host 每 10 分钟自动同步，`?force=1` 跳过 TTL。细节见 `docs/小米云取数.md` |

## 5. 约定（照做）

1. **零依赖**。不要 `pnpm add`：这个插件靠 Node 内置模块 + 原生 fetch 跑。
2. **所有路由必须自己鉴权**。DSH **不会**给插件路由加会话保护——页面 `/` 返回 401，但 `/lifehud/api/*` 是裸的。现有做法：`isLocalPeer(req)` 只放行 `127.0.0.1 / ::1 / ::ffff:127.0.0.1`。新增路由必须照抄。
3. **不写任何外部数据源**。NowTree 的库、AW 的库、DSH 的会话全部只读；LifeHud 自己的可写状态只放在 `dataDir`（默认 `~/.dsh/lifehud`）。
4. **界面文案中文**（"LifeHud" 这个品牌名除外，保持英文）。
5. **主题适配**：只用 `currentColor` 和 `rgba(128,128,128,α)`，不写死颜色，深/浅主题都要看一眼。
6. **改 Host 就重新装一次**（remove → install），**改 Client 就刷新页面**。
7. 新增卡片 = 在 Host 的 `buildHud` 里加一个数据块 + 在 Client 的 `cards.push(...)` 里加一张卡；别忘了设置里的开关。
8. 每次改动**自己先跑一遍** `node --check plugin/client.js`，再用 `spike/probe-hud.mjs` 之类独立脚本验证 Host 逻辑——不要靠"打开页面看看"。

## 6. 坑（踩过的）

- **Host 代码没有热更新**。改完必须 remove + install，否则你以为改了其实没生效。
- **插件路由不设防**（见约定 2）。
- **NowTree 的 `time_slot` 语义**：库里 58 条 active，但符合 NowTree 自身"Next"语义的只有 2 条。本插件的口径是**用户视角**——只要 `time_slot` 命中当前时段就显示，另用 `NEXT` 徽标标出哪些在 NowTree 的 Next 里。
- **AW 事件量**：一天 500+ 条正常，`limit=20000` 足够；不要按秒刷。
- **`window.open`** 在 DSH 里能打开外部网页（网页对话卡就是这么做的），但不能 iframe 站外页面（会被 X-Frame-Options 拒绝）。
- **会话点击跳转**走 `ctx.get('uiWorkspace')?.openSession(id)`（原生侧栏就是这么调的）。若拿不到会 `console.warn`，需要在浏览器控制台确认。
- **Node 24 没有 RC4**。`createCipheriv('rc4', …)` 抛 `digital envelope routines::unsupported`（OpenSSL 3 不带 legacy provider），所以小米云那段是**纯 JS RC4**，且必须**先吃掉 1024 字节密钥流**才和 `micloud` 对得上。
- **小米云的响应可能是密文**。不以 `{`/`[` 开头时要用同一个 `signed_nonce` 解密，别直接 `JSON.parse`。
- **`weightId` 是毫秒时间戳但必须当文本**：JSON.parse 会把它变成 number（`1786238280146`），一旦写进库成 `1786238280146.0` 就再也去不了重。
- **体重曲线是「最近有数据的 7 个测量日」**，不是连续 7 天：同一天多次只留最后一次，日期可以不连续，折线仍是一条连续 polyline（缺失日不断开）。
- **DSH Web 端口每次启动都会变**（2026-11-09 一天内就从 `59098 → 51879 → 55910 → 50073` 变过几次）。spike / 探针脚本里**别硬编码端口**：要么从运行时上下文取，要么把 URL 做成参数（`node spike/probe-weight.mjs http://127.0.0.1:<端口>`），否则重启一次就全红。
- **体重卡的图表不能用 SVG `<text>`**：SVG 走 `preserveAspectRatio="none"` 做自适应拉伸，`<text>` 会被非等比拉变形。所有文字（纵轴刻度、点值、日期）一律用 HTML 绝对定位覆盖层。

## 7. 当前状态

- ✅ 七张卡：当前时段任务、天气（逐小时图标）、最近会话（运行中转圈 / hover 高亮 / 点击跳转）、专注（横向条形图）、热力日历（当月 · GitHub 风格）、相框、**体重（v1.1.0：最近有数据的 7 个测量日 · 手写 SVG 折线）**。
  「网页对话 ↗」是工具条上的外链按钮（`window.open`），**不是卡片**。
- ✅ 布局：flex 便当盒两行 —— 行 1 = 天气(宽) · 体重 · 任务；行 2 = 专注 · 会话 · 相框 · 热力。
  （体重与热力 2026-11-09 换过位置：体重进更高的第一行、热力下到第二行第四格。）
  体重卡用 `Card` 的 `cellStyle` 给了 `flex: 1.2 1 0`（比任务卡略宽），要再调就改这一个数。
- ✅ 设置窗口：背景（无/渐变/纯色/图片 URL）、天气小时数、**体重卡开关**、网页对话地址、定位、诊断。
  这些界面设置存在浏览器 **localStorage**（键 `lifehud.settings.v1`）；Host 侧的 `lifehud-settings.json` 只存 `latitude/longitude/locationName/appAliases`。
- ✅ 开机预热：Host `apply()` 里先跑一次 `buildHud` + `readWeight`；Client 加载时 `fetchHud()` / `fetchWeight()` 预取。
- ✅ 体重同步：Host 每 10 分钟自动拉一次小米云（定时器可 dispose）；页面「刷新」按钮带 `?force=1` 立即拉，**这是"刚踩秤就能看到"的主路径**。
- ⚠️ 「打开 DSH 就默认停在这一页」与「自动收起侧边栏」**尚未实现**：DSH 的 layout/sidebar 服务没有公开的"设默认页 / 强制收起"接口，需要单独 spike。
- ⚠️ 天气的"一句话"是规则拼的，不是模型生成。

### 体重卡怎么工作（v1.1.0，重要）

**数据流**（注意：体重**不进** `buildHud`，避免每次开页面都打小米云）：

```
小米云 /home/device_list                 → 自动找 model 带 scales 的设备号（缓存进 meta）
   └→ user/get_user_device_data
      └→ Host pullWeight()              RC4 签名 + 会话文件（docs/小米云取数.md）
         └→ saveWeightRows()            按 weight_id upsert 到 <dataDir>/lifehud-weight.db
            └→ readWeightLocal()        取最近有数据的 7 个测量日（同日取最后一次，升序）
               └→ GET /lifehud/api/weight [?force=1]  → {ok,stale,reason,lastSyncAt,points[]}
                  └→ Client fetchWeight()/useWeight() → WeightBody → 体重卡
```

- **零配置**：会话文件放 `<dataDir>/mi-session.json`，设备号自动发现——不需要任何人的绝对路径或设备号写进仓库。

- **同步节奏**：Host `apply()` 启动即预热，之后每 `weightTtlMs`（默认 10 分钟）**force** 拉一次；
  页面顶部「刷新」= `reload()`（HUD）+ `weight.reload(true)`（带 `?force=1` 跳过 TTL）——**这是"刚踩秤就看见"的主路径**。
- **降级**：云不可达 / 会话过期 / 本地库报错 → 返回 `stale:true` + 本地缓存点，卡片照常画曲线，按 `reason` 显示不同提示（`session-expired` 要用户重新登录）。
  云**成功但回 0 条**时不会伪造新鲜度：本地有历史就标 `stale:'cloud'`，也不刷新 `lastSyncAt`。
- **图表规格（用户验收要求，别退回去）**：
  1. **一条**连续 polyline 穿过全部点，缺失日不断线（点之间等距，x 取每格中心 `(i+0.5)/n`）；
  2. **左侧纵轴 + 刻度数字**：4 档 nice 刻度（`0.1/0.2/0.25/0.5/1/2/5` 里挑 step），y 映射用圆整范围而不是数据 min/max，每档一条虚线网格；刻度字号 `12.5px`（与天气卡逐小时温度同档），所以左侧要留 **34px** 的 gutter；
  3. **点值默认隐藏，鼠标悬停才显示**（2026-11-09 按用户反馈调整）：鼠标移到某一天所在的整列（SVG 里每列一个 `rect`，`fill:none` + `pointer-events:all`）→ 该点放大 + 竖向虚线 + **只显示数值**的标签（`12.5px / 600`；最多 2 位小数去尾零，如 `66.5` / `66.02`；**不要带日期**，日期横轴上已经有）。顶部大数字同一精度口径；
  4. 底部日期标签行：字号同样 `12.5px`、颜色 `rgba(128,128,128,0.85)`，与点中心对齐（日期行要让出纵轴 gutter 的 34px）；
  5. 颜色只用 `currentColor` / `rgba(128,128,128,α)`，深/浅主题都要能读。
- **改它的入口**：`client.js` 的 `useWeight` / `WeightChart` / `WeightBody`；Host 侧 `readWeight`（`plugin/index.js`）。
- **验证**：`node spike/probe-weight.mjs`（46 项，含幂等/缺失日/stale/TTL/路由契约）。

### 内嵌网页是怎么做到的（重要）

**不是 iframe**（站外页面会被 `X-Frame-Options` 拒绝），而是走 DSH 桌面版 preload 暴露的 webview 桥：

```js
const bridge = globalThis.dshDesktop?.protocolVersion === 1 ? globalThis.dshDesktop.browser : null;
const { lease, partition } = await bridge.acquire('lifehud');   // 向 Electron 主进程申请 guest
const view = document.createElement('webview');
view.setAttribute('name', lease);
view.setAttribute('partition', partition);
view.setAttribute('src', `about:blank#${lease}`);
host.appendChild(view);
view.addEventListener('dom-ready', () => view.loadURL(url));
// 卸载时：view.remove(); bridge.release(lease)
```

主进程在 `will-attach-webview` 里校验 lease/partition 才真正挂载，所以隔离策略与内置侧栏浏览器一致。
**只有 DSH 桌面版可用**，网页版必须在 `globalThis.dshDesktop` 缺失时降级为「在系统浏览器打开」。
参考实现：[Jakcet/dsh-dschat](https://github.com/Jakcet/dsh-dschat)。

## 8. 下一步候选

1. 默认页 / 侧栏收起（需要 spike DSH 的 layout 服务）。
2. 会话卡点击跳转的兜底方案（若 `uiWorkspace` 不可达）。
3. 体重 v2：体脂 / 肌肉 / BMI 人形图（`weight.raw_json` 已经把 40 个字段全存下来了）、体重目标线。
4. HUD 快照自动刷新（目前只有体重有定时同步，其余靠手动「刷新」）。
5. 热力日历换指标（当前是 AW 的每日活跃分钟；token 需自建日表）。

## 9. 与用户协作的方式

- 用户不是科班出身，**先讲清楚再动手**；术语要给类比。
- 用户偏好：**先讨论取舍，再做**；每一步给出"怎么验收"。
- 不要擅自删除用户数据、不要擅自改产品方向。
- 交付时说明：改了什么、怎么验、还有什么没做。
- **绝不用 PowerShell 的 `Get-Content`/`Set-Content`/`-replace` 改源码文本**（会破坏 UTF-8，本项目已因此两次弄坏 `client.js` 并让 DSH 启动崩溃）。一律用编辑工具或 `write` 重写文件。

## 10. 提交规范

**格式：`<type>[-<scope>]: <一句话>`**（2026-11-07 起启用）

| type | 用途 |
|---|---|
| `feat` | 新增功能模块或核心功能点 |
| `fix` | 修复功能 Bug |
| `docs` | 文档变更 |
| `style` | 代码格式调整（不影响功能逻辑） |
| `refactor` | 代码重构（不新增功能、不修复 Bug） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `build` | 构建流程或外部依赖变更 |
| `ci` | 持续集成配置变更 |
| `chore` | 辅助工具或构建流程变更 |
| `revert` | 代码回退 |

- scope 可选，用连字符接在 type 后：`feat-cards:` `fix-layout:` `docs:` `perf-aw:`
- 冒号后一句中文，说清"改了什么"。
- **版本号不写进提交信息**——版本只体现在 git tag 与 Release 标题上。
- 例：`feat: 新增热力日历卡片`、`fix-layout: 图片删除后整行塌陷`、`docs: 补充提交规范`
- 一次提交只做一件事。

### 提交 / 推送流程（用户明确要求）

1. 开发与自测完成后：**本地** `git commit`（按上面的格式），需要发版时再打 tag（`v1.1.0`）。
2. **不要自行 `git push`**。用户在 DSH 页面上验收通过之后，才由用户（或用户点头后）推送。
3. 三处版本号保持一致：`plugin/package.json` 的 `version`、`client.js` 的 `BUILD`、git tag（如 `v1.1.0`）。
4. 交付给用户时必须写清：**改了什么 / 怎么验（具体点哪里、看什么）/ 还有什么没做**。
5. 同一版内来回微调（加刻度 → 换位置 → 悬停 → 调字号…）会产生一串碎 commit，**验收前允许 squash**：
   `git reset --soft <上一个已推送的提交>` → 按「功能 / 测试 / 文档」三类重新 `git commit`，再 `git tag -f` 指回新提交。
   注意：只有在**未 push** 时才能这么干；压完用 `git diff <旧HEAD> HEAD --stat`（应为空）证明内容零变化。

## 11. 发布 / 开源前自查

这个仓库要能被别人跑起来、又不能带出作者的个人信息，所以发布前跑：

```bash
node spike/prepublish-check.mjs      # 扫 PII：绝对路径 / 用户名 / 邮箱 / 设备号 / 会话文件
```

必守：

- **绝不提交** `mi-session.json`、`lifehud-weight.db`、`lifehud-settings.json`、`.env`（`.gitignore` 已挡）；
- 文档里写路径一律用 `%APPDATA%` / `%LOCALAPPDATA%` / `~` / `<仓库>` 这类占位，不写某台机器的绝对路径；
- 代码里的默认值必须是**推导**出来的（`process.env.APPDATA`、`homedir()`），不是写死的；
- 不把任何人的设备号（`blt.3.*`）、账号 id、token 写进代码或文档；
- commit 身份用 GitHub noreply 邮箱，别用真实邮箱：
  `git config user.email "<你的数字 id>+<用户名>@users.noreply.github.com"`。

> 历史也公开的话，光清工作树没用。这个仓库就是用**一个初始 commit** 发布的：
> 作者的私有仓库留完整开发历史，公开仓库只保留干净的起点。

