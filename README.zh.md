# dsh-context-sniper（上下文狙击手）

DeepSeek Harness 的**无损上下文归档 + 检索**插件。

当长对话撑爆模型上下文窗口（界面出现“已重试模型请求 / 上下文输出已满”，provider 报告
`CONTEXT_WINDOW_EXCEEDED`）时，本插件会：

1. 只保留最近 **N 轮**对话在模型上下文里；
2. 把更早的轮次**原样**归档到每个会话独立的持久化文件（不做摘要、不丢失）；
3. 用一条紧凑的“已归档”标记替换被移出的内容，并告诉模型如何取回；
4. 授权重试请求。

如果归档后仍不够（或表面已经很小），则回退到内置的 `dsh-compaction-basic`
做有损摘要兜底。模型通过 `context_sniper_recall` 工具检索归档内容。

> **[English](README.md) | 中文**

## 为什么单独做一个插件

`dsh-compaction-basic` 已经在做溢出恢复——但靠的是**摘要**（有损）。本插件是互补的：
靠**归档**（无损）恢复，并给模型一扇回到原文的门。它不改动任何 DSH 底层参数，
也不会关掉内置压缩。

## 你需要配置什么

真正重要的只有一个：**`keepRounds`（N）**——归档时保留最近几轮。可设置于：

- **设置 → Context Sniper** 面板（数字输入框），或
- DSH 设置文档（命名空间 `dsh-context-sniper`），或
- 组合配置（`config.keepRounds`）。

其余都有合理默认值（见“配置”）。

## 如何检测溢出

识别基于 **provider 的结构化 API 错误响应**（HTTP 状态码 + 错误码），而非对模型输出
文本的匹配。当 LLM API 返回上下文窗口溢出错误时，DSH 的 LLM adapter 设置
`failure.code = "CONTEXT_WINDOW_EXCEEDED"`，agent 循环通过 `agent/request-error` 瀑布
将其暴露。模型在成功响应中**输出**"上下文窗口已满"这类文字**不会**触发此事件。

本插件以 `prepend: true` 注册该监听器，使其成为最外层包裹、最先行动：

- 归档最早的若干轮（保留最近 N 轮）；
- 返回终结动作 `{ kind: "retry" }`，请求随即针对收缩后的上下文重跑——内置有损压缩因此不会执行。

若没有可安全归档的内容（表面已最小），则调用 `next()`，交给内置压缩兜底。

可选：设置 `pressureRatio`（如 `0.8`），在测量压力超过窗口该比例时**提前**归档，
避免硬失败。默认关闭（`0`）。

## 检索工具

`context_sniper_recall(query)`——对当前会话的归档做关键词检索，按原文返回匹配的消息
（最新在前），每条带角色、轮次与片段。模型在需要本会话早期、已不可见的事实、决策、
文件内容或指令时调用它。

## 归档格式

每次归档事件一条 JSONL 记录，位于 harness 家目录下：
`<DSH_HOME>/context-sniper/<sessionId>.jsonl`。每条记录：

```jsonc
{
  "archiveId": "…",
  "sessionId": "…",
  "archivedAt": 1717000000000,
  "fromSeq": 3, "toSeq": 27,
  "rounds": [1, 2, 3],
  "keepRounds": 20,
  "reason": "context-overflow",
  "messages": [
    { "turn": 1, "role": "user", "text": "…" },
    { "turn": 1, "role": "assistant", "text": "…" },
    { "turn": 1, "role": "tool", "name": "…", "text": "…" }
  ]
}
```

## 设置面板

注册一个 **设置 → Context Sniper** 分区，包含：

- **Token 进度条**（来自 token-meter 的 `contextPressure` 实时数据）；
- **保留轮数（N）**及修改输入框；
- 当前会话的**归档条数**（批数 / 消息数）与路径；
- 指向 `context_sniper_recall` 工具的提示。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `keepRounds` | `20` | 归档时保留的最近轮数（N）。 |
| `pressureRatio` | `0` | 在窗口该比例处提前归档；`0` = 仅在 provider 溢出时反应。 |
| `maxSearchHits` | `8` | 每次检索返回的最大归档消息数。 |
| `hitMaxChars` | `4000` | 每条命中消息的最大字符数。 |
| `archiveDir` | `context-sniper` | harness 家目录下的归档目录。 |
| `verbose` | `false` | 以 info 级别记录每次归档决策。 |

## 安装

```
dsh plugin --profile web add github:spicycorn/dsh-context-sniper
```

这一条命令完成安装并**自动挂载**（`package.json` 中的 `dsh.bundle.patch` 字段
会在 profile 启动时自动把本包加入 `dsh.profile.bundles`——无需手动编辑）。

重启 DSH 生效。打开 **设置 → Context Sniper** 确认。

> **本地开发：** 先链接 peer 依赖，再按路径安装：
>
> ```
> cd dsh-context-sniper
> node scripts/link-deps.mjs   # 在本地 node_modules 中创建指向 DSH profiles 的链接
> dsh plugin --profile web add .
> ```

## 文件

- `lib/index.js` — 宿主半（检测、归档、检索工具、设置、RPC）。
- `lib/select.js` — 轮次分组 + 无损表面重写。
- `lib/archive.js` — 持久化 JSONL 归档存储 + 关键词检索。
- `lib/config.js` — 配置解析。
- `lib/client.js` — 客户端半（设置面板）。
- `lib/client-api.js` — 共享 RPC 通道 / 端点名。
- `cordis.patch.yml` — 挂载补丁。

## 局限

- 关键词检索是确定性子串匹配，非语义检索——请用它实际会出现的词来查询。（之后可在不改动
  本插件归档的前提下，叠加 OpenViking 等语义后端。）
- “轮”即 DSH 的 *turn*；单个超长轮次无法拆分，因此不可分的超大轮次会回退到内置压缩。
- Token 进度条反映 token-meter 的启发式 / provider 数据，是近似值，非计费数字。
