# Survey: where else does evidence rest on "compiled is not executed"?

**Stamped `2026-08-15T07:4xZ` (`date -u` at writing), lane tip after `ed0fba8d`. READING ONLY — no
runs, no broker, no build, no box. Nothing fixed.**

Commissioned after `FINDING-mx14-survived-vacuously.md`. The class: **a harness substitutes an
implementation, confirms the substitute was loaded or available, and never establishes that the
subject RESOLVED to it.** The failure mode always produces a **pass**.

## TOP LINE

**No new instance was found whose false green is load-bearing on a shipped claim.** The only
defective instances are this lane's own two, and their load-bearing claim was already bannered in
`ed0fba8d` before this survey started.

**The tree is in better shape than the finding suggested.** There are no mock frameworks, no
prototype patching and no injected doubles anywhere in first-party code — every suite examined
drives the real implementation. The substitution surface is small and mostly well-controlled.

## DEFECTIVE — 2 instances, both this lane's

| # | file | substitutes | what it verifies | what it does not |
| --- | --- | --- | --- | --- |
| 1 | `extensions/connector-core/smoke/connection-control.smoke.ts` | core, via `COTAL_CORE_ENTRY` | the **suite's own** import loaded the private build (`:112`) | that the code under test resolved there — cells drive `MeshAgent` (`:190`), whose `@cotal-ai/core` resolves to the shared `dist` |
| 2 | `.meshctl-measurement/meshctl-m11-startleak.mts` | core, via `COTAL_CORE_ENTRY` | prints the same provenance line (`:71`) | **identical defect** — imports `MeshAgent` from `../extensions/connector-core/src/agent.js` (`:55`) while loading core through the seam |

**Both carry the false belief written down as an explanation**, which is why neither was caught by
reading:

- `scripts/mutation-proof.mjs:217` — *"compile it into the PRIVATE build so the suite executes it."*
- `meshctl-m11-startleak.mts:59` — *"Core is loaded through `COTAL_CORE_ENTRY` when a mutation proof
  sets it, so a MUTANT is compiled…"*

**A comment that states the mechanism reads as an explanation, not as a claim, and nobody audits an
explanation.**

**The guard is checking the messenger:** `mutation-proof.mjs:310` refuses unless output matches
`/PRIVATE build/` — a string the *suite* prints about its *own* import.

## A RESULT THAT CHANGES THE SHAPE OF REGISTER ITEM 9

**`packages/core/smoke/connection-lifecycle.smoke.ts` has NO substitution and needs none.** It
imports `../src/index.js` directly (`:75`), compiled in memory by `tsx`, and the only process it
spawns is `nats-server`. **A mutation in `packages/core/src` IS executed by that suite** — no build,
no bare specifier, no seam.

So the reach problem is **specific to connector-driven suites**, not general to core. A resolver
hook may not be the only option; grading core through the suite that already reaches it is another,
with the shared-*source* window (limit #2) as its cost rather than a shared-*build* hazard.

**Stated as a survey observation, not a recommendation.** Item 9 is the human's, and this is input
to it.

## CLEARED — substitutions that fail LOUDLY

| file | substitute | why a failure to resolve cannot pass |
| --- | --- | --- |
| `implementations/cli/smoke/update-concurrency.smoke.ts` | a fake `npm` on `PATH` (`:284`) | **the model case.** The fake writes its pid to `FAKE_NPM_READY`; the suite **blocks** on it (`waitFor(() => existsSync(ready))`) and then asserts `pidAlive(npmPid)`. If the real `npm` ran, or none did, the suite times out. Its later negative (`existsSync(secondStarted) === false`) is anchored by that positive. |
| `extensions/connector-codex/smoke/codex-host.smoke.ts` | a fake `codex` binary (`:68`) writing a JSONL log | `logEntries()` returns `[]` when the log is absent — **a silent empty, and the risk in this file** — but every negative over it has an adjacent positive: *"the host connected with a valid token"* (`:536`) anchors *"no unauthenticated connection was ever accepted"* (`:538`); the raced-steer negative (`:506`) sits between two `waitFor`s that block on real log entries; `noauthBoots.every(...)` (`:989`) is anchored by `noauthBoots.length === 1` (`:984`). |
| `extensions/herdr/smoke.ts` | stub `herdr` binaries at several versions (`:163`, `:165`) | carries an explicit paired control — *"a quoted path with space/quote/$ survives a real shell"* (`:204`) against *"negative control: the unquoted path does NOT create the file"* (`:213`). Both arms observable, and they differ. |
| `extensions/orca/smoke.ts` | a stub `orca` via `COTAL_ORCA_BIN` (`:67`) | the stub records invocations to a `calls` file (`:89`), so its execution is observable rather than assumed. |
| `implementations/manager/smoke/start-model-preflight.smoke.ts` | **removes** `claude` from `PATH` (`:132`) | absence, not substitution: the subject must fail, and a failure to apply the removal makes the subject succeed → **loud**. |

## NOT THIS CLASS — checked and excluded, with the reason

- **Symlink suites** (`agent-skills`, `ledger`, `ext-live`, `maintenance`, `orca`): the symlink is the
  **input under test** (traversal, redirected ancestor, foreign peer), not a stand-in for an
  implementation. They assert a refusal, which fails loudly.
- **`implementations/auth/smoke/int2-revoke-hold.smoke.ts`**: `chmodSync` fault injection (`0o500`),
  not substitution. If the fault fails to apply, the revoke succeeds and the "hold" assertion fails
  → loud.
- **`--import tsx`** (`spawn-manifest-live.smoke.ts:29`): a loader for TypeScript, not a swap of the
  subject's implementation.
- **Production binary overrides** (`COTAL_CODEX_BIN`, `COTAL_ORCA_BIN`, `COTAL_OPENCODE_BIN`): real
  substitution points in shipped code, but each suite that uses one was found to observe the stub's
  execution (above).

## WHAT I DID NOT MEASURE — say it rather than imply coverage

- **I did not read all ~40 files that touch `PATH` in full.** I enumerated substitution mechanisms
  exhaustively by class (executable stubs via `chmodSync`/`0o755`, symlinks, env entry-point
  redirection, loader hooks, mock frameworks, binary-override env vars) and then read the call sites.
  A substitution built by a mechanism I did not think to grep for would not appear here.
- **`codex-installed.smoke.ts`, `install.smoke.ts`, `clean.smoke.ts`, `windows-launch.smoke.ts`,
  `multi-space.smoke.ts`** create stubs and were **not read in full** — none showed a negative
  assertion over a collection that empties when the stub is absent, but that is a scan result, not a
  reading.
- **Nothing was executed**, so every "cleared" verdict is a reading of the control structure, not an
  observation of it failing when it should.
- **One earlier scan in this survey was misleading and is not cited above**: counting
  `waitFor(() => existsSync` style trace-assertions returned `0` for six files, including two that
  do assert their trace by other means. **A count is not a reading**, which is the error this lane
  has now made twice.
