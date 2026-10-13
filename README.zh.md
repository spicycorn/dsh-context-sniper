# dsh-context-sniper（上下文狙击手）

DeepSeek Harness 的**无损上下文归档 + 检索**插件。

当长对话导致本地模型 prefill 超时（provider 报告
`pi-ai stream idle timeout`）、撑爆上下文窗口（`CONTEXT_WINDOW_EXCEEDED`），
或某一轮在**输出 token 上限**处被截断（界面提示"已达到输出 token 上限"）时，
本插件会：

1. 只保留最近的**消息**（至多 token 预算）在模型上下文里；
2. 把更早的消息**原样**归档到每个会话独立的持久化文件（不做摘要、不丢失）；
3. 用一条紧凑的"已归档"标记替换被移出的内容，并告诉模型如何取回；
4. 授权重试请求。

如果归档后仍不够（或表面已经很小），则回退到内置的 `dsh-compaction-basic`
做有损摘要兜底。模型通过 `context_sniper_recall` 工具检索归档内容。

> **[English](README.md) | 中文**

适配 **DSH 0.2.0-rc.1+**（在 0.2.0-rc.1 / rc.2 上验证）。

## 为什么单独做一个插件

`dsh-compaction-basic` 已经在做溢出恢复——但靠的是**摘要**（有损）。本插件是互补的：
靠**归档**（无损）恢复，并给模型一扇回到原文的门。它不改动任何 DSH 底层参数，
也不会关掉内置压缩。

## 你需要配置什么

三个参数面向用户，均可在**设置 → 上下文狙击手**面板中编辑（经由 DSH 设置镜像
**实时保存**：持久化 + 热更新，无需保存按钮、无需重启）：

- **`surfaceTokenBudget`**——模型表面保留的最大 token 数，更早的消息全部归档。
  这是**唯一的预算参数**，不存在独立的"默认 Token 预算"。
- **`maxSearchHits`**——`context_sniper_recall` 每次查询返回的最大消息条数
  （1–64，默认 8）。
- **`hitMaxChars`**——每条归档消息在命中结果中包含的最大字符数
  （200–20000，默认 4000）。

以上任意项（以及 `pressureRatio`、`archiveDir`、`verbose`）也可在 DSH 设置文档
（命名空间 `dsh-context-sniper`）或组合配置（`config.*`）中设置。其余都有合理
默认值（见"配置"）。

## 如何工作

识别基于 **provider 的结构化 API 错误响应**。当 LLM API 返回超时或
上下文窗口溢出错误时，DSH 的 LLM adapter 设置 `failure.code`，agent 循环
通过 `agent/request-error` 瀑布将其暴露。

本插件以 `prepend: true` 注册该监听器，使其成为最外层包裹、最先行动：

- 从最旧消息开始归档，直到表面 token ≤ 预算；
- 返回终结动作 `{ kind: "retry" }`，请求随即针对收缩后的上下文重跑——
  内置有损压缩因此不会执行。

若没有可安全归档的内容（表面已最小），则调用 `next()`，交给内置压缩兜底。
被取消的请求（`signal.aborted`）一律不重试。

可选：设置 `pressureRatio`（如 `0.8`），在表面 token 超过预算该比例时**提前**
归档，避免硬失败。默认关闭（`0`）。

### 输出上限触发器（"已达到输出 token 上限"提示）

当某一步的流式输出到达模型的输出 token 上限时，agent 循环会以
`turn/end { reason: { kind: 'max-tokens' } }` 结束这一轮
（`@deepseek-ai/dsh-session` 的 `TurnEndReasonMap['max-tokens']`）。界面上的
**"已达到输出 token 上限"**提示正是由这个事件渲染出来的——客户端的
turn-max-tokens 通知匹配的就是同一个事件类型和 reason。插件在宿主侧监听它，
因此裁剪恰好在提示出现的瞬间触发：

- 按上文同样的无损路径，从最旧消息归档到表面预算；
- 然后排队一条"请继续完成上一步未完成的输出。"后续消息，让模型在被腾出的
  上下文上继续——每个会话最多自动续写 3 次（真实用户消息会重置计数）。
  续写额度用完后，裁剪本身仍会执行。

另有启发式触发器（对收尾 assistant 消息做 usage 比例 / 突然结尾检测），
覆盖那些**没有**上报结束原因的 provider。两个触发器共享同一个"每轮认领"
机制，保证同一轮截断至多归档 + 续写一次，无论哪个先触发。

## 归档粒度

归档以**单条消息**为单位。表面是一组带 token 定价的节点（每条 user message、
assistant message 或 tool result）。插件从最新节点向前累加 token，达到预算时
停止，更早的全部归档。工具调用配对安全检查确保切割不会把 tool-call 和
其 result 拆散。

## 标记合法性（为什么裁剪不再破坏会话）

裁剪时，本插件追加一条紧凑的 `user/message` 标记，携带
`surfaceOp: { op: 'replace', startSeq, endSeq }`（与内置 `dsh-compaction-basic`
同一机制），在模型表面上"影子化"被归档的范围。原始事件仍保留在持久化日志中，
改变的只是模型可见的表面。

每条替换的紧邻之前（同步相邻、中间无任何事件）都会追加一条武装精确替换区间的
`compaction/prune` 影子价格事件 —— 这是 token 计量 surface 折叠的契约，释放的
token 会因此从持久的上下文压力投影中扣减；缺少它时 replace 以零增量折叠，裁剪
对压力统计不可见。

**标记的 `data.id` 是必填项。** DSH 的会话加载边界（`@deepseek-ai/dsh-session`
的 `assertMessageEventShape`）会拒绝任何 `data.id` 不是非空字符串的 `user/message`，
抛出 `session event at seq N lacks an identified message`，并导致**整个会话无法加载**
（`SessionPersistenceCorruptionError`）。早期插件版本省略了 `id`，这正是用户看到的
损坏。本版本始终生成非空 `id`（归档 UUID）并设置生产者专属的 `source.kind` 为
`context-sniper`，因此每条标记都能无损地通过 DSH 持久化往返，裁剪后会话也能正常
加载。（会话格式 v4 已废弃通用的 `plugin` kind——现在写入它会在持久化编码阶段抛出
`format v4 message requires a producer-owned source kind`，并污染整个存活会话后续
每一次落盘。）

### 标记是指令，不只是提示

裁剪**不是**重开会话——模型应该继续它正在做的任务。但早期标记只是*通知*模型
内容被归档了，模型于是经常"重启"：重新读文件、重新自我介绍、重新规划——
消耗额外 token 和时间，甚至再次撑爆窗口。本版本把标记变成对模型的明确指令：

- *"这是一个上下文归档检查点——不是会话重启。你正在任务中途，请从你停下的地方
  继续。"*
- *"不要重新读文件、不要重新自我介绍、不要从头重新规划。"*
- *"如果你缺少已不可见的事实、决策、文件内容或指令，调用
  `context_sniper_recall("<关键词>")` 检索归档原文。"*
- *"先检索再依赖——不要凭猜测使用归档内容。"*

由于标记同时通过 `surfaceOp: replace` 把被归档范围从模型表面移除，重试请求的
**prompt 更短、prefill 更快**——这正是裁剪的意义。指令文本让模型保持在任务上，
不会通过重新探索来抵消这个加速。

## 归档存储位置（与 DSH 会话目录对齐）

每次归档一个 JSON 文件，存放在 **DSH 会话目录内**，使其与被裁剪的会话日志
同处一目录：

```
<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/context-sniper/<archiveId>.json
```

`<projectKey(cwd)>` 与 `<encodeSegment(sessionId)>` 使用 DSH
`dsh-session-persistence-jsonl` 后端定位 `session.jsonl.zstd` 的**同一套算法**计算，
因此归档落在拥有该会话的同一目录中。`context-sniper/` 子目录对 DSH 的会话枚举
不可见（DSH 只把包含 `session.jsonl[.zstd]` 文件的目录当作会话），因此绝不会
干扰 DSH 的存储、列表或加载。

## 检索工具

`context_sniper_recall(query)`——对当前会话的归档做关键词检索，按原文返回匹配的消息
（最新在前），每条带角色、轮次与片段。模型在需要本会话早期、已不可见的事实、决策、
文件内容或指令时调用它。

## 设置面板

注册一个**设置 → 上下文狙击手**分区（中英文随界面语言切换，全部颜色使用
`--dsw-alias-*` 主题令牌，自动跟随明暗模式）：

- **参数卡片**——上述三个可编辑值通过共享设置镜像（`ctx.configForms`）
  **实时读写**：每次编辑即时校验、带修订围栏地持久化；每个字段旁的
  **恢复默认**按钮可清除覆盖、回退到组合层默认值。没有保存按钮，无需重启。
- **归档状态卡片**——跨全部会话的实时统计：归档会话数 / 批次数 / 消息数、
  累计释放 Token、最近归档时间，以及按时间倒序的最近归档列表
  （项目 · 消息数 · Token 数 · 原因 · 时间），带刷新按钮。
- 标题旁的插件**版本号**，打开面板时从宿主读取。

仅当宿主实际提供 `dsh-context-sniper` 设置命名空间时，该分区才会出现。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `surfaceTokenBudget` | `32768` | 模型表面保留的最大 token 数。 |
| `pressureRatio` | `0` | 在预算该比例处提前归档；`0` = 仅在超时时反应。 |
| `maxSearchHits` | `8` | 每次检索返回的最大归档消息数。 |
| `hitMaxChars` | `4000` | 每条命中消息的最大字符数。 |
| `archiveDir` | `context-sniper` | 每个 DSH 会话目录内的归档子目录。 |
| `verbose` | `false` | 以 info 级别记录每次归档决策。 |

## 安装

以 bundle 形式安装已发布的包（Web 界面的 Plugin Manager，或 DSH CLI）：

```
dsh plugin --profile web add github:spicycorn/dsh-context-sniper
```

`package.json` 的 `dsh.bundle.patch` 字段会让 profile 组合器在每次启动时自动
挂载 `cordis.patch.yml`——无需手工编辑补丁。重启 DSH（或由 Plugin Manager
热激活该 bundle）后，打开**设置 → 上下文狙击手**即可看到面板与统计。

## 文件

- `lib/index.js` — 宿主半（检测、归档、检索工具、RPC 端点）。
- `lib/select.js` — token 预算选择 + 无损表面重写。
- `lib/archive.js` — 持久化归档存储（每次归档一个独立 JSON 文件）+ 关键词检索 + 全局统计扫描。
- `lib/config.js` — 配置解析。
- `lib/client.js` — 客户端半（设置面板：实时配置 + 实时统计）。
- `locale/en.json`、`locale/zh.json` — Plugin Manager 展示元数据（标题/描述）。
- `icon.svg` — Plugin Manager 卡片图标。
- `cordis.patch.yml` — 挂载补丁。

## 版本历史

### v0.12.1 — 修复「format v4 message requires a producer-owned source kind」

**根因：** 会话格式 v4 废弃了通用的 `source.kind: 'plugin'`。插件写入的每条消息
——归档标记与自动继续的 followup——都带着它，于是持久化 worker 在*编码*事件时
（还没落盘）就抛出 `format v4 message requires a producer-owned source kind`。内存
里的 append 仍然成功，所以裁剪看起来生效了，但存活会话后续每一次落盘都会重新抛出
同一个错误，直到重启——正是「裁完之后直接报错，后续再对话还是这个错误」的现象。

**修复：** 两类消息现在都带插件自己的生产者 kind `source.kind: 'context-sniper'`
（`purpose` 分别为 `archive-checkpoint` / `auto-continue`），与内置 `goal` /
`schedule` / `compact-checkpoint` 生产者同一模式。重置监听器仍只把 `user` / `model`
视为真实输入，自动继续上限不受影响；客户端把未知 context kind 渲染为中性注入行。
磁盘上的旧会话不受影响——v3→v4 迁移会在加载时重写它们的 `plugin` source。新增的
harness 段落会用真实的 `assertV4RowAdmission` 校验器逐条放行插件写入的每条消息（并
带一条「已废弃的 `plugin` kind 仍被拒绝」的哨兵断言），杜绝回归。

**加固：** 替换 append 现已包裹处理，在 shadow-price prune 已挂账之后若写入被拒，
会报出确切区间而非裸抛折叠错误。

### v0.12.0 — 在"已达到输出 token 上限"提示出现的同一时刻裁剪

**新触发器：** 插件现在监听驱动该 UI 提示的宿主事件——`turn/end` 且
`reason.kind === 'max-tokens'`，由 dsh-agent-loop 在某一步的流于输出 token
上限处结束时发出（`@deepseek-ai/dsh-session` 的
`TurnEndReasonMap['max-tokens']`；聊天客户端的提示匹配的就是同一个事件 +
reason）。收到该事件后，插件归档到表面预算并自动续写（每会话上限 3 次，
真实用户消息重置计数；续写额度用尽时裁剪仍会执行）。

原有的启发式截断检测（usage 比例 / 突然结尾）保留，用于覆盖不上报结束原因的
provider。两个触发器共享"每轮认领"（`truncationTurns`），保证同一截断轮至多
归档 + 续写一次——包括启发式检测尚未完成时权威 `turn/end` 到达的异步竞态。
测试覆盖：同轮去重、重复事件去重、`completed` 轮不触发、超出续写额度时只
裁剪不续写。

### v0.11.0 — 修复「统计加载失败」与裁剪不生效

**两个根因，均已在真实 `@deepseek-ai/dsh-session` 运行时上复现确认：**

1. **设置面板的 RPC 从未到达插件。** v0.10.0 通过
   `connection.rpc.intercept('/api', …)` 注册端点，但宿主 Typert 网关在启动时
   就注册了 `/api` 的**唯一**共享拦截器 —— `dsh-client-connection` 每个通道
   只允许一个拦截器，重复注册直接抛错。插件的注册被丢弃，网关对
   `context-sniper/*` 返回 404，面板每次调用都显示「统计加载失败」。现在插件
   在注入的 `webServer` 上挂载自己的 `/context-sniper` 前缀路由（插件生态的
   通行做法，dshmarket / dsh-better-sidebar 同款），应答与浏览器
   `connection.rpc.call` 完全一致的 `client-request` 信封，并套用与 Connection
   通道相同的 Host/Origin + 浏览器鉴权准入。（`connection.rpc.handle` 在这里
   不可用：它从 Connection 服务自身的 ctx 解析 `webServer`，而 `webServer` 是
   兄弟节点 —— 即 v0.8.0 的 HTTP 405 问题。）
2. **裁剪对 token 计量不可见。** 持久的 surface-token 投影只有在 surface
   `replace` 的紧邻前一个事件是武装了精确替换区间的 `compaction/prune`（或
   `compaction/summary`）影子价格事件时才会做扣减 —— 没有该声明的 replace 以
   **零**增量折叠，释放的空间永远不会体现在上下文压力里，下一次请求可能再次
   超时。现在每次归档都会在替换的同步相邻位置追加一条 `compaction/prune`
   （启发式影子价格，与 `dsh-compaction-basic` 和 tool-result pruner 一致）。

**加固：**
- 归档文件写入后的陈旧性守卫现在按 surface **索引**比较**整个**替换区间
  （不再只查两个端点），且用索引而非 seq 大小定位区间 —— 替换标记带着新 seq
  坐在旧位置，surface 上的 seq 并非数值递增。
- 超时/溢出恢复只有在替换确实提交（`surface.replaceGeneration` 前进）时才授权
  `{ kind: 'retry' }`；归档失败会转交内置压缩，而不是在原封不动的表面上再烧
  一次超时。
- 开启 `verbose: true` 后，归档失败会记录完整堆栈，现场反馈能带上确切错误。

### v0.10.0 — 适配 DSH 0.2.0-rc.1+，UI 全面重做

- **实时设置（`ctx.configForms`）**：面板改为通过共享设置镜像读写宿主配置
  （修订围栏写入、单字段恢复默认、只读连接提示），不再走自定义保存 RPC；
  `set-budget`/`set-search` 端点保留以兼容旧调用方。
- **全部使用主题令牌**：所有颜色均为 `--dsw-alias-*`，自动跟随明暗模式与宿主
  配色；不再有任何硬编码的浅色主题颜色。
- **接入 Client 语言服务**：所有可见文案走 locale 服务（命名空间
  `settings.contextSniper`，zh + en）；分区仅在宿主提供该命名空间时挂载
  （`whileServed`）。
- **实时归档统计**：新增 `stats` RPC 与"归档状态"卡片——跨会话总量 +
  最近归档列表。
- **功能修复**：被取消的请求（`signal.aborted`）无论失败码一律不重试；
  自动继续消息改带 `source.kind: 'plugin'`（此前 `user` 来源会让重置监听器
  清掉计数，令"最多 3 次"上限失效）；会话销毁（`session/disposed`）时清理
  每会话计数；检索工具卡片以 `search` 类型渲染；RPC 拦截器随插件卸载释放。
- **展示元数据**：`meta` 标题/描述 + `locale/en.json` + `locale/zh.json` +
  `icon.svg`，Plugin Manager 卡片正确显示。

### v0.8.1 — 适配 dsh 0.1.5-rc.3

**修复：归档路径不再因当前 DSH 的 session API 变更而崩溃，且不再尝试归档系统提示词。**

0.1.5-rc 一族的 session 日志表面改变了形态，而插件的归档仍用旧接口读取。三处修复，
全在 `lib/select.js`：

1. **`session.events` → `session.eventAt(seq)` / `session.snapshotEvents()`。**
   当前 `Session` 只通过 `eventAt(seq)`（O(1) 查单条）和 `snapshotEvents()`（冻结数组）
   暴露日志，**没有** `session.events` 这个活数组。归档的按 seq 查找改用
   `eventAt(seq)`，轮次分组改用 `snapshotEvents()`。
2. **`surfaceOp` 字段名 `start`/`end` → `startSeq`/`endSeq`。**
   `Session.append('user/message', marker, { surfaceOp: { op: 'replace', … } })`
   的替换契约现在把边界命名为 `startSeq`/`endSeq`（与内置 `dsh-compaction-basic`
   的检查点写法一致）；旧的 `start`/`end` 会被拒绝。
3. **系统提示词保护。** token 计量器会把渲染出的系统提示词（表面节点 0）计入节点，
   而当前 DSH 的不变量拒绝用非 system 消息替换节点 0（"node 0 holds the system
   prompt…"）。归档现在从**第一个非 system 表面节点**开始
   （`firstIdx = systemHead ? 1 : 0`，与 `dsh-compaction-basic` 一致），
   因此永不归档系统提示词，同时仍不会拆散 tool-call/result 配对。

`peerDependencies` 里的 `@deepseek-ai/dsh-*` 包对齐到 `>=0.1.5-rc.1`，与实测运行时一致。

### v0.8.0 — 修复设置面板 "transport failure … HTTP 405"

**修复的 Bug：设置面板加载配置时报
`无法加载配置: transport failure for /context-sniper/get-state: HTTP 405`。**

根本原因（DSH 0.1.5 一族）：组合配置把 `webserver` 与 `connection` 挂成**兄弟
行**——`connection` 行 `inject: [webRuntime]`，**并不注入 `webServer`**。而
`connection.rpc.handle(channel, handler)` 内部调用
`owner.webServer.register(...)`，其中 `owner` 是 **Connection 服务自身的 ctx**。
从那个 ctx 走 `webServer` 时，`webServer` 是*兄弟*而不是*祖先*，直接属性访问
解析不到（"cannot get property webServer without inject"），注册因此抛错、路由
从未挂载。设置面板的 POST 落到静态文件回退（只放行 GET），于是返回 **405**。
`/api` 通道之所以正常，是因为它内部走 `ctx.inject(["webServer"], ...)` 延迟注入
才拿到 `webServer`——这正是 `rpc.handle` 这条路径缺的东西。

修复：不再依赖 `connection.rpc.handle`，改为**直接注入 `webServer` 并注册
`/context-sniper` 前缀路由**（与 `dsh-better-sidebar` 等能正常注册路由的宿主插件
同一做法），再用 Connection transport 导出的 `clientRequestSchema` 校验浏览器
`connection.rpc.call` 发出的同一封 `client-request` 信封、按原样回 `server-response`。
同时套用 `/api` 同一道 Host/Origin + 浏览器鉴权围栏，保持回环通道不对外开放。
`peerDependencies` 新增 `@deepseek-ai/dsh-client-connection >=0.1.5-rc.1`。

> 注意：宿主插件在 DSH 进程启动时加载一次并被 ESM 缓存，因此本修复在**下一次
> DSH 进程重启后**生效（会话切换、`patchReload: live` 的热更新都不会重新执行
> 已缓存的宿主模块）。

### v0.7.0 — 适配 dsh 0.1.6-alpha.1

**适配 dsh 0.1.6 的 settings 与 connection API。**

dsh 0.1.6 一族有两处破坏性变化，需要在插件侧修改：

1. `@deepseek-ai/dsh-settings` 不再导出 `settingsNamespace()` 工厂函数。设置命名
   空间现在就是一个**纯字符串**（按 `/^[a-z][a-z0-9-]*$/` 校验），直接传给
   `settings.register` / `settings.get`。插件去掉 `settingsNamespace` 导入，改用
   原始命名空间 id `'dsh-context-sniper'`。
2. `connection.rpc.handle(channel, handler)` 不再接受第三个 options 参数。按端点的
   `{ authority: 'loopback' }` 限制被移除——信任与鉴权现在由 Connection transport
   统一施加。插件去掉该参数。

插件用到的其它 API（事件、服务、`session.append`/surface、带 `presentCall` 的
`defineTool`、`llm.resolveModelInfo`、`tokenMeter.measure`、`agents.get`/`followup`）
在 0.1.6 里都没有变化。`peerDependencies` 里的 `@deepseek-ai/dsh-*` 统一提升到
`>=0.1.6-alpha.1`。

### v0.6.2 — 适配 dsh 0.1.1-rc.2

**修复的 Bug：升级到 dsh 0.1.1 后，"输出截断"检测悄悄失效了。**

根本原因：插件读取模型的上下文窗口长度，用来判断一次输出是否顶到了输出上限
（当 `input + output ≥ 80%` 窗口时视为被截断）。它通过
`llm.resolveModelInfo(provider, model)` 取这个数字。在 dsh 0.1.1-rc.2 里，这个
调用返回的容量变成**对象**——`{ context: { contextWindow } }`——而更早的版本返回的是
裸数字（`{ context: 32768 }`）。插件原来写的是 `contextWindow = info?.context`，于是
拿到的是一个*对象*。`contextWindow === 0` 这道守卫能过（对象不等于 `0`），但真正的判断
`contextWindow > 0 && total >= contextWindow * 0.8` 变成了"对象 > 0"（结果是 `false`），
于是 80% 窗口这条规则永远不触发，"输出截断 → 归档 → 自动继续"这条链路就死了。
其余恢复路径（`agent/request-error` 的超时/溢出恢复、`context_sniper_recall` 检索工具、
设置面板）都不受影响——插件用到的 0.1.1 其它 API（事件、服务、
`session.append`/surface、`defineTool`、settings、RPC、slots）都没有变化。

修复：
- 读取窗口时兼容两种形状，新旧 API 都能用：
  `typeof context === 'number' ? context : context?.contextWindow`；
- "自动继续"提示现在以**带身份**的消息发出（带一个稳定的 `id`），与 DSH 自身的
  `createUserMessage` 保持一致——收件箱会把它原样追加为 `user/message` 表面事件，
  带身份的消息能干净地通过会话 surface 与持久化往返。文案内容不变。

### v0.6.1 — 设置现在真正持久化了

**修复的 Bug：每次重启所有设置都会恢复成默认值。**

根本原因：设置 schema 用 `z.number().int()` 构造，但 Schemastery 这个 schema
库**根本没有 `int()` 方法**（它提供的是 `number`、`natural`、`percent`，以及
实例方法 `min`/`max`/`step`/`default`）。所以 `z.object({...})` 在插件注册设置
命名空间的那一刻就抛出 `TypeError`；这个失败被 try/catch 吞掉，owner `scope`
一直是 `null`。`scope` 为 null 时，设置面板仍然会更新内存里的值（所以会话内
裁剪行为正常），但**从来没有把任何值写进 DSH 设置文档**——于是下次启动时
所有值都回退到组合配置的默认值。这也解释了为什么 `~/.dsh/settings.yaml` 里
压根没有 `dsh-context-sniper` 这一段。

修复：
- 整数约束改用合法的 `step(1)` 形式（`z.number().step(1)…`）；同时
  `surfaceTokenBudget` 不再强制 1024 的倍数（这样任意 ≥ 1024 的整数都能持久化）；
- 保存 RPC 现在**先持久化、只有写入真正提交后才更新内存值**，并且把真实错误
  回报给面板，而不是虚假的"已保存"；当值只在会话内生效、无法持久化（降级模式，
  未挂载设置服务）时，面板会显示一条提示。

### v0.6.0

- 无损归档 + 检索、超时/截断/溢出恢复、检索工具、设置面板。

## 局限

- 关键词检索是确定性子串匹配，非语义检索——请用它实际会出现的词来查询。
- 单条消息超过预算时无法拆分；如果整个表面就是一条超大消息，插件回退到内置压缩。
- Token 估算来自 DSH token meter 的启发式（字符定价），非真实 tokenizer。
