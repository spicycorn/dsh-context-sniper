# dsh-context-sniper

Lossless context archival + retrieval for DeepSeek Harness.

When a long conversation overflows the model's context window (the UI shows
“已重试模型请求” / “上下文输出已满”, and the provider reports
`CONTEXT_WINDOW_EXCEEDED`), this plugin:

1. keeps only the newest **N rounds** in the model surface,
2. archives the older rounds **verbatim** to a durable per-session file (nothing is summarized or lost),
3. rewrites the surface with one compact marker that tells the model how to get the content back,
4. authorizes the retry.

If it cannot free enough context, it falls through to the built-in
`dsh-compaction-basic` summarizer as the safety net. The model retrieves
archived content with the `context_sniper_recall` tool.

> **English | [中文](README.zh.md)**

## Why a separate plugin

`dsh-compaction-basic` already recovers from overflow — but by *summarizing*
(lossy). This plugin is complementary: it recovers by *archiving* (lossless)
and gives the model a door back into the exact archived text. It does not
modify any DSH base parameter and does not disable the built-in compaction.

## What you configure

One knob matters to you: **`keepRounds` (N)** — how many recent rounds to keep
in context when archiving. Set it:

- in the **Settings → Context Sniper** panel (the number input), or
- in the DSH settings document (namespace `dsh-context-sniper`), or
- in the composition (`config.keepRounds`).

Everything else has a sane default (see “Configuration”).

## How it detects overflow

Detection is based on the **provider's structured API error response** (HTTP
status + error code), not on text matching of model output. When the LLM API
returns a context-window failure, the DSH LLM adapter sets
`failure.code = "CONTEXT_WINDOW_EXCEEDED"`; the agent loop then surfaces it
through the `agent/request-error` waterfall. A model that *outputs* the words
"context window exceeded" in a successful response does **not** trigger this
event.

This plugin registers the listener with `prepend: true` so it is the
outermost wrapper and acts first:

- it archives the oldest rounds (keeping the newest N), and
- returns a terminal `{ kind: "retry" }`, so the request re-runs against the
  shrunken context — and the built-in lossy compaction never runs.

If there is nothing safe to archive (the surface is already minimal), it calls
`next()` and the built-in compaction handles the remainder.

Optionally, set `pressureRatio` (e.g. `0.8`) to archive *proactively* once
measured pressure crosses that fraction of the routed context window, avoiding
the hard failure entirely. Off by default (`0`).

## The recall tool

`context_sniper_recall(query)` — keyword search over the session's archive.
Returns matching archived messages verbatim (newest first), each with role,
turn, and a snippet. The model should call it whenever it needs facts,
decisions, file contents, or instructions from earlier in the session that are
no longer visible.

## Archive format

One JSONL record per archival event, under the harness home:
`<DSH_HOME>/context-sniper/<sessionId>.jsonl`. Each record:

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

## Settings panel

Registers a **Settings → Context Sniper** section with:

- a live **token progress bar** (from the token-meter's `contextPressure` feed),
- the **retained rounds (N)** and an input to change it,
- the **archive count** (batches / messages) and path for the active session,
- a hint pointing at the `context_sniper_recall` tool.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `keepRounds` | `20` | Recent rounds to keep in context when archiving (N). |
| `pressureRatio` | `0` | Proactively archive at this fraction of the window; `0` = only react to provider overflow. |
| `maxSearchHits` | `8` | Max archived messages returned per recall query. |
| `hitMaxChars` | `4000` | Max chars of each archived message included in a hit. |
| `archiveDir` | `context-sniper` | Archive directory under the harness home. |
| `verbose` | `false` | Log every archival decision at info level. |

## Install

```
dsh plugin --profile web add github:spicycorn/dsh-context-sniper
```

This one command installs the package into the profile and **automatically
mounts it** (the `dsh.bundle.patch` field in `package.json` causes the profile
composer to append it to `dsh.profile.bundles` on every boot — no manual edits).

Restart DSH to activate. Open **Settings → Context Sniper** to verify.

> **Local development:** first link the peer dependencies, then install by path:
>
> ```
> cd dsh-context-sniper
> node scripts/link-deps.mjs   # creates node_modules links to the DSH profiles
> dsh plugin --profile web add .
> ```

## Files

- `lib/index.js` — host half (detection, archival, recall tool, settings, RPC).
- `lib/select.js` — round grouping + lossless surface rewrite.
- `lib/archive.js` — durable JSONL archive store + keyword search.
- `lib/config.js` — config resolution.
- `lib/client.js` — client half (settings panel).
- `lib/client-api.js` — shared RPC channel/endpoint names.
- `cordis.patch.yml` — mount patch.

## Limitations

- Keyword search is deterministic substring matching, not semantic — query with
  the terms you actually expect to appear. (A semantic backend such as
  OpenViking can be layered on later without changing this plugin's archive.)
- Rounds are DSH *turns*; a very long single round cannot be split, so an
  indivisible oversized round falls back to the built-in compaction.
- The token progress bar reflects the token-meter's heuristic/provider feed and
  is an approximation, not a billing figure.
