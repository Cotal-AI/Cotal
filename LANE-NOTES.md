u1972-427a84872

## Task 1: the stock hosted-release regression

`pnpm smoke:mutation-fixtures` failed with one dead anchor: mutation [1] of
`implementations/manager/smoke/mutations/hosted-retirement-stock-supervise.json` still named the
`throw new Error("remote participant supervision cannot terminally retire …")` line this lane
replaced with the real `provider.prepareRemoteManagedAgentRetirement` call.

Reproduced first, live: `COTAL_OWNER_NATIVE_ACCEPTANCE=1 pnpm probe:hosted-retirement-stock-supervise`
at 905481003 ran 19 passed, 1 failed, and the failing cell's captured supervisor output showed the
new boundary text:

```
deprovision stock_retained (…): signed in, but managed agent retirement preparation was refused:
managed agent enrollment and retirement preparation must be handled by host platform interception
```

Stock still fails closed before requester issuance with the alias held; only WHERE the refusal comes
from moved, from a local throw to the host's `unimplemented` dispatch answer.

The fix, in one commit (9f3d61f1f):

- the cell now asserts that exact host refusal, and additionally counts the ONE
  `manager-managed-agent-prepare-retirement` request the manager put on the wire, so the cell proves
  the host round trip happened rather than only that some refusal was printed. It still requires
  `retirementRequests === beforeRetirementRequests` and the alias row held at the same lifecycleUid.
  Renamed to `stock hosted deprovision fails closed at the host's unimplemented release refusal`.
- the HTTPS proxy fixture counts the new request kind (it would otherwise have fallen through the
  `operation` arms and been attributed to nothing).
- mutation [1] is re-anchored on the fail-closed line that now carries the boundary, the
  `prepareRemoteManagedAgentRetirement` call plus its `remoteManagedAgentRetirementPrepared`
  validation, replaced by `void request;`. Its `why` row says what the new claim is.

Counts:

- `COTAL_OWNER_NATIVE_ACCEPTANCE=1 pnpm probe:hosted-retirement-stock-supervise`: GREEN,
  **20 passed, 0 failed** (baseline before the fix: 19 passed, 1 failed).
- `node scripts/mutation-proof.mjs --config implementations/manager/smoke/mutations/hosted-retirement-stock-supervise.json`
  on a clean tree: baseline green (20 progress marks), **all 5 mutations KILLED**. Mutation [1]
  was `red, and named: stock hosted deprovision fails closed at the host's unimplemented release
  refusal · 18 marks (baseline 20)`. Tree clean after, no leftover breadcrumb.

## Task 2: the gates

- `pnpm install`: exit 0. `pnpm -r build`: exit 0 (re-run after the change: exit 0).
- `pnpm smoke:mutation-fixtures`: **OK**, 498 fixture files, 2968 anchors, 0 dead, 0 ambiguous,
  0 spanning prose, 0 missing, 0 unrestored builds.
- `pnpm smoke:managed-agent-enrollment:auth`: **OK, 35 passed, 0 failed, expected 35**.
- `pnpm smoke:remote-exchange:live`: **89 passed, 0 failed**, including
  `the enrollment-verification door 404s on the public face for POST as well` and the 15/15
  non-route 404 cell covering all three private host doors.
- `node scripts/mutation-proof.mjs --config implementations/auth/smoke/mutations/managed-agent-enrollment.json`
  on a clean tree: baseline green (35 progress marks), **all 17 mutations KILLED** (6 enrollment
  guards, 8 prepare-retirement guards, the tokenHash and lifecycleUid parser closures, and the stock
  `unimplemented` dispatch refusal). Tree clean after.
- `pnpm run check:shard-stability 427a84872 HEAD`: **STABLE**, 628 -> 629 suites, added 1,
  removed 0, 0 of 438 frozen legacy suites changing index, 0 of 628 pre-existing suites changing
  shard.
- `pnpm typecheck`: exit 0. `pnpm check:docs-voice`: 41 pages passed.
  `pnpm smoke:core-boundary`: exit 0. `node scripts/check-operator-literals.mjs`: clean,
  0 findings over 2525 files.
- `pnpm changeset status`: the single `remote-managed-agent-enrollment.md` changeset bumps
  `@cotal-ai/core`, `@cotal-ai/auth` and `@cotal-ai/manager` minor, and the `fixed` group carries
  every package with it. No major.

## Replay floor

No channel traffic arrived during this seat's work. Nothing to record.

## Final

- Head: see the commit that adds this section (`git log -1`).
- Lane: `lane/1972-remote-enrollment`, branched from Cotal origin/main 427a84872.
- Commits on the lane: 10.
- Scope delivered: the upstream half of §3.4 only. The Cloud handler, E0-E5 and its tables are
  out of scope and absent.
