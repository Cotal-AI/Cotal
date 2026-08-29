# Segmenting root-scoped material per space (P7, then P1)

Draft plan. Nothing here is implemented, and no implementation starts before this is approved.

P7 and P1 in [per-space-lifecycle](./per-space-lifecycle.md) §7 are one defect in two places: material
that is per-tenant in MEANING sits at a root-scoped path or store key, so a root holds one tenant's
copy of it. The two are planned together because the design questions they raise are the same
questions, and answering them twice is how the two halves drift. They ship apart, because the
material behaves differently at runtime.

The shared design is §2 and §3. The separate series are §4. What each segmentation must carry with
it is §5. §6 is a finding that is NOT yet executed and is a probe before it is a design input.

## 1. The two inventories

P7, the `$SYS` and membership bundle, all at `<root>/.cotal/`:

| material | today | writer | class |
| --- | --- | --- | --- |
| `membership-observer.creds` | raw FS, `SYSTEM_CREDS_FILES[0]` | `up.ts:2913`, `system-rotation.ts:126` | `$SYS`, rotation-renewed |
| `connection-evictor.creds` | raw FS, `SYSTEM_CREDS_FILES[1]` | `up.ts:2915`, `system-rotation.ts:127` | `$SYS`, rotation-renewed |
| `membership-rw.creds` | store key `MEMBERSHIP_RW_CREDS_KEY` | `up.ts:2914`, `up.ts:2886` | DATA account, remintable |
| `membership.json` | raw FS | `up.ts:2916`, `up.ts:2891` | non-secret account id |

P1, the per-agent standing secrets, all under `agentCredsDir(root)` = `<root>/.cotal/auth/creds`
(`auth-paths.ts:241`): `<name>.creds`, `<name>.actor-token`, `<name>.sentinel.creds`, their
per-incarnation `<name>.<lifecycleUid>.*` counterparts, and the non-secret `<base>.auth-health.json`.
Store keys are `auth/creds/<basename>` (`auth-paths.ts:283-296`).

What already landed is the idiom both must copy: the split auth records are keyed
`auth/<spaceSegment>/callout.json` and siblings (`implementations/auth/src/store.ts:58-61`), through
the one guarded encoder `spaceSegment` (`auth-paths.ts:81`) and its inverse `spaceFromSegment`
(`auth-paths.ts:90`). One encoder is deliberate: the encoder's own comment records that two
independently-guarded encoders were the defect generator. Neither series adds a second one.

## 2. Migration for roots that already exist

The answer is the same for P7 and P1, and it is MOVE ON FIRST TOUCH at a single choke point, not
read-fallback.

This is not a new invention. `userAuthStateDir` (`auth-paths.ts:111`) already does it for the pre-hex
user-auth state dir: every consumer of that material obtains its path from that function, the
function renames the legacy dir to the canonical segment before returning, and the comment states
the reason read-fallback was rejected. A fallback leaves flows able to read, or worse to
`ensure*`-REGENERATE, beside material the old layout still holds. That hazard is sharper for both of
our inventories than it was there, because both have absent-means-mint writers: `up.ts:2885` and
`up.ts:2889` mint when the key or file is absent, and a fallback-less canonical read on an
unmigrated root reads absent and mints a SECOND live cred beside the one the daemons are using.

The rules, taken from that prior art and applied to both series:

1. **One choke point per kind.** A resolver function owns the path or key, performs the migration,
   and returns the canonical location. No consumer builds the location itself. For P7 this is a new
   resolver per kind; for P1 it is `agentCredsDir` and the key builders, which gain a space.
2. **The move is a rename**, so it is atomic per kind. A crash leaves each kind wholly legacy or
   wholly canonical, never half-written.
3. **Ambiguity refuses, loudly.** `migrateLegacyUserAuthState` refuses in two cases rather than
   guess (`auth-paths.ts:159` and `:163`): the legacy name is also another space's canonical
   segment, and both locations hold material so neither is provably current. The second applies
   directly to us and is the one that matters: canonical AND legacy both present means a partial
   migration we cannot arbitrate, and it refuses.

### 2.1 Half-segmented roots, and why `space add` is the guard

A half-segmented root is the state to design against, and the useful observation is that it has two
distinct causes with different answers.

Cause one is a crash mid-migration ACROSS kinds: `membership.json` moved, `membership-rw.creds` did
not. Rule 2 makes each kind individually consistent and rule 1 makes each kind migrate on its own
first touch, so this state is self-healing on the next `up`. It needs no repair verb.

Cause two is the one with teeth: **legacy material on a root that now holds more than one tenant is
unattributable.** Segmenting means writing the owning tenant's name into the location, and on a
multi-tenant root nothing on disk records which tenant the root-scoped copy belongs to. It belongs
to whichever tenant booted first, which is P7's inheritance defect and is recorded nowhere. Guessing
would either hand tenant A's live observer to tenant B or strand it.

So the migration is only sound while the root holds ONE space, and that is enforceable at the source
rather than left as a hazard. `up` cannot create the second tenant (`ensureRootForSpace` refuses at
`up.ts:2233`), so the only door is `space add`. The rule:

> `space add` refuses on a root that still holds unmigrated legacy material for any segmented kind,
> and names the remedy: run `cotal up` for the sole tenant once, which migrates it, then add.

This converts cause two from a state we must arbitrate into a state that cannot be reached, and it
costs one inventory check in a verb that is already taking the lock and reading the inventory
(§2.1 step 1). Roots that never grow past one space migrate silently on first touch and never see
the refusal.

An already-multi-tenant root that predates the segmentation is the residual case, and it is small:
it can only exist if `space add` shipped before the segmentation did. Sequencing `space add` behind
this refusal means the population is empty by construction, so no repair verb is owed. If `space
add` has already shipped by the time P7 lands, the refusal above still applies and the operator's
path is the documented broker-wide one, not a new tool.

## 3. The SecretStore key grammar

Three grammars are in the store today: flat kind keys where the key IS the filename under `.cotal/`
(`DELIVERY_CREDS_KEY` = `delivery.creds`, `MEMBERSHIP_RW_CREDS_KEY` = `membership-rw.creds`,
`renewal.ts:30` and `:35`), the segmented auth records `auth/<spaceSegment>/<kind>.json`, and the
agent keys `auth/creds/<basename>`. All three are relative paths under `.cotal/` that the FS
composition resolves directly, so slashes already work and a segment is a directory component.

The rule, one sentence, identical for both series:

> Insert the one `spaceSegment` as a path component at the FIRST level that is per-tenant, and never
> at a level whose contents another owner treats as opaque.

The second clause is what decides the two placements, and it is not cosmetic. `.cotal/auth/space.<hex>`
is the user-auth state dir, whose contents the auth provider owns and workspace treats as opaque
(`auth-paths.ts:98-103`). Putting either inventory inside it would place our files in a namespace
another component enumerates and may prune. So:

- **P7** goes to a NEW per-space area, `.cotal/space.<hex>/`, a sibling of `auth/` and `run/`,
  holding all four kinds. `membership-rw.creds`'s store key becomes `space.<hex>/membership-rw.creds`.
- **P1** puts the segment INSIDE the existing creds dir: `.cotal/auth/creds/space.<hex>/<base>.<kind>`,
  key `auth/creds/space.<hex>/<basename>`. This keeps `auth/creds` a reserved sibling of the auth
  dir, which the encoder's collision guarantee names and which `migrateLegacyUserAuthState:133`
  excludes by that name, so neither statement has to be rewritten.

`spaceSegment`'s documented guarantee today enumerates the reserved siblings of the AUTH dir only.
P7 extends the namespace it must not collide in to the `.cotal/` children. That holds today (no
`.cotal` child begins with `space.`; the nearest is `auth-service.<spaceKey>.pid`), but it holds by
accident until a test says so, so the shared commit extends the comment and adds the guard.

### 3.1 What the re-key touches beyond the FS

`MEMBERSHIP_RW_CREDS_KEY` is not only a filename. It is an entry in `REMINTABLE_DAEMON_CREDS`
(`renewal.ts:62`), which `remintDaemonCreds` (`renewal.ts:111`) iterates for the manager and for
`doctor auth --fix`, reading and writing through an INJECTED store so a hosted composition renews
from the same store the daemon reads. Two consequences the implementation must carry:

1. `REMINTABLE_DAEMON_CREDS` is a static array of literal keys. Once a key carries a segment, the
   entries become builders of the form `(space) => key`. `remintDaemonCreds` already takes
   `expectedSpace` as a REQUIRED positional, so the space is in hand at every call site and no
   signature grows.
2. `RemintResult.file` is how a remint result is mapped back to the daemon's `membership` component
   (`renewal.ts:32-35`). It must keep reporting the KIND, not the segmented key, or that mapping and
   the operator-facing strings in `doctor auth` silently start printing hex.

A hosted composition provisions these keys externally, so the re-key is a coordinated change on that
side. That is the reason the grammar is settled once, here, before either series starts.

### 3.2 `delivery.creds` is in the grammar even though it is out of P7

`DELIVERY_CREDS_KEY` sits in the same `REMINTABLE_DAEMON_CREDS` list, at the same root scope, and is
space-scoped material by the same argument: `remintDaemonCreds`'s own contract validates the store's
signer against `expectedSpace` because a wrong-space signer would re-sign a cred the space's broker
rejects (`renewal.ts:89-95`). It carries the same inheritance exposure as `membership-rw.creds`.

P7's scope as briefed is the `$SYS` pair, `membership.json` and `membership-rw.creds`, and this plan
does not widen it. But the grammar decision above must cover `delivery.creds` explicitly, because
segmenting one member of a two-member list and not the other is how the grammar splits. **Open for
the orchestrator:** either `delivery.creds` segments with P7 (one list, one grammar, slightly wider
commit) or it is named in the doc as a known-unsegmented sibling with its own prerequisite. It should
not be left unstated.

## 4. Two series, P7 first

P7 first, because its material is LIVE: the daemons read the observer, evictor and rw creds at
runtime, and the inheritance defect is a correctness bug on a multi-tenant root today (the second
tenant runs the first tenant's membership bundle, §5 of the lifecycle doc). P1's material is, by that
doc's own §2.2 account, broker-dead disk residue once the account leaves the resolver. Correctness
before residue, and the live series gets the idiom scrutinized under the higher stakes.

P1 second, consuming the shared foundation unchanged. If P1 needs the foundation to bend, that is a
signal the foundation was wrong for P7 too, and it comes back here rather than growing a second
idiom in the P1 series.

**Series P7**

1. Shared foundation: extend `spaceSegment`'s collision guarantee to the `.cotal/` children with a
   guard test, add the choke-point migration helper generalized from `migrateLegacyUserAuthState`,
   and add the `space add` refusal from §2.1. No material moves in this commit.
2. Segment the four P7 kinds behind their resolvers, with the removal-list changes of §5 in the SAME
   commit. `provisionMembershipCreds` (`up.ts:2903`) and `healMembershipDataCreds` (`up.ts:2881`)
   both write through the resolvers.
3. The `space rm` step 7 reap of the now-segmented `$SYS` creds, which §2.2 step 7 of the lifecycle
   doc already promises "once those are keyed per space (P7)".
4. The probe of §6, if §6 has not already been executed by then.

**Series P1**

1. `agentCredsDir` and the key builders take a space; `agentSecretKeysUnder` reads one level deeper;
   `agentSecretKeyForFile` needs the space to build a key and its signature changes with it. Removal
   lists in the SAME commit, per §5.
2. `space rm` reaps one tenant's agent secrets, retiring the residue paragraph at §2.2 of the
   lifecycle doc (lines 91-95) and the sentence in §7's P1 entry that records `agentCredsDir` as
   taking no space.

## 5. Removal lists land with their segmentation

A constraint, not a preference: every commit that segments a kind carries that kind's removal-list
change. Segmenting a location while a sweeper still names the old one is how material becomes
unreapable, which is the failure P1 and P7 exist to end.

The affected sweepers:

- `clean.ts:272-279`, the identity-derived raw removal list, which names `SYSTEM_CREDS_FILES` at
  `:276` and `membership.json` at `:277`. Both become per-space enumerations. The comment at
  `clean.ts:265-268` records a deliberate "keep in sync with `provisionMembershipCreds`" coupling and
  is updated in the same commit, because the coupling it describes is what this constraint enforces.
- `clean.ts:243-250`, the `agentSecretKeysUnder` sweep, for P1.
- `space rm` step 7 (`per-space-lifecycle.md` §2.2, lines 77-79), which is where a per-space reap
  becomes reachable at all.
- `deleteSpaceAccountAuth` (P4) is adjacent but not blocked by either series and is not pulled in.

## 6. Probe first: does a multi-tenant root end up with NO observer

**This is a hypothesis, read from the code and NOT executed. It is not a design input until a probe
settles it, and nothing in §2 to §5 depends on it.**

The reasoning that produced it: `provisionMembershipCreds` mints the `$SYS` pair only in the
fresh-space branch (`up.ts:2903`, called once at `up.ts:2692`), because the `$SYS` signing seed
exists only there. `healMembershipDataCreds` (`up.ts:2881`) repairs the DATA half only, by
construction and by its own comment. So a root whose first tenant was provisioned before the
membership feature, or whose `$SYS` pair was swept by `clean`, has no minting path: the first tenant
is not fresh so the provisioner never runs, the second tenant is refused by `up.ts:2233` before it
could be fresh, and the documented repair `up --rotate-sys` is `assertSingleSpaceBroker`-guarded
(`system-rotation.ts:96`) and refuses on a multi-tenant root, which is P8. The predicted state is BOTH tenants with no observer and
no reachable repair.

If it holds it is a second, distinct P7 failure mode, and it is the intersection of P7 and P8 rather
than either alone. It stays out of the lifecycle doc until executed, which is why §5 of that doc
records only the inheritance mode.

The probe, to run before series P7 commit 2: on a two-tenant root built the way `space add` builds
one, with the `$SYS` pair absent from the start, assert that no `up` of either tenant mints an
observer, that the delivery daemon reports the incomplete bundle rather than degrading silently, and
that `up --rotate-sys` refuses with the single-space guard. A positive control in the same run mints
an observer on a fresh single-tenant root, so a probe that reads all-negative because the harness
never provisioned anything is distinguishable from the finding.

## 7. Open decisions

1. `delivery.creds`: segment it inside series P7, or name it as a known-unsegmented sibling with its
   own prerequisite (§3.2).
2. The `space add` refusal of §2.1 is the load-bearing simplification of the whole migration story.
   It trades a one-time operator step on a root that is growing to two tenants for the elimination of
   the unattributable-material case. Confirm that trade is acceptable before it is built on.
3. Whether the §6 probe runs before series P7 starts or before its commit 2.
