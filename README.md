# dsh-lifehud

> **抬头（LifeHud）** —— 长在 DeepSeek Harness 里的个人工作台：一屏看完今天该干什么、外面什么情况、我昨天停在哪里。

**v1.1.1** · 零依赖 · 单个 DSH 插件 · 不改动任何被读取的应用（专注数据由自己采集，见下）

## 装什么、读什么

LifeHud 自己**几乎不产生数据**：只有「专注 / 热力」是它自己采的（本机 Windows API → 自己的 SQLite），其余全是只读聚合：

| 卡片 | 数据来源 | 读法 |
|---|---|---|
| 当前时段任务 | [NowTree](https://github.com/z1lyA/NowTree) 的 `nowtree.sqlite` | `node:sqlite` 只读打开，按 `time_slot` 过滤 |
| 天气 | Open-Meteo（无需 key） | 48 小时逐时数据，可跨午夜 |
| 最近会话 | DSH 的 `session_projcache` | 读 json；已删除的会话（无日志目录）不显示 |
| 专注（v1.1.1） | **本机自采集**：`plugin/collector.ps1` 每 2 秒读前台窗口与空闲时间 | 减掉 AFK 区间，按应用聚合最近 24 小时 |
| 热力日历 | 同一份本地采集库 `<dataDir>/capture.db` | 当月每日活跃分钟，分位数分档 |
| 相框 | 本地文件 `~/.dsh/lifehud/` | 自己上传 |
| 体重（v1.1.0） | 小米云 `user/get_user_device_data`（MX80 体脂秤） | 只读拉取，落地到自己的 SQLite 镜像；画最近有数据的 7 个测量日（纵轴刻度 + 悬停看某天数值） |

体重卡的取数细节（RC4 签名、会话过期后怎么重新登录）见 [`docs/小米云取数.md`](docs/小米云取数.md)。

「网页对话 ↗」直接调系统浏览器打开（内嵌 webview 会被 DeepSeek 风控判定"环境不安全"）。

## 专注 / 热力：自己采集，不再需要 ActivityWatch（v1.1.1）

v1.1.0 之前这两张卡读 ActivityWatch 的本地 API，关掉 AW 就没数据。v1.1.1 起改成自己采：

- **采集器** `plugin/collector.ps1`：Windows 自带的 PowerShell 5.1 + 内存里编译的 C# P/Invoke，每 2 秒取「前台窗口的进程名 / 标题」和「键鼠空闲秒数」，`idle ≥ 180s` 记为 `afk`。零安装、不联网、不读其它应用的数据。
- **落库** `<dataDir>/capture.db`，通用模型：`buckets`（哪几条数据流）+ `events`（`data` 列存**原始 JSON**）+ `meta`。连续同应用的心跳会合并成一条带 `duration` 的事件，所以"8 小时都在 VS Code"只占一行，而不是 14,400 行。
- **一次性迁移 AW 历史**：首次启动时把 ActivityWatch 库里**所有 bucket**（窗口 / AFK / stopwatch）和分类规则 `classes` 全量搬进 `capture.db`，之后可以卸载 AW。迁移幂等，只做一次；AW 原库只读、不修改。
- **隐私**：默认保存窗口标题，配置 `storeTitles: false` 就只存应用名；数据只在本机 `dataDir`，不出网、不上传。
- **开关**：页面「设置 → 专注卡采集」关掉后卡片显示「已关闭」（目前只是不展示，Host 仍在采集）。

## 安装

```js
// 在 DSH 里执行（需要 Full access）
plugin_manager({ action: 'install_bundle', target: '<本仓库路径>/plugin' })
```

安装后刷新页面即生效。**改 Host 代码（`plugin/index.js`）需要 `remove_bundle` → `install_bundle` 重新加载；改 Client（`plugin/client.js`）只需刷新页面。**

## 配置

数据源路径写在 `plugin/cordis.patch.yml` 的 `config` 里：

数据源路径**都有默认值**，装完通常一行配置都不用改（想覆盖再改 `plugin/cordis.patch.yml`）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `nowtreeDb` | `%APPDATA%\com.nowtree.app\nowtree.sqlite` | NowTree 的任务库（只读） |
| `leveldbDir` | `%LOCALAPPDATA%\com.nowtree.app\EBWebView\Default\Local Storage\leveldb` | NowTree 的早/午/晚分界（只读） |
| `dataDir` | `~/.dsh/lifehud` | LifeHud 自己的可写状态（设置、相框、体重镜像库） |
| `weightDb` | `<dataDir>/lifehud-weight.db` | 体重镜像库（只读云、只写本地） |
| `miSession` | `<dataDir>/mi-session.json` | 小米云会话文件，**自己放进去、别提交**（格式见 `docs/小米云取数.md`） |
| `miDid` | 自动发现 | 体脂秤设备号：插件会从账号设备列表里找，不用手填 |
| `weightTtlMs` | `600000` | 体重同步 TTL（10 分钟），手动「刷新」会强制跳过 |
| `captureDb` | `<dataDir>/capture.db` | 专注自采集库（LifeHud 唯一自己写的库） |
| `capturePollSeconds` | `2` | 采样间隔（秒）；想省资源可以调 5 |
| `afkThresholdSeconds` | `180` | 空闲超过这么多秒算「离开」 |
| `storeTitles` | `true` | 是否落库窗口标题；`false` 只存应用名（更隐私） |
| `historyImport` | `'once'` | `'never'` 表示不迁移 ActivityWatch 历史 |
| `historySource` | 自动推导 | ActivityWatch 库路径，正常情况不用填 |

天气位置也可以在页面「设置」里点「使用我的位置」自动写入。
体重卡、「专注卡采集」两个开关都在「设置」里（存 localStorage，与其它界面设置同一套）。

## 安全边界

- 所有 HTTP 路由**只接受 loopback**（`127.0.0.1` / `::1`）——DSH 不会给插件路由加鉴权，这层必须自己做。
- **不写任何外部数据源**：NowTree / DSH 会话 / 小米云全部只读；ActivityWatch 只在**首次迁移**时读一次库文件，运行期零依赖。LifeHud 自己的可写状态只在 `dataDir`（体重镜像库 + 专注采集库 `capture.db`）。
- **专注采集不越界**：只读 Windows 的前台窗口进程名/标题和键鼠空闲时间；不采键鼠具体输入、不采屏幕内容、不采浏览器 URL，也不联网。
- 小米云会话文件**只读**，不进 git、不进日志、不打印明文；不自动登录、不保存小米密码。
- 设备号不写死：插件从账号设备列表里自动发现体脂秤，配置里不需要出现任何人的设备 id。
- 面板里没有任何 `eval`、没有外链脚本、零第三方依赖。

## 目录

```
plugin/        唯一被 DSH 加载的包（index.js = Host，client.js = 浏览器，collector.ps1 = 专注采集器）
docs/          ADR（架构决策）+ 小米云取数方法
spike/         独立探针与验证脚本（不依赖 DSH 也能跑）+ RESULT.md 结论
AGENTS.md      给接手 AI 的协作手册（含所有踩过的坑）
```

## 免责声明

- 小米云那段取数走的是**非公开接口**（从米家插件里逆出来的），不是官方 API，随时可能改或失效；
  仅供**个人备份自己的数据**，用之前想清楚小米的服务条款。项目不提供自动登录、不保存你的密码。
- 其余数据源（NowTree / DSH 会话 / 小米云）全部**只读**，本插件从不写它们；ActivityWatch 只在首次迁移时读一次库文件。

## 已知限制

- 打开 DSH 后**不会自动停在这一页**，也不会自动收起侧边栏——DSH 没有公开对应接口。
- 天气的「一句话」是规则拼接，不是模型生成。
- HUD 快照（任务/天气/会话/专注/热力）现在每 **5 分钟**自动刷新一次（页面隐藏时不拉，回到页面补一次）；体重仍由 Host 每 10 分钟自动同步。
- 专注数据**只在 DSH 运行期间采集**：DSH 关着的时间段没有数据（7×24 采集不做）。
- 「专注卡采集」开关目前只影响**展示**，Host 还在继续采集（真正停采是 1.2 的事）。
- 小米云会话过期后要**手动重新登录一次**才能续上（卡片会红字提示，历史数据不丢）——步骤见 [`docs/小米云取数.md`](docs/小米云取数.md)。
- 布局是 flex 便当盒：第一行 天气 / 体重 / 任务，第二行 专注 / 会话 / 相框 / 热力，不做瀑布流。

## 许可

MIT
