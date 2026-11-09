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
