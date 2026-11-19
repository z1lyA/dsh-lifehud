# Spike 结果：DSH 插件能不能画出页面 + 能不能读 NowTree

- 日期：2026-11-04（晚间第二轮迭代后更新）
- 目标：只验证技术假设，再按用户反馈做界面形态迭代
- 结论：**核心假设全部成立**，而且 host / client 都能热更新，不需要重启 DSH

## S0 摸底

| 项 | 值 |
|---|---|
| Node | v24.18.0（自带 `node:sqlite`，不需要装依赖） |
| `$DSH_HOME` | `%USERPROFILE%\.dsh` |
| NowTree 库 | `%APPDATA%\com.nowtree.app\nowtree.sqlite` |
| NowTree 时段配置 | `…\EBWebView\Default\Local Storage\leveldb`（`nowtree_slot_bounds` → `6/13/18`） |
| DSH Web | 运行时端口会变（本轮验证用 `127.0.0.1:58541`） |

## 逐步结果

| 步骤 | 状态 | 证据 |
|---|---|---|
| **S1 插件安装** | ✅ | `plugin_manager install_bundle` 成功；`profiles/desktop/package.json` 里出现 `dsh-lifehud: link:…` |
| **S2 host 路由** | ✅ | `GET /lifehud/api/hud` → 200 + 完整 JSON（任务 + 天气 + 会话） |
| **S3 读 NowTree** | ✅ | `node:sqlite` 只读打开成功；按当前时段查到 3–4 条任务 |
| **S3b 读时段分界** | ✅ | 从 WebView2 的 LevelDB 里字节搜索 `nowtree_slot_bounds`，解析出 `6/13/18` |
| **S4 天气** | ✅ | Open-Meteo 逐小时温度 / 降水概率 / **WMO 天气码 / is_day**，带 10 分钟缓存 |
| **S5 最近会话** | ✅ | 读 `$DSH_HOME/storages/session_projcache/sessions/*.json`，取标题 + `lastPromptAt`，倒序 5 条，**返回真实 sessionId** |
| **S6 设置/背景/相框** | ✅ | 设置存 localStorage；相框图片存 `$DSH_HOME/lifehud/lifehud-photo.bin`（≤2 MB） |
| **S1' client 页面** | ⏳ 待刷新确认 | 侧栏入口 + 2 列卡片 + 设置窗口 + 相框 |

## 五个值得记住的发现

1. **装插件不需要重启 DSH。** 安装后 host 路由立刻可用。
2. **host 代码改动可以热更新——方法是 remove + install。** 第二次直接 install 会报 `already-installed`；先 `remove_bundle` 再装，新 host 模块会重新加载。实测旧路由变 404、新路由立刻 200。
3. **插件路由不受会话鉴权保护。** 页面 `/` 返回 401，但 `/lifehud/api/hud` 直接 200。**必须自己加防护**——已加 loopback 地址校验。
4. **NowTree 的时段分界线是"可读的外部配置"。** 它存在 WebView2 localStorage 的 LevelDB 里，值是纯 ASCII JSON，字节搜索即可取到，不用改 NowTree 一行。
5. **"每次点击都在等"的原因**：每次进页面都重新请求 Open-Meteo（国内直连海外 API 有几百毫秒到数秒）。已加两道缓存：host 端天气 10 分钟、client 端 HUD 快照 60 秒。**首次仍会等一次，之后秒开。**

## 本轮按用户反馈改了什么

| 反馈 | 处理 |
|---|---|
| 每次点击都要加载 | 双层缓存（host 天气 10 分钟 + 客户端 HUD 60 秒），按钮改成「刷新数据」 |
| 时段分界线别挂在页面上 | 移入「设置」窗口 → 诊断信息；页面页脚只留刷新按钮 |
| 删掉 `2026-11-05` / `06:00–13:00` / `早·` | 任务卡标题改为「当前时段任务」，不再显示日期、范围、时段前缀；日期仍留在顶栏 |
| 天气改成手机风格 | 逐小时图标（晴/多云/雨/雪/雾/雷雨，区分昼夜）+ 温度 + 一句话，去掉温度曲线 |
| 自定义背景 | 设置窗口：无 / 渐变（3 套）/ 纯色 / 图片 URL |
| 相框卡片 | 新增，可上传/移除图片，服务端存文件（不塞 localStorage） |
| 最近对话点开跳转 | 已接 `ctx.get('uiWorkspace')?.openSession(id)`；**待刷新后实测**，若 DSH 未把该 service 暴露给插件则会降级为 console.warn |
| 标题 | 侧栏与页头统一 `LifeHud`，不翻译 |
| 图标 | 换成 2×2 仪表盘网格 |

## 当前实现（v0.0.3）

```
GET    /lifehud/api/hud     → { clock, tasks, weather, sessions, warnings }
GET    /lifehud/api/photo   → 图片二进制 / 404
POST   /lifehud/api/photo   → 上传 base64 图片（≤2 MB）
DELETE /lifehud/api/photo   → 移除
```

## 已知问题 / 下一步

- 「最近会话点击跳转」依赖 `uiWorkspace` 服务是否对第三方 client 插件暴露。**源码显示它是 cordis.Service，名为 `uiWorkspace`，native 侧栏就是用 `uiWorkspace.openSession()`；但本插件尚未实测到点击成功**，若失败需要改走 `ctx.slots` 提供的 open 回调。
- 天气的"一句话"目前仍是**规则生成**（按温度区间 + 降水概率拼句子），不是模型生成；接 MCP/定时任务后再换。
- 相框图片上传后，若想拿它当**页面背景**，需要在设置里手动填图片 URL（当前上传接口只返回二进制，没有返回可引用地址）。下一步可加 `GET /lifehud/api/photo/url` 或直接提供"用相框图片做背景"开关。
- 没有自动刷新（只有手动按钮）；后续可加 5 分钟轮询。
- 数据源路径写在 `plugin/cordis.patch.yml` 的 config 里，换机器要改。

---

## v1.1.0 体重链路验证（2026-11-09）

- **验证者**：verifier（独立验证，不是写这段代码的人）
- **脚本**：`spike/probe-weight.mjs` —— 零依赖、可重复跑、自带清理（副本库与坏 session 都在 `%TEMP%`，跑完删）；有 FAIL 时退出码 1
- **跑法**：`node spike/probe-weight.mjs [http://127.0.0.1:<DSH 当前端口>]`（第 7 组需要 DSH 在跑；端口每次启动都会变，也可以设 `$env:LIFEHUD_BASE`，默认回落 59098）
- **被测对象**：`plugin/index.js` 的 `readWeight()` + `GET /lifehud/api/weight` + 真实库 `<dataDir>\lifehud-weight.db`（44 条云端记录 / 37 个测量日 / 2026-08-12 ~ 2026-11-09）
- **结论**：**46 PASS / 0 FAIL / 5 INFO**。六组必测项全部通过；首轮发现的 4 条边角里有 2 条已在 Lead 手上修掉并复跑（见文末「修复记录」）。

### 逐项结果

| 检查项 | 结果 | 证据（一行） |
|---|---|---|
| **1. 云端可用** 1.1–1.3 | ✅ PASS | `{ok:true, stale:false, reason:null, archived:44, points:7}`，跨度 `2026-11-02 ~ 2026-11-09`；本地 44 行 / 37 个测量日，条数与云端相等 |
| **2.1 weight_id 是 TEXT 无 `.0`** | ✅ PASS | 44/44 行 `typeof(weight_id)='text'`，0 行含 `.`，0 行含非数字 |
| **2.2 ts 是整数、单位秒** | ✅ PASS | 44/44 行 `typeof(ts)='integer'`，且 `ts = floor(weight_id/1000)` 全部成立 |
| **2.3 date = 本地时区 YYYY-MM-DD** | ✅ PASS | 44 行全为 `YYYY-MM-DD`，且 `date = substr(measured_at,1,10) = strftime(ts,'unixepoch','localtime')` |
| **2.4 weight_kg 合理** | ✅ PASS | 64.24~66.66 kg，越界 40~150 的 0 行 |
| **2.5 meta.lastSyncAt 是毫秒** | ✅ PASS | 13 位毫秒值（前端 `relTime` 依赖它） |
| **2.6 同日多条取最后一次** | ✅ PASS | 6 个多称日；最新日 `2026-11-09` 的曲线值 = 当天 ts 最大那条 |
| **2.7 凭据不落库/不落响应** | ✅ PASS | 68KB 库文件与 `/lifehud/api/weight` 响应体里都搜不到 serviceToken / ssecurity（userId 在 7.9 另测） |
| **2.8 不信任已解析列** | ✅ PASS | 只用 `raw_json` 独立重算 44 条记录的曲线，与 `readWeight()` 返回值逐点相等 |
| **3. 幂等** 3.1–3.2 | ✅ PASS | 两次 `{force:true}`：`COUNT(*)` 44 → 44 → 44；`weight_id TEXT PRIMARY KEY` 存在、0 组重复 |
| **4.1 曲线 = 最新 7 个测量日** | ✅ PASS | 副本库：返回值 = 库内最新 7 个测量日（`11-02…11-07` + `11-09`，跳过 `11-08`） |
| **4.2 缺失日不断链** | ✅ PASS | 删掉 `2026-10-31` / `2026-11-03` 后仍返回 7 点、日期 `11-01~11-09` 升序、无空洞/NaN、被删日期不出现 |
| **4.3 不足 7 天返回实际点数** | ✅ PASS | 只留 3 天 → 3 点（`min(7,3)`），升序 |
| **4.4 空库不炸** | ✅ PASS | 0 个测量日 → `points=[]`，`stale=true`，不抛异常 |
| **4.5 同日多条只算一个点** | ✅ PASS | 临时库给同一天造 3 条（`11.11`/`22.22`）→ 仍是 1 个点，取 ts 最大的 `22.22` |
| **5.1 坏 token 降级** | ✅ PASS | `stale=true, reason='session-expired', points=7`（本地数据），未抛异常 |
| **5.2 miSession 路径不存在** | ✅ PASS | `stale=true, reason='session-expired', points=7`，不抛 |
| **5.3 坏 JSON / 缺字段** | ✅ PASS | 两者都是 `session-expired`，不抛 |
| **5.4 本地库也没有** | ✅ PASS | 全新路径 → `stale=true, points=[]`，库文件被自动建出来 |
| **5.5 weightDb 未配置** | ✅ PASS | 空 config → `stale=true, points=[]`，不抛 |
| **5.6 + 5.10 stale 不伪造新鲜度** | ✅ PASS | stale 读前后行数与 `meta.lastSyncAt` 都不变（前端能正确显示「最后同步：X 小时前」） |
| **5.7 云侧错误分类** | ✅ PASS | 错误 `did` → `reason='cloud'`（`code=-8 unknown did`），没误判成会话过期 |
| **5.8 网络不可达分类** | ✅ PASS | stub 掉 fetch → `reason='network'`，本地 7 点保留，不抛 |
| **5.9 本地库不可写分类** | ✅ PASS | 独占锁 → `reason='local'`，347ms 返回未卡死，不抛 |
| **5.11 空 result 不误删** | ✅ PASS | 云成功但 0 条 → 本地 44 行一行没删（副作用见 5.11b） |
| **5.12 乱码响应** | ✅ PASS | 非 JSON 非密文 → `reason='cloud'`，本地曲线保留，不抛 |
| **6.1 TTL / force** | ✅ PASS | 非 force#1 273ms → 非 force#2 **0.0ms 且 lastSyncAt 相同**（缓存）→ force 236ms 且 `lastSyncAt` 变新 |
| **6.2 TTL 按 dbPath 分键** | ✅ PASS | 换库路径不会命中上一个库的缓存 |
| **6.3 TTL 下限保护** | ✅ PASS | `weightTtlMs: 0` → 下限 60s 生效，第二次仍走缓存（不会狂刷云） |
| **6.4 并发单飞按库分键** | ✅ PASS | 同库并发两次 → 只发 **1 次**云请求、返回同一 snapshot；不同库并发 → 各发各的（B 用坏 session 走 stale，只读自己的库，A 的日期没有串过去） |
| **6.5 修好登录后恢复** | ✅ PASS | 坏 session → 带 `force` 立刻 `stale=false` 且 `lastSyncAt` 变新 |
| **7.1 路由契约** | ✅ PASS | `200 application/json; charset=utf-8` + `cache-control: no-store`；键 = `[ok,stale,reason,lastSyncAt,points,archived]`，无多余字段，类型全对 |
| **7.2 路由 = 本地口径** | ✅ PASS | 路由返回的 7 个点逐日等于库里「最新 7 个测量日 + 每天 ts 最大那条」 |
| **7.3 `?force=1`** | ✅ PASS | `200`、`stale=false`、`lastSyncAt` 变新 |
| **7.4–7.5 只读端点** | ✅ PASS | `POST` / `PUT` / `DELETE` 全部 `405 {ok:false,error:"GET required"}` |
| **7.6 每个 handler 都鉴权** | ✅ PASS | 5 个 handler 全部含 `isLocalPeer(req)`；5 条路由；白名单只有 `127.0.0.1 / ::1 / ::ffff:127.0.0.1` |
| **7.7 远程访问面** | ✅ PASS | 非 loopback IPv4（`10.242.100.151`）→ `ECONNREFUSED`（403 分支的证据边界见 7.7b） |
| **7.8 前端字段对齐** | ✅ PASS | `client.js` 的 `WEIGHT_URL`、`p.date`、`p.weight_kg`、`data.stale`、`data.lastSyncAt` 与响应完全一致；`archived` 前端未用（仅诊断） |
| **7.9 响应不含凭据** | ✅ PASS | `?force=1` 响应 370 字节，serviceToken / ssecurity / userId 均未出现 |
| **8. 收尾** | ✅ PASS | 真实库测试前后都是 44 行 / 37 个测量日；`%TEMP%` 无 `lifehud-weight-probe-*` 残留 |

### 已知限制 / 可疑点（都不是硬失败，但值得知道）

1. ~~**「静默假新鲜」风险（5.11b，产品级）**~~ **已修**：云成功但返回 0 条时不再刷新 `lastSyncAt`；若本地已有历史还会标 `stale=true, reason='cloud'`。见文末「修复记录」。
2. ~~**`weightInflight` 的合并键不含 dbPath（6.4b，潜在缺陷）**~~ **已修**：`weightInflight` 改成按 `dbPath` 分键的 Map；6.4 复跑覆盖「同库合并 / 不同库不串数据」两个方向。
3. **stale 快照也会进 10 分钟 TTL 缓存（6.5b）**：会话过期后重新登录，不带 `force` 的请求最长 10 分钟内仍返回 `stale=true`。界面「刷新」走 `?force=1`，用户无感；但后台每 10 分钟的轮询会白等一轮。
4. **库被独占锁定时 stale 降级只能给空曲线（5.9b）**：`reason='local'`，`points=[]`、`lastSyncAt=null`。不是崩溃，但卡片会从「有曲线」退化到占位文案。
5. **403 分支没有实测（7.7b，证据边界）**：loopback 上无法伪造 `remoteAddress`，所以「远程请求被 403」只能靠代码审查 + 端口根本不对外监听（`10.242.100.151` 连不上）来间接证明，**不声称测过 403**。
6. **云端 `limit: 1000`**：`time_start=0` + `limit=1000`，即最多拉最近 1000 条。当前 44 条远未触顶；按每天一称约 3 年后会开始截断最早的记录（本地库里已有的行不会被删，所以只是「新装机的历史深度」上限）。
7. **`date` 的真实来源是云端 `measured_at`（设备本地时间）**，不是 `ts` 算出来的。`2.3` 那条「`date = strftime(ts,'localtime')`」在本机（`Asia/Shanghai`）成立；若把机器时区改成别的，这条会不一致 —— 那时 `date` 仍是「用户称重那天」（更符合直觉），但验证脚本会报警，需要人工判断。
8. **未覆盖**：浏览器端渲染（折线/标签/主题）由 client-card 负责；多设备/多账号；云端只返回**部分**记录（截断）时的行为；真实断网（只用 stub 模拟过 `network`）。

### 我动过真实库吗？

- 只做过**只读**检查 + **幂等 upsert**（`{force:true}` 重新同步同一批云数据几次）。**没有 DELETE、没有 UPDATE 权重值、没有写 meta 以外的字段。**
- 所有破坏性实验（删日期、清空表、造同日多条、独占锁、坏 session）都在 `%TEMP%` 里的**副本库**上做，跑完全部删除。收尾核对：真实库 44 行 / 37 个测量日 / 最新 `2026-11-09`，与测试前完全一致。
- 坏 token 是「`mi-session.json` 的临时副本」改坏 `serviceToken` 后放 `%TEMP%`，不存在于仓库、不打印明文、跑完删除；原文件从未被写入。

### 修复记录（Lead，验证后当天）

| 发现 | 改哪 | 怎么改 | 复跑 |
|---|---|---|---|
| 静默假新鲜（云回 0 条却把 `lastSyncAt` 推到「刚刚」） | `plugin/index.js` › `saveWeightRows` / `readWeight` | 只有真的同步到记录（`rows.length > 0`）才写 `meta.lastSyncAt`；本地有历史而云回 0 条时额外标 `stale=true, reason='cloud'` | `probe-weight.mjs` 5.11 / 6.1 仍 PASS |
| `weightInflight` 单飞不分库 | `plugin/index.js` › `readWeight` | 改成 `Map<dbPath, Promise>`，回调里 `delete(dbPath)` | `probe-weight.mjs` 6.4 改成两向断言后 PASS |

修完 **46 PASS / 0 FAIL**（`node spike/probe-weight.mjs`，2026-11-09 21:0x）。

---

## v1.1.1 专注卡脱离 ActivityWatch（2026-11-10）

- **目标**：关掉甚至卸载 ActivityWatch，专注卡/热力卡照常有真实数据；同时把采到的原始数据完整留存（为 1.2 详情页留料）。
- **做法**：`plugin/collector.ps1`（Windows 自带 PowerShell 5.1 + C# P/Invoke，零安装）每 2 秒输出一行 JSON → Host 合并成带 `duration` 的事件 → `<dataDir>/capture.db`（`buckets` + `events.data` 原始 JSON + `meta`）→ `readOwnActivity()` 聚合 → 卡片契约不变。
- **AW 只在一处出现**：首次启动的一次性迁移 `importHistory()`。
- **验证脚本**：`spike/probe-capture.mjs`（45 项）、`spike/probe-hud.mjs`（确定性 20 项）、`spike/probe-hud.mjs --real`（真实库 23 项）、`spike/probe-weight.mjs`（46 项回归）。

### 实测数字（2026-11-10 00:0x，本机）

| 项 | 值 |
|---|---|
| AW 库迁移 | 3 bucket：`aw-watcher-window_<host>` 18,436 条、`aw-watcher-afk_<host>` 693 条、`aw-stopwatch` 0 条；合计 **19,129 条**，全部 `source='aw-migrated'` |
| 分类规则 | `meta.aw_classes` = 16 条（`[{name:["Work","Programming"], rule:{…}}, …]` 原文） |
| 幂等 | 二次 `importHistory()` → `skipped:'already'`，0 新增行 |
| 实时采集 | `capture: {running:true, pollSeconds:2, samples 递增, restarts:0, noise:0}`；10 秒内 15 → 20 个样本 |
| 聚合性能 | 19,992 行时 `readOwnActivity()` **68 ms**（84 天 + AFK 扣除 + 24h 聚合全算完） |
| 断 AW 后 | `/lifehud/api/hud` 的 `focus.available=true`、`trackingMinutes=354.1`（= 同日热力 354 分钟，同一口径）、`top` 6 个真实应用、`warnings: []`、热力 13 天非零（与 AW 时代的 13 天一致，无断档） |
| 库体积 | 迁移 19,129 条后 `capture.db` ≈ 5.4 MB（WAL 模式） |

### 验收发现的一个真 Bug（已修，commit 69a3f02）

**现象**：`readOwnActivity()` 算出了「扣掉 AFK 的活动秒数」，却只用它算热力日历和「整段 AFK 就丢弃」；
`trackingMinutes` / `top[].minutes` / `longest.minutes` 用的是**原始时长**。同一函数两套口径 → 真库上
`trackingMinutes=705.6`，而**同一天热力只有 354 分钟**，自相矛盾；top 排序也被扭曲
（`todesk 145.5min` 排在第二，扣掉 AFK 后其实掉出前六）。这个坑 v1.1.0 从 AW 取数时就有，属于继承缺陷。

**修法**：`const activeRatio = seconds / duration;`，24h 那一段用 `inside = overlap * activeRatio`。
AFK 区间不精确切分到事件内部，按占比摊到整段——**热力与 24h 用同一个比例**，不会再打架。

**修后实测**：`trackingMinutes=354.1`（= 同日热力 354）、top = DeepSeek Harness 110.2 / 哔哩哔哩 87.4 / 微信 57.6 / Edge 20.1 / NowTree 18.8 / VS Code 17.4，与验收者（verify-hud）独立写的交叠算法复算逐项一致。
`spike/probe-hud.mjs` 里写死旧口径的三条期望（90/135/90）已同步改成 60/105/60；
新的独立探针 `spike/probe-focus.mjs` 专测这一条（C 组），修前 54/58、修后 48/48（含 1 项 SKIP）。

### 值得记住的发现
1. **`eventmodel.bucket_id` 指向 `bucketmodel.key`（INTEGER），不是 `bucketmodel.id`（TEXT）**。`WHERE bucket_id = '<aw bucket id>'` 会静默返回 0 行——只有 `JOIN bucketmodel b ON b.key = e.bucket_id` 才对。第一版迁移就是被这个坑到「以为 AW 里只有 0 条」。
2. **AW 的时间戳是 `"2026-11-09 15:54:03.180000+00:00"`**（空格分隔 + 微秒 + 显式 UTC 偏移），`Date.parse` 能直接吃；别自己切字符串。
3. **AW 里有 `duration: 0` 的心跳**（本机 5,764 条）。迁移要原样保留（一个字段都不丢），但**聚合时必须跳过**（`e.duration > 0`），否则会把应用时长摊薄。
4. **PowerShell 5.1 在管道下按 OEM/ANSI 输出**：不设 `[Console]::OutputEncoding = UTF8(no BOM)`，中文窗口标题到 Node 侧就是 U+FFFD 乱码。脚本本身必须纯 ASCII（PS 5.1 按 ANSI 读脚本）。
5. **未闭合事件必须「先 INSERT 再 UPDATE duration」**：合并语义下"同一个应用连续 8 小时"只有一行；如果只在事件切换时才落盘，页面最长一小时都看不到新数据。代价是每 60s 一次 UPDATE，可忽略。
6. **WAL + busy_timeout 是必需的**：写句柄常驻、每次 `/hud` 另开只读连接读同一库，默认 journal 模式偶发 `SQLITE_BUSY`。只读连接读 WAL 库没问题（实测：干净关闭与写者在线两种情形都能读）。
7. **采集器必须「收到样本就清零重启计数」**：指数退避封顶 5 次，若不归零，跑几周后被历史崩溃次数永久停采。

### 主动取舍（与需求规格的偏差）

1. 合并语义按规格（`duration = 最后匹配样本时间 - 事件起点`），所以每次应用切换会丢 ↔ 一个采样间隔（2 秒）；与 AW 的 `heartbeat_merge` 同一量级。
2. 迁移**不按 (bucket, ts) 去重**：AW 里确实存在同 bucket 同 timestamp 的不同事件，去重会丢数据；幂等靠 `meta.history_imported` + 「重跑时库中已有」实现。
3. `trackingMinutes` 不含被过滤的空转段（`explorer.exe + Program Manager`），与旧口径一致；`longest.app` 仍是原始 exe 名（不套别名），保持 v1.1.0 前端契约。
4. 「专注卡采集」开关**只管展示**（客户端 localStorage），Host 仍采集；真正停采要新增 Client → Host 通道，留给 1.2。
5. 迁移在 `applyInner()` 里**同步执行且早于 `startCollector()`**（19k 行约数百毫秒），换来「迁移与实时采集时段天然不重叠」。

### 未覆盖 / 已知限制

- **「关闭 DSH 后无残留 powershell」**只在探针里验证到 dispose 层（`child.kill()` 后按命令行查无残留 + `process.on('exit')` 兜底）；真·关闭 DSH 需用户操作。
- **浏览器渲染**（卡片三种状态、5 分钟自动刷新、深浅主题）由页面验收，不在 probe 覆盖范围。
- **锁屏**：`GetLastInputInfo` 只反映当前会话，与 AW v0.14.1 行为一致；锁屏时前台通常变成 `explorer.exe + Program Manager`，已被过滤。
- **7×24 采集不做**：DSH 没运行的时间段没有数据。
- **不落 `idle_seconds`**：样本里的空闲秒数**不进** `events.data`。原因是合并语义靠 `data` 完全相同才延长事件，
  把逐样本变化的 `idle_seconds` 写进去等于每条样本都开新事件（8 小时一个应用会变成 14,400 行）。将来做「AFK 比例」用 AFK 流算即可。
- **`capture.rows` 是「写入次数」不是「库行数」**（未闭合事件每 60s 会 UPDATE 一次），诊断用够，别当行数读。v1.1.2 起字段改名为 `capture.writes`，语义不变。
- **AW 历史里有一条病态事件**：`msedge` 单条 25.1 小时（AW 当年停摆造成）。迁移忠实保留（一个字段不丢），但它会压低 11-07 / 11-08 的热力；详情页做统计时应给单条事件设上限。
- **HMR 顺序边界**：若某个宿主先激活新 ctx、后 dispose 旧 ctx，旧 disposer 可能把采集器停掉（`stopCapture` 只停自己那一个 state，但同一模块实例下两次 `apply` 共享单例）。实测 `remove → install` 两次都正常；正常升级不受影响。

---

## v1.1.2 检查更新（2026-11-12）

- **目标**：页面里能手动查一次「远端有没有新版本」，并给出可照做的升级步骤；不自动联网、不引依赖、失败不打扰页面。
- **做法**：Host 新增 `GET /lifehud/api/update`（loopback only）→ GitHub REST：先 `/releases/latest`，404 就回退 `/tags?per_page=30`，取**最大**语义版本 → Client「设置 → 版本与更新」手动点按钮，结果显示发布日期/正文，并把上次结果写 localStorage 供下次打开时回看。
- **验证**：`spike/probe-update.mjs`（31 项确定性 + 2 项 HTTP；`--live` 再真打一次 GitHub）。

### 为什么这么设计（取舍）

1. **用 tag 而不是新增 `version.json`**：发版流程本来就要打 tag（AGENTS §10），不需要多一个人工步骤，也不会出现「文件忘了更新」的漂移。Release 有就顺便拿正文与发布页，没有就只显示 tag。
2. **只有手动点才联网**：用户 2026-11-12 明确选择「默认不自动检查」。Host 侧因此没有启动预热、没有定时器、**也没有 TTL 缓存**——手动点就该真打一次；连点由单飞（inflight）合并。
3. **不自动下载/安装**：插件是 `link:` 安装，升级必须 `git pull` + `plugin_manager` remove/install；没有安全的自更新通道。页面只给步骤，不假装能一键升级。
4. **失败也是 200 快照**：沿用体重链路的 `stale + reason` 契约，页面永远有东西可显示；`reason` 是稳定码（`network / timeout / rate-limited / not-found / bad-payload / bad-repo / no-tags / disabled`），中文翻译在 Client。
5. **本地比远端新要有独立状态**（`ahead`）：发版当天本地已经 1.1.2、远端 tag 还没推，这时若只按「不等」判断就会误报「有新版本」。

### 实测 / 边界

| 项 | 值 |
|---|---|
| 真实仓库状态（2026-11-12） | `/releases/latest` → **404**（还没有 Release）；`/tags` → `v1.1.1`、`v1.1.0`，取最大得 1.1.1；真网络 E1 通过 |
| 未登录限流 | 实测响应头剩 59/60 次；403 + `x-ratelimit-remaining: 0` 归为 `rate-limited`，不会继续打 tags |
| 探针覆盖 | 版本解析/比较、跨文件版本一致（package.json ↔ client BUILD）、release 命中、404 回退、乱序 tags 取最大、非法 tag、坏 JSON、403、超时、离线、无缓存（两次点两次请求）、并发单飞、stale 保留、disabled、非法 repo、HTTP 200/405 |
| 未覆盖 | 浏览器端的实际点按（由页面验收）；`release` 分支只在注入的 fake 响应里验过（仓库当前没有 Release）；20 秒以上的真实网络抖动 |

### 代码评审后的改动（2026-11-12）

评审范围 `v1.1.0..HEAD`，两轴（规范 / 规格）并行。用户选择「按建议修」，落地了这些：

- **真 Bug：写库回滚丢数据**（评审 P6）。`flushCapture()` 事务回滚后，本轮 INSERT 得到的 `rowId` 已不存在；原实现没有清空，下一轮走 `UPDATE` 命中 0 行且 SQLite 不报错 → 一段专注数据静默丢失。现在按「本轮新插入的行」记录并在回滚时清 `rowId`；同时把闭合段/未闭合段的写库分派抽成 `writeSegmentRow()`。`probe-capture.mjs` E1–E4（fake state，不碰磁盘）覆盖：正常落盘、回滚清 rowId、闭合行重新排队、不误伤已有 rowId。
- **删掉死缓存**（评审 P5）：唯一调用方永远手动点，原 `updateTtlMs` + `?force=1` 让 6 小时 TTL 永不命中，还和「结果存 localStorage」的文案打架。现在 Host 不做 TTL、只留最近一次成功结果用于失败降级；`updateTtlMs` 配置项一并删除。
- **渲染 Release 正文与发布日期**（评审 P2）：`notes` 不再取了不用；有 Release 时设置里显示日期 + 正文（最多 400 字）。
- **文档对齐**（评审 S2 / P9）：AGENTS 的 `capture` 字段补 `noise`、说清 `writes` 是写入次数、stderr 只在退出时进 warnings、诊断区只渲染 warnings 不渲染 `capture.*`。
- **自查网补漏**（评审 S9）：`prepublish-check` 的 `FORBIDDEN_FILES` 加入 `capture.db` / `-wal` / `-shm`。
- **顺手清掉的小项**（评审 S5 / S6 / S8 / P7 / P8）：
  - S5：`readOwnActivity` 里窗口/AFK 两段重复的 `JSON.parse` 兜底抽成 `parseEventData()`；
  - S6：`failActivity` 的空聚合字面量抽成 `emptyActivity()`，与 `readOwnActivity` 的返回契约同形；
  - S8：Host 导出 `UPDATE_REASON_CODES`，`probe-update` 的 B3 断言 client 的翻译表覆盖全部码（新增码漏同步会红）；
  - P7：`longest` 不再是死字段——专注卡在条形图下面显示「最长：<应用> · N 分钟」，且 `longest.app` 与 `top` 一样套别名；
  - P8：`capture.rows` 改名 `capture.writes`（纯诊断字段，页面未用），探针与文档同步。

### 后续补齐（2026-11-12，v1.1.2 同一版内）

用户要求把「先不做」的项也在本版做完（除回改历史提交），落地：

- **S3 拆 `index.js`**：入口只剩 `apply` / 路由注册 + 再导出（359 行）；实现分到 `plugin/lib/`：
  `capture.js`（采集/合并/迁移）、`activity.js`（专注聚合）、`weight.js`（小米云+镜像）、
  `update.js`（检查更新）、`hud.js`（任务/天气/会话/`buildHud`）、`settings.js`、`util.js`。
  探针仍从 `plugin/index.js` 导入（入口再导出），无需改探针；`package.json` 的 `files` 加入 `lib`；
  `collector.ps1` 与 `package.json` 的相对路径改成 `../`。
- **P1 `idle_seconds` 第三流**：`appendSample()` 把空闲秒数映射成 `0-10/10-60/60-180/180+` 四档，
  写入 `buckets.type='idle'` 的第三条流（离散档位才不破坏合并压缩）；`readOwnActivity()` 输出
  `idle.levels`（24h 每档分钟数），`buildHud()` 透传 `idle`；页面暂不消费，留给 1.2。
- **两条基线探针**：
  - `probe-weight` 1.3 改成「本地镜像 ⊇ 云端本次返回」（云端只回时间窗内的 43 条，本地保留 47 行）；
  - `probe-capture` D14 改成「AW 最后数据仍在 24h 内时才要求 top 非空」，D15 只对「AW 当天真实窗口工作 ≥ 60 秒」的日子要求热力非零
    （排除 explorer/Program Manager 空转段与按分钟四舍五入的 0）。
- **探针最终数字（2026-11-12，端口 55409）**：`probe-update` 32/32（离线）/ 34/34（HTTP）、
  `probe-hud` 21/21、`probe-hud --real` 24/24、`probe-focus` 60/60、`probe-capture` 50/50、`probe-weight` 46/46、`prepublish-check` 干净。

### 已知限制

- 只认 `vX.Y.Z` 形状的 tag；`nightly` 之类的名字会被跳过（当前发版流程全是正式 tag）。
- 未做 ETag/条件请求；手动点的频率（正常每天几次）远低于未登录 60 次/小时。
- 浏览器的「上次检查结果」按 Host 版本作废：插件升级后需要重新点一次，避免拿旧结论误导。
- 空闲强度已落库但页面未展示；留在 [`docs/BACKLOG.md`](docs/BACKLOG.md) 的 1.2 候选里。
- 明确不回改历史提交（S10，已 push，重写要 force push）。

---

## 小米云会话过期：426 误判 + 设备指纹（2026-11-14 ~ 11-15）

- **现象**：体重卡红字「小米云返回异常」，`/lifehud/api/weight` 返回 `reason:"cloud"`、`error:"小米云 HTTP 426"`；曲线照常（本地缓存 7 个点），数据没丢。
- **真因**：`HTTP 426` + `{"code":0,"message":"SERVICETOKEN_EXPIRED"}` —— 就是**会话过期**。对照实验把「是不是别的原因」排掉：
  - 把 token 换成假的 → `401` + `{"code":2,"message":"auth error"}`，说明请求格式/签名没坏，真 token 是「认得但过期」；
  - 同一会话打两个端点（`/home/device_list`、`/user/get_user_device_data`）→ 都是 426 同一句，是**会话级**失效而不是端点改版；
  - 连跑多次结果一致（确定性）。
- **缺陷 1：只看状态码判过期**。原实现只有 `401/403` 归 `session-expired`，426 掉进通用 `!ok` 分支成 `cloud` → 卡片说「云端异常」，用户不知道该重登。修法：`miDeviceData()` **先读 body 再判状态**，`miFailureReason()` 同时看状态码与响应体文本（`SERVICETOKEN_EXPIRED`），`error` 带出服务端消息；另补「HTTP 200 + 空 result + 该消息」的兜底，避免被当成「云回 0 条」静默降级。
- **缺陷 2：设备指纹每次请求随机**。`deviceId` 原来是**每个请求**现摇 6 位随机串（UA 尾巴也随机），而 Host 每 10 分钟同步一次 → 一天 144 台「新手机」用同一账号，正是盗号风控特征；参考实现是进程序号生成一次。修法：`miDeviceIdOf(config)` 首次生成后写进体重库 `meta.miDeviceId` **永久复用**（DSH 重启不变），UA 尾巴进程内固定。**这一条是「令牌只活 7 天」的主要嫌疑，但未证伪，靠 §4.1 的观测表继续验。**
- **重登工具**：新增 `notes/tools/mi-login.mjs`（本地、未发布）：申请登录入口 → 打印链接 + 二维码（300 秒有效）→ 手机确认 → 换 `serviceToken` → 写回 `mi-session.json`（旧文件先 `.bak-<时间戳>`）。协议要点：`sid=xiaomiio`、`callback` 必须是 `https://sts.api.io.mi.com/sts`（否则回 `code=10025 Callback连接不合法`）；确认后先 GET `location` 拿 cookie。**不碰密码、不装第三方程序。**
- **验证**：`probe-weight` 离线 43 PASS / 0 FAIL / 5 INFO（48 项）、带 DSH 地址 52 PASS / 0 FAIL / 5 INFO。新增 5.13–5.16（失败分类）、5.17–5.18（设备指纹）。**5.17 先改回旧写法确认会红**（两次请求上报 `gkhnjp` / `ybnsev` 两个不同 id）再转绿。另修 5.7：原来打真云测「业务错误」，会话一过期就跟着红，已改 stub（判 `reason` 的用例不该混入会话状态）。
- **结果**：重登后 `?force=1` → `stale:false`、`lastSyncAt` 更新、云端多回了一天（11-14），库内 50 行 / 42 个测量日，8.1 核对前后一致。

---

## 天气把整页拖慢：超时 6s → 3s、失败冷却、并发单飞（2026-11-15）

- **现象**：用户感觉「重启 DSH 后 LifeHud 加载变慢」。实测 `/hud` **连续四次都是 6.02s**，而 `/weight` 只要 3ms——6.000s 正是天气请求的超时上限，其余卡片加起来约 20ms。
- **根因分两层**：
  1. **网络层**：`api.open-meteo.com` 当时**完全连不上**（TCP `connect=0`，HTTPS 与明文 HTTP 一样超时；DNS 正常解析到 51.81.167.44）。对照：同厂商 `geocoding-api` / `archive-api` / `customer-api` 全部 0.2–2.3 秒连通，GitHub / 百度 / 小米云也正常 → **是那个后端 IP 的可达性问题**，不是插件配置。
  2. **代码层**：`readWeather()` 是「超时 6s + 失败不重试」。天气取不到时缓存永远不会被填，于是**每一次** `/hud` 都从头等满一个超时——网络故障被放大成「每次刷新都慢 6 秒」。重启只是让缓存变空，直接撞上这个窗口。
- **修法**（都在 `plugin/lib/hud.js`）：
  - 超时 **6s → 3s**（健康响应实测 1–2.3s）；
  - 失败后 **2 分钟冷却**：冷却期内直接返回上次的值（有缓存时）或 `null`，毫秒返回，不再打网络；冷却结束再悄悄试一次，线路恢复后最多 2 分钟自动补上；
  - **并发单飞**：N 个并发请求共用一次尝试，不会叠加成 N×超时；
  - `clearWeatherCache()` 现在连失败状态一起清（换位置后能立刻重试）；
  - `/hud` 新增 `weatherDiag`（缓存/失败/超时/冷却的生效值）——顺带成了「进程里跑的是哪一版 hud.js」的判活字段。
- **验证**：`spike/probe-hud.mjs` 末尾新增 10 条（stub fetch + `Date.now` 快进）：超时/冷却数值、失败只打一次、冷却期零请求且 <100ms、冷却到期会重试、有旧值时给旧值、`clearWeatherCache` 清失败态、并发单飞。**先改回 6s / 关掉冷却确认会红**（5 条 FAIL：`calls=2`、`calls=3`），恢复后 35/35 全绿；`--real` 38/38。
- **未覆盖 / 已知限制**：不校验「服务端 IP 不可达」这类网络故障本身；冷却期给的是**旧值**，页面目前不标注「这是旧数据」（候选改进）。

---

## v1.1.6：倒计时卡替换相框 + 计时器落到 Host（2026-11-19）

- **需求**（用户逐条定的）：把相框卡换成**倒计时**；**单个**、以**一段时长**为单位（"25 分钟后提醒我"）；**页面不在也要提醒**（会切去对话、或挂后台，但不退出 DSH）；到点弹提醒；结束后停在 `00:00` 附「X 点结束 · 再来一次」；落盘，刷新/重启都继续走。
- **关键决策：计时器必须在 Host。** 一进对话，LifeHud 的 React 组件就被卸载，纯前端 `setInterval` 连同提醒一起消失 —— 用户要的"页面不在也提醒"根本做不到。于是状态机、tick、落盘、提醒全在 `lib/countdown.js`，前端只负责每秒重绘 + 按钮 POST。
- **提醒机制**：Windows PowerShell 5.1 + WinRT toast，AppID 用 `com.deepseek.dsh`（零配置，通知里显示 DeepSeek Harness）。
  **中文必须走 `-EncodedCommand`**（整段脚本 UTF-16LE base64）：写 `.ps1` 文件或塞进命令行都会被 PS 5.1 按 ANSI 读、中文变问号。
  实测验证方式：跑一个 2 秒倒计时 → 读 `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`（只读副本）→ 命中两条 `倒计时结束`。**入库有 1–3 秒延迟**，查早了会以为没发。
- **"离开期间到点"补偿**：Host 启动时 `configureCountdown()` 发现 `running` 且 `endsAt` 已过 → 置 `done` 并发「…在你离开时到点了（HH:mm）」。这是 DSH 不运行时唯一能做的"事后通知"。
- **相框整卡移除**：`GET/POST/DELETE /lifehud/api/photo` 路由、`lifehud-photo.bin/.json` 读写、前端 `PhotoBody` 全部删除；顺带把 `readTextBody` 的上限从 4 MB×2 改成 1 MB（只剩设置/倒计时这类小 JSON）。已存的照片文件不自动删，只是不再读。
- **HTTP 契约**：`GET /lifehud/api/countdown` → 状态；`POST` `{action: start|pause|resume|cancel, ms?}` → 新状态（非法/超 24h 返回 400）；`/hud` 里另带一份 `countdown`（页面首屏就能拿到权威状态）。
- **验证**：`spike/probe-countdown.mjs` **31/31**（状态机、24h 上限、落盘与"重启读回"、离开期间补偿、通知只发一次、再来一次、取消归零）。`probe-hud` 36/36、`probe-weight` 43/43 未受影响。
- **未覆盖**：通知被 Windows 焦点助手/通知设置拦截时无法感知（只能确认"发出去了"）；DSH 完全退出期间到点只能事后补偿，不能实时提醒。

### 后续修正（2026-11-17）：超时 3s → 5s

同一条链路后来实测耗时分布是 **0.27 / 0.33 / 0.48 / 2.04 / 2.75 秒**——大多数很快，但有一条长尾。3 秒只比最长那次多 0.25 秒，等于把判定线贴着最差样本画，线路稍慢就把本来能成的请求判成超时（当天真机上出现过"上午 09:29 启动到 12:45，一次都没成功"）。改成 **5s**，给长尾留 2 秒余量；因为已有失败冷却，页面不会退回「每次都卡满超时」。

同时给设置页诊断区加一行天气状态（`正常 / 这次没取到，用的是上次的数据 / 取不到` + 时间），数据来自 `/hud` 的 `weatherDiag`，只做一句话展示，不铺开细节。


