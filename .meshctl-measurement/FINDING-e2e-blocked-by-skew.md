# The live E2E half cannot be run on this mesh — the running build predates the feature

**Stamped `Sat Aug 15 02:4xZ` (`date -u` at writing), lane tip `f0d59d8d`.**

## What happened

The E2E stage requires a user team from **outside** the build, docs as its only map, that has never
read the diff. Two seats ran it. The **docs half passed**. The **live half is blocked**, and the
reason is not a defect in the code under review.

`mc-e2e-user-2` was launched with `capabilities: [connection]` specifically to exercise the four
live checks. It reported **HIGH: capability declared but tools absent** — `cotal_orientation` prints
`• capabilities: connection` while the same card's tool listing contains neither `cotal_disconnect`
nor `cotal_connect`. It explicitly refused to choose between the two causes it could see (grant not
applied vs. tools not projected) and filed the disagreement instead. **Both of its candidates are
wrong, and its refusal to guess is why the third cause was still available to find.**

## The measured cause — three arms, each falsifiable

| # | measurement | result |
| --- | --- | --- |
| 1 | the seat's **process environment**, read from `/proc/<pid>/environ` | `COTAL_CAPABILITIES=connection` — **the grant WAS applied** |
| 2 | the gate: `config.capabilities?.includes("connection")` (`extensions/connector-core/src/tool-specs.ts:177`) | with (1) true, it passes — **the projection is fine** |
| 3 | `grep -c cotal_disconnect` over the artifact that **actually serves the seat's tools** — see the correction below | **`0`** |

> ### ⚠ CORRECTION, `2026-08-15T05:1xZ` — row 3 named the WRONG ARTIFACT. The result is unchanged; the subject was misattributed.
>
> Row 3 originally cited **`@cotal-ai/connector-core@0.17.0`, `dist/tool-specs.js`**. That is a real
> artifact on this box and it is a real zero, but **it is not what served `mc-e2e-user-2`'s tool
> surface.** Read from the live `--mcp-config` in the seat's own process cmdline rather than inferred:
>
> ```
> {"mcpServers":{"cotal":{"command":"node","args":[
>   "~/.config/cotal/extensions/node_modules/@cotal-ai/connector-claude-code/dist/mcp.cjs"]}}}
> ```
>
> **Every Claude seat on this box — including this lane's own — is served by
> `@cotal-ai/connector-claude-code@0.16.0`, `dist/mcp.cjs`, built `2026-08-13 22:58Z`.** Its counts:
> `cotal_disconnect` **0**, `cotal_connect` **0**, `cotal_reconnect` **4**.
>
> So there are **two** stale artifacts here, at **two different versions**, and the original row
> conflated them:
>
> | artifact | version | serves | `disconnect` / `connect` |
> | --- | --- | --- | --- |
> | `cotal` on `PATH` → `~/.local/share/cotal` | **0.17.0** | anything shelled out to the CLI | 0 / 0 |
> | `~/.config/cotal/extensions/…/connector-claude-code/dist/mcp.cjs` | **0.16.0** | **the `cotal_*` MCP tools an agent actually calls** | 0 / 0 |
>
> **The conclusion of this finding does not move** — the verbs are absent either way, and the blocked
> live half stays blocked for the same reason. But the finding claimed a subject it had not
> established, which is the exact defect this lane has spent the day filing against others. The
> version that matters for *this* lane is **0.16.0**, because connection control is reached through
> MCP tools, not through the CLI.
>
> **And a third artifact is NOT stale, which kills the general form of the claim:** the manager runs
> `pnpm exec tsx bin/cotal.ts supervise` with `cwd=/home/david/Cotal` — **current source**, read from
> its own process cmdline. "The checkout is not what runs on this box" is false as a blanket
> statement; it is true per call path and must be said that way.
>
> `verdicts/mc-e2e-user.md` and `verdicts/mc-e2e-user-2.md` carry the same misattribution. **They are
> left verbatim on purpose** — a panel verdict is that seat's words and this lane does not edit them;
> the correction lives here and is linked from the PR body.

The principal checkout is on `main`; `grep -c cotal_disconnect` over its `tool-specs.ts` is also
**`0`**. **The verbs exist only on this lane's unpushed branch.** Read from the environment rather
than from a config file, because a config file on disk is not proof of what a running process holds.

## Why this belongs in the record rather than being quietly worked around

**A seat can hold a capability the running build has no way to honour, and the card will advertise
it anyway.** The grant is real; the tools it implies can never appear. That is a **version-skew
hazard** on a surface AGENTS.md already calls out — an upgrade must never leave a customer "on a
skewed core/ext pair". It is not a defect in the code this lane wrote, and it is not nothing.

**This lane cannot self-serve its own E2E stage.** My own seat reads `COTAL_CAPABILITIES=spawn` and
carries `cotal_reconnect` but neither verb, so I could not have driven it either. **The live half is
blocked on the branch being what the mesh runs — a human action, like the push.**

## Standing

- **Docs half: COMPLETE, passed.** Discoverable from `docs/` alone; both seats certified
  unprompted that they had read no diff, no design note, and nothing under `.meshctl-measurement/`.
- **One doc defect found by that half and FIXED:** `docs/manifest.md` gave an exhaustive-looking
  capability list omitting `connection`, so an operator on the manifest path could not tell whether
  it was accepted. Found by a seat with **no code access at all**.
- **Live half: BLOCKED, not skipped.** Four checks specified and unrun: `disconnect(cause)` with
  external-observer confirmation; `cotal_reconnect` while deliberately offline must refuse and
  direct to `cotal_connect`; zero-arg `cotal_connect` restores with replay; a second `connect`
  refuses as already-connected. **Named here so their absence cannot be read as coverage.**
