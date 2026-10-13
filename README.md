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

Works with **DSH 0.2.0-rc.1+** (verified against 0.2.0-rc.1 / rc.2).

## Why a separate plugin

`dsh-compaction-basic` already recovers from overflow — but by *summarizing*
(lossy). This plugin is complementary: it recovers by *archiving* (lossless)
and gives the model a door back into the exact archived text. It does not
modify any DSH base parameter and does not disable the built-in compaction.

## What you configure

Three knobs are user-facing, all editable in **Settings → Context Sniper**
(live-saved through the DSH settings mirror — durable, hot-reloadable, no
restart):

- **`surfaceTokenBudget`** — the maximum estimated tokens to keep on the model
  surface. Everything older is archived. This is the *only* budget parameter;
  there is no separate "default budget".
- **`maxSearchHits`** — how many archived messages `context_sniper_recall`
  returns per query (1–64, default 8).
- **`hitMaxChars`** — how many characters of each archived message are included
  in a hit (200–20000, default 4000).

You can also set any of them (plus `pressureRatio`, `archiveDir`, `verbose`)
in the DSH settings document (namespace `dsh-context-sniper`) or in the
composition (`config.*`). Everything has a sane default (see "Configuration").

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
`next()` and the built-in compaction handles the remainder. A cancelled
request (`signal.aborted`) is never retried.

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
`surfaceOp: { op: 'replace', startSeq, endSeq }` (the same mechanism the
built-in `dsh-compaction-basic` uses) that shadows the archived range in the
model surface. The original events stay in the durable log; only the
model-visible surface changes.

**The marker's `data.id` is mandatory.** DSH's session-load boundary
(`assertMessageEventShape` in `@deepseek-ai/dsh-session`) rejects any
`user/message` whose `data.id` is not a non-empty string, throwing
`session event at seq N lacks an identified message` and making the **whole
session unloadable** (`SessionPersistenceCorruptionError`). Earlier plugin
versions omitted `id`, which is exactly the corruption users saw. This release
always mints a non-empty `id` (the archive UUID) and a `source.kind` of
`plugin`, so every marker round-trips losslessly through DSH persistence and
the session loads cleanly after a trim.

### The marker is a directive, not just a notice

A trim is **not** a session restart — the model should continue the task it was
working on. But an earlier marker only *notified* the model that content had
been archived, so the model often "restarted": re-reading files, re-introducing
itself, re-planning — which burns extra tokens and time and can re-overflow the
window. This release makes the marker an explicit instruction to the model:

- *"This is a context-archive checkpoint — NOT a session restart. You were
  mid-task; continue exactly where you left off."*
- *"Do not re-read files, re-introduce yourself, or re-plan from scratch."*
- *"If you are missing facts, decisions, file contents, or instructions that
  are no longer visible, call `context_sniper_recall("<keyword>")` to retrieve
  the archived text verbatim."*
- *"Retrieve before you rely on it — do not guess at archived content."*

Because the marker also removes the archived range from the model surface
(`surfaceOp: replace`), the retried request has a **shorter prompt** and a
**faster prefill** — the whole point of trimming. The directive text keeps the
model on-task so it does not undo that speedup by re-exploring.

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

Registers a **Settings → Context Sniper** section (zh/en localized, theme
tokens only — it follows light/dark automatically):

- **Settings card** — the three editable values above, read and written
  **live** through the shared settings mirror (`ctx.configForms`): every edit
  is validated, revision-fenced, and persisted immediately; a per-field
  **Reset** clears the override back to the composition default. No save
  button, no restart.
- **Archive status card** — live statistics across all sessions: archived
  sessions / batches / messages, cumulative tokens freed, last archive time,
  and a newest-first list of recent archives (project · messages · tokens ·
  reason · time), with a refresh button.
- The plugin **version** chip in the header, read from the host at open time.

The section only appears while the Host actually serves the
`dsh-context-sniper` settings namespace.

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

Install the published package as a bundle (Plugin Manager in the Web UI, or
the DSH CLI):

```
dsh plugin --profile web add github:spicycorn/dsh-context-sniper
```

The `dsh.bundle.patch` field in `package.json` makes the profile composer
mount `cordis.patch.yml` automatically on every boot — no manual patch edits.
Restart DSH (or let the Plugin Manager hot-activate the bundle), then open
**Settings → Context Sniper** to verify the panel and statistics.

## Files

- `lib/index.js` — host half (detection, archival, recall tool, RPC endpoints).
- `lib/select.js` — token-budget selection + lossless surface rewrite.
- `lib/archive.js` — durable archive store (one JSON file per archival event) + keyword search + global stats scan.
- `lib/config.js` — config resolution.
- `lib/client.js` — client half (settings panel: live config + live stats).
- `locale/en.json`, `locale/zh.json` — Plugin Manager display metadata (title/description).
- `icon.svg` — plugin icon for Plugin Manager cards.
- `cordis.patch.yml` — mount patch.

## Version history

### v0.10.0 — DSH 0.2.0-rc.1+ adaptation + full UI overhaul

**Adapted to the current DSH and rebuilt the settings UI on host patterns.**

- **Live settings through `ctx.configForms`**: the panel now reads and writes
  the host config over the shared settings mirror (revision-fenced writes,
  per-field reset to the composition default, read-only notice for
  non-writable connections) instead of custom save RPCs. The
  `set-budget`/`set-search` endpoints remain for API compatibility.
- **Theme tokens only**: every color is a `--dsw-alias-*` token, so the panel
  follows light/dark and the host palette; no more hardcoded light-theme
  colors.
- **Locale service**: all visible strings go through the Client locale
  service (namespace `settings.contextSniper`, zh + en). The section mounts
  only while the Host serves the namespace (`whileServed`).
- **Live archive statistics**: new `stats` RPC + an "Archive status" card —
  totals across all sessions and a recent-archives list.
- **Functional fixes**: a cancelled request (`signal.aborted`) is never
  retried regardless of failure code; the auto-continue message now carries
  `source.kind: 'plugin'` (a `user` source made the reset listener clear the
  continue counter, defeating the max-3 cap); per-session counters are dropped
  on `session/disposed`; the recall tool card renders as a `search`-kind
  call; the RPC interceptor is disposed with the plugin.
- **Display metadata**: `meta` title/description + `locale/en.json` +
  `locale/zh.json` + `icon.svg` so Plugin Manager cards render properly.

### v0.8.1 — compatibility with dsh 0.1.5-rc.3

**Fixed: the archival path no longer crashes against the current DSH session
API, and it no longer tries to archive the system prompt.**

The session log surface changed shape in the 0.1.5-rc line, and the plugin's
archival read it through the old accessors. Three fixes, all in `lib/select.js`:

1. **`session.events` → `session.eventAt(seq)` / `session.snapshotEvents()`.**
   The current `Session` exposes its log only through `eventAt(seq)` (O(1)
   lookup) and `snapshotEvents()` (a frozen array) — there is no live
   `session.events` array. The archival's per-seq lookups now use
   `eventAt(seq)` and the round-grouping uses `snapshotEvents()`.
2. **`surfaceOp` field names `start`/`end` → `startSeq`/`endSeq`.** The
   `Session.append('user/message', marker, { surfaceOp: { op: 'replace', … } })`
   replacement contract now names the bounds `startSeq`/`endSeq` (the same as
   the built-in `dsh-compaction-basic` checkpoint writer); the old
   `start`/`end` keys are rejected.
3. **System-prompt protection.** The token meter prices the rendered system
   prompt (surface node 0) as a node, and the current DSH invariant refuses to
   replace node 0 with a non-system message ("node 0 holds the system prompt…").
   The archival now starts at the first *non-system* surface node
   (`firstIdx = systemHead ? 1 : 0`, mirroring `dsh-compaction-basic`) so it
   never archives the prompt, while still never splitting a tool-call/result
   pair.

`peerDependencies` on the `@deepseek-ai/dsh-*` packages are aligned to
`>=0.2.0-rc.1` to match the verified runtime.

### v0.8.0 — fixed "transport failure … HTTP 405" in the settings panel

**Bug fixed: the settings panel failed to load config with
`transport failure for /context-sniper/get-state: HTTP 405`.**

Root cause (DSH 0.1.5 family): the composition mounts `webserver` and
`connection` as **sibling** rows — the `connection` row declares
`inject: [webRuntime]`, and does **not** inject `webServer`. The transport's
own `connection.rpc.handle(channel, handler)` internally calls
`owner.webServer.register(...)`, where `owner` is the **Connection service's own
ctx**. Resolving `webServer` from that ctx walks the ancestor chain, but
`webServer` is a *sibling*, not an ancestor, so the direct property access
throws ("cannot get property `webServer` without inject"), the registration is
dropped, and the route is never mounted. The settings panel's POST then falls
through to the static-file fallback (GET-only), which returns **405**. The
`/api` channel works only because it reaches `webServer` through a deferred
`ctx.inject(["webServer"], …)` — exactly what the `rpc.handle` path lacks.

Fix: stop relying on `connection.rpc.handle`. The plugin now **injects
`webServer` itself and registers the `/context-sniper` prefix route directly**,
then answers the identical `client-request` envelope the browser's
`connection.rpc.call` emits. It also applies the same Host/Origin +
browser-auth fence the `/api` route uses, so the loopback channel is not
exposed to other origins.

> **Note:** the host half is loaded once at DSH process start and is
> ESM-cached, so this fix takes effect on the **next DSH process restart**
> (session switches and `patchReload: live` re-application do not re-execute an
> already-cached host module).

### v0.7.0 — compatibility with dsh 0.1.6-alpha.1

**Adapted to the dsh 0.1.6 settings and connection API.**

Two breaking changes in the dsh 0.1.6 family required plugin-side updates:

1. `@deepseek-ai/dsh-settings` no longer exports the `settingsNamespace()`
   factory. A settings namespace is now a plain string (validated against
   `/^[a-z][a-z0-9-]*$/`), passed directly to `settings.register` /
   `settings.get`. The plugin drops the `settingsNamespace` import and uses the
   raw namespace id `'dsh-context-sniper'`.
2. `connection.rpc.handle(channel, handler)` no longer accepts an options third
   argument. The per-endpoint `{ authority: 'loopback' }` restriction is gone —
   trust and authentication are now applied uniformly by the Connection
   transport. The plugin drops that argument.

### v0.6.2 — compatibility with dsh 0.1.1-rc.2

**Bug fixed: output-truncation detection silently stopped firing after the
dsh 0.1.1 update.**

Root cause: the plugin reads the model's context window to decide that a
completion hit the output cap (it treats a response as truncated when
`input + output ≥ 80%` of the window). It fetched that figure via
`llm.resolveModelInfo(provider, model)`. In dsh 0.1.1-rc.2 that call now
returns the capacity as an **object** — `{ context: { contextWindow } }` —
whereas earlier releases returned a bare number (`{ context: 32768 }`). The
plugin did `contextWindow = info?.context`, so it now held an *object*, and
the numeric comparison silently never fired.

Fix:
- read the window from whichever shape is present, so the detector works on
  both the old (number) and new (`{ contextWindow }`) API:
  `typeof context === 'number' ? context : context?.contextWindow`;
- the auto-continue prompt is now sent as a fully-identified message (a stable
  `id`), matching DSH's own `createUserMessage`.

### v0.6.1 — settings now actually persist

**Bug fixed: every setting reverted to its default on restart.**

Root cause: the settings schema was built with `z.number().int()`, but the
Schemastery schema library has **no `int()` method** (it exposes `number`,
`natural`, `percent`, plus instance methods `min`/`max`/`step`/`default`). So
`z.object({...})` threw a `TypeError` the moment the plugin registered its
settings namespace; the failure was caught and the owner `scope` stayed `null`,
so nothing was ever written to the DSH settings document.

Fix:
- integer constraints are now expressed with the valid `step(1)` form
  (`z.number().step(1)…`), and the `surfaceTokenBudget` field no longer
  forces a multiple-of-1024 (so any integer ≥ 1024 persists);
- the save RPC handlers now **persist first and only apply the in-memory value
  if the write committed**, and report the real error instead of a false
  "saved".

### v0.6.0

- Lossless archival + retrieval, timeout/truncation/overflow recovery, recall
  tool, settings panel.

## Limitations

- Keyword search is deterministic substring matching, not semantic — query with
  the terms you actually expect to appear. (A semantic backend such as
  OpenViking can be layered on later without changing this plugin's archive.)
- A single message that exceeds the budget cannot be split; if the entire
  surface is one oversized message, the plugin falls through to built-in
  compaction.
- The token estimates come from the DSH token meter's heuristic (character-based
  pricing), not a real tokenizer. They are conservative approximations.
