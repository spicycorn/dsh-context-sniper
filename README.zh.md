# dsh-context-sniper（上下文狙击手）

DeepSeek Harness 的**无损上下文归档 + 检索**插件。

当长对话导致本地模型 prefill 超时（provider 报告
`pi-ai stream idle timeout`）或撑爆上下文窗口（`CONTEXT_WINDOW_EXCEEDED`）时，
本插件会：

1. 只保留最近的**消息**（至多 token 预算）在模型上下文里；
2. 把更早的消息**原样**归档到每个会话独立的持久化文件（不做摘要、不丢失）；
3. 用一条紧凑的"已归档"标记替换被移出的内容，并告诉模型如何取回；
4. 授权重试请求。

如果归档后仍不够（或表面已经很小），则回退到内置的 `dsh-compaction-basic`
做有损摘要兜底。模型通过 `context_sniper_recall` 工具检索归档内容。

> **[English](README.md) | 中文**

## 为什么单独做一个插件

`dsh-compaction-basic` 已经在做溢出恢复——但靠的是**摘要**（有损）。本插件是互补的：
靠**归档**（无损）恢复，并给模型一扇回到原文的门。它不改动任何 DSH 底层参数，
也不会关掉内置压缩。

## 你需要配置什么

真正重要的只有一个：**`surfaceTokenBudget`**——模型表面保留的最大 token 数。
更早的消息全部归档。可设置于：

- **设置 → Context Sniper** 面板（数字输入框），或
- DSH 设置文档（命名空间 `dsh-context-sniper`），或
- 组合配置（`config.surfaceTokenBudget`）。

其余都有合理默认值（见"配置"）。

## 如何工作

识别基于 **provider 的结构化 API 错误响应**。当 LLM API 返回超时或
上下文窗口溢出错误时，DSH 的 LLM adapter 设置 `failure.code`，agent 循环
通过 `agent/request-error` 瀑布将其暴露。

本插件以 `prepend: true` 注册该监听器，使其成为最外层包裹、最先行动：

- 从最旧消息开始归档，直到表面 token ≤ 预算；
- 返回终结动作 `{ kind: "retry" }`，请求随即针对收缩后的上下文重跑——
  内置有损压缩因此不会执行。

若没有可安全归档的内容（表面已最小），则调用 `next()`，交给内置压缩兜底。

可选：设置 `pressureRatio`（如 `0.8`），在表面 token 超过预算该比例时**提前**
归档，避免硬失败。默认关闭（`0`）。

## 归档粒度

归档以**单条消息**为单位。表面是一组带 token 定价的节点（每条 user message、
assistant message 或 tool result）。插件从最新节点向前累加 token，达到预算时
停止，更早的全部归档。工具调用配对安全检查确保切割不会把 tool-call 和
其 result 拆散。

## 检索工具

`context_sniper_recall(query)`——对当前会话的归档做关键词检索，按原文返回匹配的消息
（最新在前），每条带角色、轮次与片段。模型在需要本会话早期、已不可见的事实、决策、
文件内容或指令时调用它。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `surfaceTokenBudget` | `32768` | 模型表面保留的最大 token 数。 |
| `pressureRatio` | `0` | 在预算该比例处提前归档；`0` = 仅在超时时反应。 |
| `maxSearchHits` | `8` | 每次检索返回的最大归档消息数。 |
| `hitMaxChars` | `4000` | 每条命中消息的最大字符数。 |
| `archiveDir` | `context-sniper` | harness 家目录下的归档目录。 |
| `verbose` | `false` | 以 info 级别记录每次归档决策。 |

## 安装

```
dsh plugin --profile web add github:spicycorn/dsh-context-sniper
```

## 文件

- `lib/index.js` — 宿主半（检测、归档、检索工具、设置、RPC）。
- `lib/select.js` — token 预算选择 + 无损表面重写。
- `lib/archive.js` — 持久化 JSONL 归档存储 + 关键词检索。
- `lib/config.js` — 配置解析。
- `lib/client.js` — 客户端半（设置面板）。
- `cordis.patch.yml` — 挂载补丁。

## 局限

- 关键词检索是确定性子串匹配，非语义检索——请用它实际会出现的词来查询。
- 单条消息超过预算时无法拆分；如果整个表面就是一条超大消息，插件回退到内置压缩。
- Token 估算来自 DSH token meter 的启发式（字符定价），非真实 tokenizer。
