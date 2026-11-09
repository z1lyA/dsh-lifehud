# dsh-lifehud

> **抬头（LifeHud）** —— 长在 DeepSeek Harness 里的个人工作台：一屏看完今天该干什么、外面什么情况、我昨天停在哪里。

**v1.1.0** · 零依赖 · 单个 DSH 插件 · 不改动任何被读取的应用

## 装什么、读什么

LifeHud 自己**不产生数据**，只把已经在跑的东西聚到一屏：

| 卡片 | 数据来源 | 读法 |
|---|---|---|
| 当前时段任务 | [NowTree](https://github.com/z1lyA/NowTree) 的 `nowtree.sqlite` | `node:sqlite` 只读打开，按 `time_slot` 过滤 |
| 天气 | Open-Meteo（无需 key） | 48 小时逐时数据，可跨午夜 |
| 最近会话 | DSH 的 `session_projcache` | 读 json；已删除的会话（无日志目录）不显示 |
| 专注 | [ActivityWatch](https://activitywatch.net/) 本地 API `127.0.0.1:5600` | 减掉 AFK 区间，按应用聚合 24 小时 |
| 热力日历 | 同上 | 当月每日活跃分钟，分位数分档 |
| 相框 | 本地文件 `~/.dsh/lifehud/` | 自己上传 |
| 体重（v1.1.0） | 小米云 `user/get_user_device_data`（MX80 体脂秤） | 只读拉取，落地到自己的 SQLite 镜像；画最近有数据的 7 个测量日（纵轴刻度 + 悬停看某天数值） |

体重卡的取数细节（RC4 签名、会话过期后怎么重新登录）见 [`docs/小米云取数.md`](docs/小米云取数.md)。

「网页对话 ↗」直接调系统浏览器打开（内嵌 webview 会被 DeepSeek 风控判定"环境不安全"）。

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

天气位置也可以在页面「设置」里点「使用我的位置」自动写入。
体重卡的开关在「设置 → 体重卡」（存 localStorage，与其它界面设置同一套）。

## 安全边界

- 所有 HTTP 路由**只接受 loopback**（`127.0.0.1` / `::1`）——DSH 不会给插件路由加鉴权，这层必须自己做。
- **不写任何外部数据源**：NowTree / ActivityWatch / DSH 会话 / 小米云全部只读；LifeHud 自己的可写状态只在 `dataDir`（含体重镜像库）。
- 小米云会话文件**只读**，不进 git、不进日志、不打印明文；不自动登录、不保存小米密码。
- 设备号不写死：插件从账号设备列表里自动发现体脂秤，配置里不需要出现任何人的设备 id。
- 面板里没有任何 `eval`、没有外链脚本、零第三方依赖。

## 目录

```
plugin/        唯一被 DSH 加载的包（index.js = Host，client.js = 浏览器）
docs/          ADR（架构决策）+ 小米云取数方法
spike/         独立探针与验证脚本（不依赖 DSH 也能跑）+ RESULT.md 结论
AGENTS.md      给接手 AI 的协作手册（含所有踩过的坑）
```

## 免责声明

- 小米云那段取数走的是**非公开接口**（从米家插件里逆出来的），不是官方 API，随时可能改或失效；
  仅供**个人备份自己的数据**，用之前想清楚小米的服务条款。项目不提供自动登录、不保存你的密码。
- 其余数据源（NowTree / ActivityWatch / DSH 会话）全部**只读**，本插件从不写它们。

## 已知限制

- 打开 DSH 后**不会自动停在这一页**，也不会自动收起侧边栏——DSH 没有公开对应接口。
- 天气的「一句话」是规则拼接，不是模型生成。
- HUD 快照（任务/天气/会话/专注/热力）仍靠手动「刷新」或 60 秒客户端缓存；**只有体重是 Host 每 10 分钟自动同步一次**。
- 小米云会话过期后要**手动重新登录一次**才能续上（卡片会红字提示，历史数据不丢）——步骤见 [`docs/小米云取数.md`](docs/小米云取数.md)。
- 布局是 flex 便当盒：第一行 天气 / 体重 / 任务，第二行 专注 / 会话 / 相框 / 热力，不做瀑布流。

## 许可

MIT
