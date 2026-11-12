# LifeHud 后备清单（v1.3 起）

> 这是「评审里决定先不做」的**长期记忆**：只写在对话或某个人的脑子里都不算数。
> 每条写清：为什么当时不做、要做成什么样、怎么验收。完成一项就把它挪进
> `spike/RESULT.md` 对应版本的记录里，并从这里删掉。
>
> v1.1.2 的评审结论见 `spike/RESULT.md`；当时顺手修掉的 S5/S6/S8/P7/P8 不再列在这里。

## 1. 拆 `plugin/index.js`（评审 S3）

- **现状**：2400+ 行；采集、迁移、检查更新、体重、天气/会话、设置、路由注册六件事同处一个文件。
- **为什么当时不做**：这是动地基，不是修 bug——`captureRuntime` 是模块级单例、HMR 的 dispose 顺序有坑、
  `package.json` 的 `files` 与所有探针的 import 都要跟着改。补丁版本里做，回归面太大。
- **建议拆法**：
  - `plugin/lib/capture.js`：`CAPTURE_*` 常量、schema、`appendSample` / `flushCapture` / `startCollector` / `captureStatus` / `importHistory`
  - `plugin/lib/weight.js`：小米云签名 + 本地镜像 + `readWeight`
  - `plugin/lib/update.js`：版本解析 / `readUpdate` / `githubJson`
  - `plugin/lib/hud.js`：`buildHud` / `readOwnActivity` / 天气 / 会话 / 任务
  - `index.js` 只留 `apply` / `applyInner` 与路由注册；**所有既有 export 从 `index.js` 再导出一次**，探针不用改。
- **验收**：`node --check`；全部探针数量与现在一致；remove → install 后 `/hud`、`/weight`、`/update` 都 200；
  重启后采集器只有一个实例、关闭 DSH 无残留 powershell。
- **风险**：高（模块单例、HMR、`collector.ps1` 的相对路径解析）。

## 2. `idle_seconds` 落库（评审 P1）

- **现状**：`collector.ps1` 每个样本都带 `idle_seconds`，`appendSample` 只把 `{app,title}` / `{status}` 写进 `events.data`。
- **为什么当时不做**：合并语义靠 `data` 完全相等才延长事件；把每 2 秒变化的 `idle_seconds` 放进 `data`，
  「8 小时一个应用」会从 1 行变成 14,400 行，合并压缩直接失效。
- **正确做法**：单开第三条流（bucket type 例如 `'idle'`），`data` 只放**离散档位**
  （`0-10s` / `10-60s` / `1-5min` / `>5min`），或按分钟聚合后再写；
  `readOwnActivity` 增加**可选**的空闲统计，不改现有 `focus` 契约。
- **验收**：`probe-capture` 增加合并用例（80 条样本仍是个位数行）；`probe-focus` 现有断言不变；
  旧 `capture.db`（没有 idle 流）能正常降级。
- **风险**：中（schema 多一条流，不迁移旧数据）。

## 3. 两条基线探针红项

这两条与 v1.1.2 的改动无关，在 `v1.1.1` 基线上同样失败；但「探针红着」会掩盖以后的真问题，应该修。

- **`probe-weight` 1.3「云上的条数与本地库一致」**：云端只回最近 43 条，本地镜像 47 行（镜像保留历史，不删）。
  修法：把断言改成「本地 ⊇ 云端」（按 `weight_id` 集合包含），而不是相等；不要为了过测试删本地历史。
- **`probe-capture` D14/D15**：AW 源库最后数据停在 2026-11-10，24h 窗口里没有迁移数据 → `top` 为空；
  2026-11-10 的热力为 0。修法：D 段用「AW 最大时间戳」而不是 `Date.now()` 作为窗口参照，或注入固定时钟。
- **验收**：两条探针恢复全绿，且不修改真实库；改动只落在探针与临时副本。

## 4. 检查更新「自动查 / 后台查」（可选）

现在刻意是手动（用户 2026-11-12 的选择）。若要做，先问清楚：启动时查一次？每天一次？发现新版用 Toast 还是徽标？
Host 侧已经有 `readUpdate()` 与单飞，加定时器成本很低，产品决策成本更高。

## 明确不做

- **重写已 push 的历史提交**（评审 S10）：需要 force push，违反「不自行 push / 不改已推送历史」。
  提交粒度的问题只在以后的提交里注意，不回改历史。
