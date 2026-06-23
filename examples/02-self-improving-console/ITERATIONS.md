# Iterations journal — self-improving-console harness

The overnight `/loop` runs the swarm headless, evaluates it, applies ONE setup fix per
iteration, and logs the result here. **Green = build OK AND ≥1 genuine peer-to-peer DM.**
Stop after **2 greens in a row** or **15 iterations**.

What we tune: the *setup* — role contracts (`agents/*.md`), `GOAL.md`, `run-agent.sh`, the
harness. The console code the swarm emits is the test subject (thrown away each run in a
worktree under `.runs/`).

> The per-run snapshots this journal points at (`reference/run-*-green/`, transcripts, verdicts)
> are not checked in — they were several thousand lines of experiment output. The entries below
> are kept as the development log; the `reference/` paths are historical.

Run one iteration manually:
```bash
examples/02-self-improving-console/harness/run-once.sh <iter>
```

| Iter | Outcome | build | peer-to-peer (pairs) | failure mode | fix applied |
|------|---------|-------|----------------------|--------------|-------------|
| 0 | scaffold | n/a | n/a | — | Phase A built (see below) |
| 1 | 🔴 RED | ok | none | no-traffic — orchestrator EOF-exited immediately | spawn orchestrator via manager PTY (`cotal start`) + manager headless; drop `script` |
| 2 | 🟡 partial | — | spawn+coordinate works | worktree isolation LEAKS — research wrote SPEC to MAIN, workers read worktree placeholder | switch harness to main + git-reset between runs; fix peer-to-peer metric (resolve `to` id→name) |
| 3 | 🟢→🟡 | ok | **8 DMs** (backend↔tui-designer, both ways) | ui-not-wired — app.tsx/console-ink still placeholder | tighten green to require wired UI; tui-designer "wire first"; surgical reset (don't clobber license work) |

---

## Iteration 0 — Phase A scaffold (no swarm run yet)
**Status:** harness built and unit-verified; first LIVE swarm run pending (next loop fire).

Built and verified:
- Branch `demo/weavehacks-console-tui`; Ink plumbing in `@cotal/cli` (`ink@6.8`, `react@19.2`,
  `@inkjs/ui@2`), `jsx:react-jsx`, runnable placeholder `console-ink` command — `pnpm --filter
  @cotal/cli typecheck` GREEN.
- Console skeleton anchors (`implementations/cli/src/console/{mesh.ts,app.tsx,ui/,SPEC.md}`).
- Example-02 harness: `run-agent.sh` (4 roles, per-role cwd, contract via `--append-system-prompt`,
  headless mode), `src/manager.ts` (runtime from env; `confirm` set so the PTY runtime auto-accepts
  the dev-channels prompt), `launch.sh` (cmux), `cmux.json`, 4 role contracts, `GOAL.md`,
  `research/INPUT.md`, README.
- Autonomous harness: `harness/observer.ts` (logs ALL traffic incl. DMs via open-mode whole-space
  tap), `harness/run-once.sh` (worktree + open NATS + pty manager + pty orchestrator + wait + teardown),
  `harness/evaluate.ts` (build via worktree `tsc` + peer-to-peer comms analysis). Evaluator
  unit-tested on synthetic transcripts: correctly reports green/red and peer pairs.

**Key de-risk found:** the PTY runtime already auto-confirms claude's dev-channels prompt
(`implementations/manager/src/runtime/pty.ts` watches `spec.confirm` → presses Enter), so headless
agents wake on incoming DMs without cmux key-injection.

**Open risks for the first live run (expected early failure modes):**
- The orchestrator runs under `script` (a PTY) headless — does claude boot + act on the GOAL prompt
  with `--dangerously-skip-permissions` (and accept dev-channels) without a human? Unverified.
- Completion detection relies on the orchestrator broadcasting `DEMO COMPLETE`.
- Nested Claude Code sessions (a claude session spawning claude agents) — feasibility unverified.

## Iteration 1 — first live run (🔴 RED)
**Verdict:** `{green:false, buildOk:true, peerToPeer:false, messages:0, failureMode:"no-traffic"}`,
outcome `orchestrator-exited`. Prereqs confirmed present: claude 2.1.161, nats-server 2.14.2,
node-pty (manager imports OK). The worktree + pnpm install + tsc path works (`buildOk:true`).

**Root cause:** the orchestrator was launched via `script -q /dev/null … run-agent.sh orchestrator`
under `nohup`, so claude got a **closed stdin → read EOF → exited instantly** (the `^D` in the log).
No agent ever joined → 0 messages.

**Fix applied (for iter 2):** stop using `script`. Run the manager with `COTAL_HEADLESS=1` and ask it
to spawn the orchestrator via the **PTY runtime** (`cotal start --name orchestrator`). node-pty gives
a real pty with an OPEN stdin (no EOF) and auto-confirms the dev-channels prompt; every agent the
manager spawns inherits headless mode. This makes the orchestrator and the workers boot identically.

**Next risks to watch:** does the orchestrator actually act on the GOAL init under the PTY runtime and
`cotal_spawn` the workers? Do the workers wake on its DMs? Is `DEMO COMPLETE` ever broadcast?

## Iteration 2 — orchestration works, isolation leaks (🟡 partial)
**What worked (big):** the manager spawned the orchestrator via PTY; the orchestrator booted, set
status, **`cotal_spawn`ed research + backend + tui-designer (all joined)**, and DM'd each a detailed
task. research read INPUT.md, verified the `@cotal/core` API against the code, and wrote a real
194-line SPEC; tui-designer's status went to "settling useMesh() shape with backend." So the core
mechanic — headless multi-agent spawn + dispatch + lateral intent — is proven.

**The blocker:** **worktree isolation does not hold.** research wrote the SPEC to the MAIN repo
(`/Users/user/Projects/cotal/implementations/cli/src/console/SPEC.md`, 194 lines) instead of its
worktree copy (still the 7-line placeholder) — agents resolve repo paths to the canonical project
location they know, not their `git worktree` cwd. Consequence: backend/tui-designer (cwd = worktree)
read the worktree's PLACEHOLDER SPEC, so the research→workers handoff is silently split. It also
pollutes the main tree uncontrollably — strictly worse than a controlled reset.

**Decision / fix for iter 3:** drop worktrees. Run the swarm on the **main demo branch**; reset the
console files with `git checkout` (+ scoped `git clean`) before each run and snapshot green output to
`reference/`. Unique space per run still isolates the mesh. Also fixed the **peer-to-peer metric**:
DM `to` is an instance id, so observer now logs `fromId` and evaluate resolves id→name (HUB =
orchestrator/manager/cli) so a worker's `done:`→orchestrator no longer counts as peer-to-peer.

**Caveat:** run-2's own verdict (worktree typecheck of placeholders) is not meaningful; iter 3 on
main is the first run that can fairly score build + peer-to-peer.

## Iteration 3 — first green-ish, with a real peer-to-peer negotiation (🟢→🟡)
**Verdict (old metric):** `{green:true, buildOk:true, peerToPeer:true, peerDms:8,
pairs:[tui-designer→backend, backend→tui-designer]}`. On main+reset; first fairly-scored run.

**The money shot happened for real.** backend and tui-designer negotiated the `useMesh()` contract
**directly, peer-to-peer**, across many turns: "Proposing useMesh(ep) returns this shape — does it
cover your panels?" → "Love it… Accepting RosterEntry/ChannelInfo/FeedEntry" → "our messages
crossed — I'd ACKed YOUR shape, you locked MINE" → "Locked. Building against your EXACT exports" →
"EXPORTS LANDED ✓ typecheck GREEN". 8 peer DMs, zero contract-routing through the orchestrator.
research wrote a 194-line SPEC and broadcast it; backend produced an excellent `mesh.ts` (typed
contract, MeshStore with coalescing/rate-ring/StrictMode-safe tap). Snapshot kept in
`reference/run-3-green/`.

**The gap:** `app.tsx` and `console-ink.tsx` were still placeholders at timeout — tui-designer built
`ui/{Feed,Roster,Tabs}.tsx` + `mesh.ts` but never wired them into the command. So `cotal console-ink`
still renders the placeholder. Build+p2p passed while the deliverable was unwired → my green metric
was too weak.

**Fixes applied (for iter 4+):**
- **evaluate.ts:** green now also requires `wired` (app.tsx is a real component AND console-ink renders
  it, no "placeholder"). New failure mode `ui-not-wired`.
- **tui-designer contract:** "WIRE FIRST" — make console-ink render a minimal real `<App/>` and pass
  typecheck *before* enriching panels; not done until app.tsx is real + command wired.
- **harness reset:** surgical (only console scaffold + console-ink + index.ts) so it won't revert the
  parallel Apache-2.0 license edits to package.json/tsconfig.

Under the stricter metric, iter 3 is NOT green (ui-not-wired). The 2-in-a-row streak starts fresh.

## Iteration 4 — first GREEN under the strict (wired) metric (🟢) + cross-vendor learning
**Verdict:** `{green:true, buildOk:true, peerToPeer:true, wired:true, crossVendor:false,
complete:false, peerDms:11, pairs:[backend↔tui-designer, research↔backend]}`. Snapshot in
`reference/run-4-green/`.

**What worked.** The full pipeline landed: research wrote+broadcast the SPEC; backend shipped a typed
`useMesh()` in `mesh.ts`; **tui-designer wired `console-ink` → a real 5KB `<App/>`** importing 7 UI
panels (Roster, Channels, Feed, StatusBar, Help, theme, types) — so `wired` passed for the first time.
**11 peer DMs**, including a *new* axis (`research↔backend`) on top of the usual `backend↔tui-designer`
contract negotiation. Zero contract-routing through the orchestrator.

**Cross-vendor (codex) is scuffed.** `codex-reviewer` joined the roster (MCP connected → presence) but
stayed `idle`, never invoked a single `cotal_*` tool, and went offline after ~80s — **no review posted**.
Under headless `codex exec` the model connects the MCP server but doesn't post on the mesh. Per operator
call (time pressure): **dropped codex from the loop.**

**Fixes applied (for iter 5+):**
- **Replaced codex with a Claude `reviewer`** (operator's idea): a critical/adversarial second pair of
  eyes via the *proven* Claude path (`run-agent.sh reviewer`, read-only, repo-root cwd). It reliably
  posts to `#team` + DMs authors. New `agents/reviewer.md`; orchestrator spawns `reviewer` (plan) +
  `reviewer-code` (code), non-blocking. Codex files stay in repo for a possible stage fix.
- **Bumped `RUN_TIMEOUT` 900→1200s** — iter 4 needed the full 900s to reach `wired` and never emitted
  `DEMO COMPLETE`; more headroom lets the orchestrator close the loop.

Green streak: **1 / 2.** Need iter 5 green to stop.

## Iteration 5 — GREEN again → **2 in a row, loop STOPPED** (🟢🟢)
**Verdict:** `{green:true, buildOk:true, peerToPeer:true, wired:true, crossVendor:false,
complete:false, peerDms:9, pairs:[backend↔tui-designer, reviewer→backend, reviewer→tui-designer,
tui-designer→reviewer]}`. Snapshot in `reference/run-5-green/`.

**The Claude `reviewer` works** (replacing scuffed codex). It joined, reviewed the SPEC, **posted a
sharp grounded review to `#team`** (caught real observer semantics: `emit("message")` only fires from
`pump()`, which `consume:false` never starts — 7 concrete gaps) and **DM'd backend + tui-designer
directly** with specifics. It even adapted on the fly — noticing `#team` broadcasts don't wake idle
inboxes, it switched to direct DMs. 6 reviewer messages; reviewer↔worker pairs now show up in the
peer graph. This is the value codex couldn't deliver headless.

**Stable pipeline:** research SPEC → backend `useMesh()` → tui-designer wires `console-ink` → real
`<App/>` + panels, contract settled peer-to-peer, build green, UI wired — two runs running.

**Open item (not blocking green):** `DEMO COMPLETE` never emitted in either green run — the
orchestrator runs out the clock before its final completion check. Green doesn't require it
("ideally" only), but for a cleaner stage demo a future tweak could make the orchestrator poll
worker `done:` + typecheck earlier.

### Conclusion
**Stop condition met: 2 consecutive green runs (4 + 5).** Loop cron `06ba73af` deleted. Best setup is
on the branch; known-good output preserved in `reference/run-4-green/` and `reference/run-5-green/`.
Hardened contracts: `agents/{orchestrator,research,backend,tui-designer,reviewer}.md`, `GOAL.md`,
`run-agent.sh` (+`reviewer` role), `evaluate.ts` (strict `wired` metric).
