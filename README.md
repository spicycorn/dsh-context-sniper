# dsh-context-sniper

Lossless context archival + retrieval for DeepSeek Harness.

When a long conversation causes the local model to timeout during prefill (the
provider reports `pi-ai stream idle timeout`), or overflows the context window
(`CONTEXT_WINDOW_EXCEEDED`), this plugin:

1. keeps only the newest **messages** (up to a token budget) in the model surface,
2. archives the older messages **verbatim** to a durable per-session file (nothing is summarized or lost),
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

One knob matters to you: **`surfaceTokenBudget`** — the maximum estimated
tokens to keep on the model surface. Everything older is archived. Set it:

- in the **Settings → Context Sniper** panel (the number input), or
- in the DSH settings document (namespace `dsh-context-sniper`), or
- in the composition (`config.surfaceTokenBudget`).

Everything else has a sane default (see "Configuration").

## How it works

Detection is based on the **provider's structured API error response** (HTTP
status + error code). When the LLM API returns a timeout or context-window
failure, the DSH LLM adapter sets `failure.code`; the agent loop then surfaces
it through the `agent/request-error` waterfall.

This plugin registers the listener with `prepend: true` so it is the
outermost wrapper and acts first:

- it archives the oldest messages until the surface fits within the token budget,
- returns a terminal `{ kind: "retry" }`, so the request re-runs against the
  shrunken context — and the built-in lossy compaction never runs.

If there is nothing safe to archive (the surface is already minimal), it calls
`next()` and the built-in compaction handles the remainder.

Optionally, set `pressureRatio` (e.g. `0.8`) to archive *proactively* once
surface tokens cross that fraction of the budget, avoiding the hard failure
entirely. Off by default (`0`).

## Archival granularity

Archival is at **single-message** granularity. The surface is a sequence of
priced nodes (each one a user message, assistant message, or tool result).
The plugin walks from the newest node backwards, accumulating tokens until
the budget is met. Everything older is archived. A tool-pairing safety check
ensures the cut never splits a tool-call from its result.

## Marker validity (why trimming no longer corrupts the session)

When the plugin trims, it appends one compact `user/message` marker carrying
`surfaceOp: { op: 'replace', start, end }` (the same mechanism the built-in
`dsh-compaction` uses) that shadows the archived range in the model surface.
The original events stay in the durable log; only the model-visible surface
changes.

**The marker's `data.id` is mandatory.** DSH's session-load boundary
(`assertMessageEventShape` in `@deepseek-ai/dsh-session`) rejects any
`user/message` whose `data.id` is not a non-empty string, throwing
`session event at seq N lacks an identified message` and making the **whole
session unloadable** (`SessionPersistenceCorruptionError`). Earlier plugin
versions omitted `id`, which is exactly the corruption users saw. This release
always mints a non-empty `id` (the archive UUID) and a `source.kind` of
`plugin`, so every marker round-trips losslessly through DSH persistence and
the session loads cleanly after a trim.

## The recall tool

`context_sniper_recall(query)` — keyword search over the session's archive.
Returns matching archived messages verbatim (newest first), each with role,
turn, and a snippet. The model should call it whenever it needs facts,
decisions, file contents, or instructions from earlier in the session that
are no longer visible.

## Archive format

One JSON file per archival event, stored **inside the DSH session directory**
so the archive lives alongside the session log it was trimmed from:

```
<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/context-sniper/<archiveId>.json
```

`<projectKey(cwd)>` and `<encodeSegment(sessionId)>` are computed with the
exact same algorithms DSH's `dsh-session-persistence-jsonl` backend uses for
the `session.jsonl.zstd` location, so the archive lands in the very directory
that owns the session. The `context-sniper/` subdirectory is invisible to
DSH's session enumeration (it only treats a directory as a session when it
contains a `session.jsonl[.zstd]` file), so it never interferes with DSH's
storage, listing, or loading.

Each file contains a single archival record:

```jsonc
{
  "archiveId": "…",
  "sessionId": "…",
  "archivedAt": 1717000000000,
  "fromSeq": 3, "toSeq": 27,
  "messageCount": 15,
  "freedTokens": 42000,
  "budget": 32768,
  "reason": "timeout",
  "messages": [
    { "role": "user", "text": "…" },
    { "role": "assistant", "text": "…" },
    { "role": "tool", "name": "…", "text": "…" }
  ]
}
```

Each file is small and bounded (one archival event), so the store never
accumulates a single large file.

## Settings panel

Registers a **Settings → Context Sniper** section with:

- the **surface token budget** and an input to change it,
- the **archive count** (batches / messages) and path for the active session,
- a hint pointing at the `context_sniper_recall` tool.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `surfaceTokenBudget` | `32768` | Maximum tokens to retain on the model surface. |
| `pressureRatio` | `0` | Proactively archive at this fraction of the budget; `0` = only react to timeout. |
| `maxSearchHits` | `8` | Max archived messages returned per recall query. |
| `hitMaxChars` | `4000` | Max chars of each archived message included in a hit. |
| `archiveDir` | `context-sniper` | Archive subdirectory inside each DSH session directory. |
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
- `lib/select.js` — token-budget selection + lossless surface rewrite.
- `lib/archive.js` — durable archive store (one JSON file per archival event) + keyword search.
- `lib/config.js` — config resolution.
- `lib/client.js` — client half (settings panel).
- `cordis.patch.yml` — mount patch.

## Limitations

- Keyword search is deterministic substring matching, not semantic — query with
  the terms you actually expect to appear. (A semantic backend such as
  OpenViking can be layered on later without changing this plugin's archive.)
- A single message that exceeds the budget cannot be split; if the entire
  surface is one oversized message, the plugin falls through to built-in
  compaction.
- The token estimates come from the DSH token meter's heuristic (character-based
  pricing), not a real tokenizer. They are conservative approximations.
