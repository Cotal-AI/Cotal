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
| 3 | `grep -c cotal_disconnect` over the **installed** build's shipped `dist/tool-specs.js` (`@cotal-ai/connector-core@0.17.0`) | **`0`** |

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
