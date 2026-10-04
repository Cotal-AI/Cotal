# Portable lifecycle bootstrap

Status: contract for issue #2420, implemented with the symbols spelled as declared below. The source
inventory was checked at `d00f18cd62f5933c7dceb93b56559498b66656bc`.

## Problem

A signerless manager enrolls a fresh managed agent once through
`remoteAuthority.enrollManagedAgent`. It generates the standing actor token itself
(`implementations/manager/src/manager.ts:3874`), sends only its SHA-256 digest (`:3875`), and the
host returns the owner, the host-chosen `lifecycleUid`, the space sentinel credentials, the
effective channel lists and `agentBearerExchangeUrl`.

Everything after that assumes the child shares the manager's filesystem:

- the token and sentinel are materialized under `agentLifecycleSecretFilePaths(this.workspaceRoot, …)`
  (`manager.ts:3880-3914`);
- the bearer argv is the manager's own `process.execPath` and `process.argv[1]` with a local
  `--token-file` and `--health-file` (`manager.ts:3916-3928`);
- `LaunchOpts.userAuth` carries `sentinelCredsPath` and that argv, which `packages/core/src/connector.ts:15-21`
  documents as host-local pointers;
- `materialEnv` writes the launch material into the manager's `os.tmpdir()` and hands the child only
  its path (`extensions/connector-core/src/launch.ts:258`);
- `Runtime.spawn(name, spec, cwd, reference?)` (`packages/core/src/runtime.ts:119`) has no input for
  material by value.

A child in a sandbox, a container or on another host therefore cannot start the enrolled lifecycle.
The only workarounds are a second enrollment or a copy of the manager's secret files, and both are
wrong. The reproduction masks the manager's workspace root from a pooled child and
records the `ENOENT` it fails with.

## Decision: reuse the enrollment-redeem consumer, change only who hands it the bundle

Stock 0.58 already has a child-side bootstrap that adopts host-issued material without shared
files: the one-time enrollment redeem (`docs/identity-and-auth.md` "Enrollment redeem",
`docs/cli.md` `COTAL_ENROLLMENT_FILE`). A foreground `cotal spawn` redeems one URL, registers the
returned mesh in its own home (`implementations/cli/src/commands/spawn.ts:489-595`), writes the
returned token and sentinel to its own 0600 files, preflights the existing
`agent-bearer --exchange-url` arm, and launches the connector with the returned `lifecycleUid`
(`spawn.ts:803`). It never enrolls and never mints a token or a UID. That consumer is the bootstrap
this issue asks for. The question is who can give it the bundle.

### Who can mint a redeem URL for an already-enrolled lifecycle

The redeem `200` body carries the raw `actorToken` (`docs/identity-and-auth.md:298`). Whoever serves
it must hold the raw token.

- **The host cannot, for a manager-enrolled lifecycle.** SPEC §13.1 says an enrollment request MUST
  carry the SHA-256 digest of the agent's standing actor token and never the token itself
  (`SPEC.md:1340-1341`). `docs/embedding.md:370-372` says the participant passes only its digest so
  the plaintext secret never leaves the participant machine. A host-held one-time handoff for this
  lifecycle would need a second request carrying the plaintext to the host, which both clauses
  exclude. The host's ledger keeps the digest only, and that is the property worth keeping: a ledger
  compromise cannot replay an agent's exchange secret.
- **A host can, for a lifecycle it enrolled without a manager.** When the host generated the token
  itself (today's redeem minter), the redeem route works as shipped. This design does not change it.
- **The manager holds the token, but cannot serve a URL without becoming a listener.** A pooled
  control manager has no listener (`ManagerOptions.pooled` refuses local custodial execution), and
  the proposed platform control authority contract for issue #2408 (frozen at
  `2392055fef5777a4c1c8bcbac6621aefd9e9705e`, rule R5) adds no daemon, listener or protocol. A manager-served URL would be a new public surface for
  one read.

So the redeem transport (a URL, a GET, a server-side row deleted on claim) does not fit. The redeem
consumer does. The missing piece is a handoff that the token's custodian delivers by value, through
the runtime that creates the child, to that one child.

### The foreground-only restriction and the registration path fit a sandboxed child

`spawn.ts:481-484` refuses enrollment input with `--detach` or `-f`, because the URL must be consumed
by the process that runs the seat. In the delegated shape the manager's runtime is the detacher, and
the child runs `cotal spawn` in the foreground inside its own sandbox. The restriction holds unchanged
and the handoff input inherits it.

When the space is not registered, the redeem consumer registers it from the bundle's stock fields
into the child's own home and requires `--config <persona-file>` (`spawn.ts:489-499`). A sandbox has
an empty home, so that is the branch it takes. The runtime writes the persona file beside the
handoff file.

Two things in the consumer do not fit as shipped, and the bootstrap closes them:

- `checkEnrollmentBundle(raw, actor)` (`spawn.ts:137`) checks the actor against the requested name
  and nothing else. A child must also refuse a bundle for another owner or another lifecycle, and it
  must refuse before any plane opens.
- The cleanup is a local shred (`spawn.ts:1158`). That is right for the child, because retirement
  belongs to the manager or the host. The child never retires anything.

## What crosses to the child

One closed value, `ManagedLifecycleHandoff`, plus the persona text. Nothing else.

| Field | Source on the manager | Secret |
| --- | --- | --- |
| `space` | the manager's space | no |
| `owner`, `actor`, `lifecycleUid` | the enrollment result, as the manager bound it (`manager.ts:3895-3901`) | no |
| `server`, `tlsRequired`, `authProvider`, `idp` | the manager's own registry record for the space, which user-mode start already requires | no |
| `exchangeUrl` | the enrollment result's `agentBearerExchangeUrl` | no |
| `subscribe`, `allowSubscribe`, `allowPublish` | the enrollment result's effective lists | no |
| `policy` | the registry record's registration policy, when present | no |
| `sentinelCreds` | the enrollment result, as text | the space sentinel, already given to every agent |
| `actorToken` | the manager's custody (its `SecretStore`), as text | yes, the one standing exchange secret |

How it crosses:

- The manager serializes values it holds. It never copies, links or names a file from its workspace,
  its `SecretStore`, its launch-material directory or its tmpdir. No manager path appears in the
  handoff, the persona, the argv or the child environment.
- The runtime writes the handoff once into the child's private filesystem as a 0600 regular file,
  through the provider's own file or secret channel, and passes only its path in
  `COTAL_MANAGED_HANDOFF_FILE`. It does not put the token in argv, in the environment, in provider
  options, in logs or in any record it keeps.
- The child's `cotal` entry reads the file once and unlinks it before it does anything else,
  refused or not, including before it parses its flags or prints help.
- There is no second enrollment. The child never calls `enrollManagedAgent`, the agent-provisioning
  endpoint or a redeem URL, and never mints a token or a UID. It presents the host's `lifecycleUid`.

Excluded by schema: signer seeds, the account or operator signing key, `issuer.json`,
`callout.json`, `auth-service.json` or its loopback capability, the owner-derivation secret,
provisioner, deprovisioner, delivery, membership or supervisor credentials, any manager credential,
the manager's control token or socket, and any manager filesystem path. The parser refuses an unknown
field, so none of these can ride along.

The child serves whatever owner the enrollment issued. The handoff neither requires nor excludes an
owner form, so a `u_` owner and the `p_` platform owner proposed by the platform control contract both
work without a branch.

## Symbols

### `@cotal-ai/core`, new module `packages/core/src/managed-handoff.ts`

Exported from `packages/core/src/index.ts`.

```ts
/** The env var naming the handoff file inside the child. It carries a path, never a secret. */
export const MANAGED_HANDOFF_FILE_ENV = "COTAL_MANAGED_HANDOFF_FILE";

/** The discriminator a handoff document carries. A redeem body is not a handoff and is refused. */
export const MANAGED_HANDOFF_KIND = "cotal-managed-handoff/v1";

/** The coordinate one enrollment issued. */
export interface ManagedLifecycleTarget {
  readonly space: string;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
}

/** One already-enrolled lifecycle's issued material, by value. Closed: an unknown field refuses. */
export interface ManagedLifecycleHandoff extends ManagedLifecycleTarget {
  readonly kind: typeof MANAGED_HANDOFF_KIND;
  readonly server: string;
  readonly tlsRequired: boolean;
  readonly authProvider: string;
  readonly idp: { readonly url: string; readonly issuer: string; readonly audience: string };
  /** The enrollment's `agentBearerExchangeUrl`. HTTPS, or plain HTTP to a loopback IP literal. */
  readonly exchangeUrl: string;
  readonly sentinelCreds: string;
  readonly actorToken: string;
  readonly subscribe: readonly string[];
  readonly allowSubscribe: readonly string[];
  readonly allowPublish: readonly string[];
  readonly policy?: { readonly events: "required" };
}

/** Validate the handoff text against the coordinate the runtime passed beside it. Throws a
 *  sentence naming the first malformed or mismatched field, never a value. Opens nothing. */
export function parseManagedLifecycleHandoff(text: string, expected: ManagedLifecycleTarget): ManagedLifecycleHandoff;

/** Take the handoff file into memory and remove it: open the path without following a link,
 *  unlink it, then read it. Refuses a missing path, a non-regular file, a mode other than 0600 on
 *  POSIX, or an empty file, after unlinking whatever is not a directory. A refusal names the
 *  check, never the contents. Its one caller is the CLI's custody, which runs before anything else
 *  the CLI does, so no outcome can leave the file behind. */
export function takeManagedHandoffFile(path: string): string;

/** The provider key a delegated seat's runtime resource is created under. A pure function of the
 *  full target, so any party with provider authority closes the resource by lifecycle, never by
 *  name: `cotal-` and the first 32 lowercase hex characters of the SHA-256 of the UTF-8 bytes of
 *  `JSON.stringify([space, owner, actor, lifecycleUid])`. */
export function managedRuntimeKey(target: ManagedLifecycleTarget): string;
```

The key's bytes are fixed so a host in another language closes the same resource. For space `s2420`,
owner `u_aaaaaaaaaaaaaaaaaaaaaaaaaa`, actor `probe` and lifecycle UID `aaaaaaaaaaaaaaaaaaaaaaaaaa`, the
hashed text is `["s2420","u_aaaaaaaaaaaaaaaaaaaaaaaaaa","probe","aaaaaaaaaaaaaaaaaaaaaaaaaa"]` and the
key is `cotal-ffa44aae523faeee4ab7689a699b392e`.

`parseManagedLifecycleHandoff` checks, in order: JSON text; an object with `kind === MANAGED_HANDOFF_KIND`; no
field outside the interface; every string non-empty; `space`, `owner`, `actor` and `lifecycleUid`
equal to `expected`; `lifecycleUid` passing `assertLifecycleToken`; `exchangeUrl` passing the
`agent-bearer --exchange-url` scheme rule; the three lists arrays of strings; `policy` absent or
`{ events: "required" }`.

### `@cotal-ai/core`, additions to `packages/core/src/runtime.ts`

```ts
/** What a non-local runtime needs to start one delegated seat, besides the handoff. Every field
 *  is a value; none is a path on the manager's filesystem. A spawn choice with no field here is
 *  refused by the manager before enrollment, never dropped. */
export interface DelegatedSeatLaunch {
  /** The connector name the child resolves, for example `claude-code`. */
  readonly agent: string;
  /** The agent-definition file text the manager resolved for this spawn. */
  readonly persona: string;
  /** The role the manager resolved (the `--role` override, else the persona's `role:`), the same
   *  value the enrollment carried. */
  readonly role?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly prompt?: string;
  readonly launchOptions?: Readonly<Record<string, string>>;
  readonly events?: boolean;
}

export interface Runtime {
  // ...existing members unchanged...
  /**
   * Start one seat outside the manager's filesystem for an already-enrolled lifecycle. Optional;
   * absent means the runtime cannot host a delegated seat and the manager uses `spawn`.
   *
   * The runtime creates one provider resource under `managedRuntimeKey(handoff)`, writes the
   * handoff and the persona into it as private files, and runs `delegatedSeatCommand` there. It
   * calls the provider's create at most once per call and never retries a create whose answer was
   * lost. The handle's `status()` is `"exited"` only after the provider observed the child exit, or
   * after a fenced close by that key completed. A provider answer that no resource exists under the
   * key is never exit evidence. A lost, timed-out or ambiguous acknowledgement leaves it
   * `"running"`.
   *
   * `stop()` is the fenced close by that key. It completes only when no create for that key can
   * still materialize: the create was answered before the close, or the provider's close fences the
   * key so a create that arrives later is refused. Until one of those holds, `stop()` keeps the
   * close pending, `status()` stays `"running"`, and `waitForExit()` does not settle. The handle
   * carries no `reference` and no `release`.
   */
  spawnDelegated?(launch: DelegatedSeatLaunch, handoff: ManagedLifecycleHandoff): AgentHandle;
}

/** The argv (after the `cotal` binary in the child's image) and the environment a runtime runs
 *  in the child. `files` are paths inside the child. */
export function delegatedSeatCommand(
  launch: DelegatedSeatLaunch,
  target: ManagedLifecycleTarget,
  files: { readonly handoff: string; readonly persona: string },
): { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> };
```

`delegatedSeatCommand` returns
`["spawn", "--config", files.persona, "--space", target.space, "--name", target.actor, "--agent", launch.agent, "--expect-owner", target.owner, "--expect-lifecycle-uid", target.lifecycleUid, ...]`
with `--role`, `--model`, `--variant`, `--prompt`, one `--opt k=v` per launch option and `--events`
or `--no-events` appended when set, and `env` equal to `{ COTAL_MANAGED_HANDOFF_FILE: files.handoff }`.
It never emits `--cwd`, `--resume`, `--share-tools` or an access-list flag: the child's working
directory is the provider resource's own, and its channel lists come from the handoff.

### `@cotal-ai/cli`, custody at the CLI entry and the child bootstrap in `cotal spawn`

Custody of the handoff starts at the CLI's entry, before anything that can exit. `runCli`
(`implementations/cli/src/command.ts:156`) prints the version (`:161`), seeds extensions (`:177`),
prints help (`:195`, `:209`), materializes an extension command (`:216`), parses flags strictly
(`:223`, refused at `:236`) and prepares the mesh target (`:227`) before it calls the handler
(`:229`), and each of those can end the process. So the handler cannot be where the file is taken.

```ts
// implementations/cli/src/managed-handoff.ts (new; not re-exported from the package index)

/** The first statement of `runCli`. When `MANAGED_HANDOFF_FILE_ENV` is set under any letter case,
 *  delete every such key from `env`, then run `takeManagedHandoffFile` on the named path and hold
 *  the text in this module. A refusal prints one line naming the check and exits 1; the file is
 *  already unlinked by then. With the variable absent it does nothing. */
export function takeManagedHandoffCustody(env: Record<string, string | undefined>): void;

/** The text custody holds, handed over once. A later call returns undefined. Only the spawn
 *  handler calls it. */
export function claimManagedHandoff(): string | undefined;
```

```ts
// implementations/cli/src/command.ts
export async function runCli(registry: Registry, argv: string[], opts: RunCliOptions = {}): Promise<void> {
  takeManagedHandoffCustody(process.env);
  // ...the existing body, unchanged, starting with the `--version` short-circuit...
}
```

```ts
// implementations/cli/src/commands/spawn.ts

/** Map a parsed handoff onto the redeem consumer's shapes. Pure. */
export function handoffEnrollmentBundle(h: ManagedLifecycleHandoff): { bundle: EnrollmentBundle; stock: UserBundle };
```

So the file and the variable are gone before the version print, extension seeding, the manifest
overlay, help, command lookup, extension materialization, strict flag parsing, target preparation
and the handler. Every outcome of `cotal`, refused or not, leaves no file, and no extension, seed or
harness child inherits the variable. A run that holds a handoff and never reaches the spawn handler
(help, a flag error, another command) ends as it does today and drops the text unused at exit.

Before `runCli`, the published entry runs only its Node-version check (`bin/cotal.ts:18-43`) and
the composition root's self-registering imports (`bin/run.ts`). Neither reads the variable or starts a process. When the check refuses an
older Node, it first unlinks the path the variable names, using `node:fs` by dynamic import and
without reading it, then exits 1 as today. An unlink failure other than a missing file is printed
with the refusal.

Two flags join `spawnFlags`: `--expect-owner <u_…>` and `--expect-lifecycle-uid <uid>`. Both are
required when custody holds a handoff and refused when it holds none.

The handoff path through `spawn(args)`:

1. Claim the text, first. `claimManagedHandoff()` runs before `enrollmentInput` and before any flag
   check, and the text stays in memory only. The file and the variable are already gone, so no
   refusal below can leave either behind. `scrubEnrollmentEnv` is unchanged.
2. Refuse the conflicts and the shapes the redeem input refuses: `COTAL_ENROLLMENT_URL` or
   `COTAL_ENROLLMENT_FILE` also set, `--detach`, `-f`, `--creds`, a missing `--space`,
   `--expect-owner` or `--expect-lifecycle-uid`, and a missing or unloadable `--config` file.
3. `parseManagedLifecycleHandoff(text, { space: --space, owner: --expect-owner, actor: --name,
   lifecycleUid: --expect-lifecycle-uid })`. Any mismatch exits non-zero here, before mesh
   registration, before any broker connection and before any exchange request.
4. `handoffEnrollmentBundle` builds the bundle; `stock.userAuth` is
   `{ provider: authProvider, idp, endpoints: { url: exchangeUrl }, remote: true }`. From here the
   existing redeem branches run unchanged: `registerEnrollmentMesh` when the space is unregistered,
   the IdP and exchange pin comparison when it is registered, then
   `provisionRemoteUserForeground(target, name, { body: bundle, exchangeUrl })`.
5. `provisionRemoteUserForeground` writes the token and sentinel to the child's own 0600 files,
   runs the bearer preflight with `agent-bearer --exchange-url <exchangeUrl> --token-file <child path>`,
   and the connector launches with `COTAL_LIFECYCLE_UID` equal to the handoff's `lifecycleUid`.

The existing `COTAL_ENROLLMENT_URL` and `COTAL_ENROLLMENT_FILE` behavior is unchanged.

### `@cotal-ai/manager`, the delegation in `implementations/manager/src/manager.ts`

No new `ManagerOptions` field and no new wire kind.

```ts
// private members of Manager
private composeManagedHandoff(
  enrolled: { owner: string; actor: string; lifecycleUid: string; sentinelCreds: string; agentBearerExchangeUrl: string;
              subscribe: string[]; allowSubscribe: string[]; allowPublish: string[] },
  actorToken: string,
): ManagedLifecycleHandoff;

private readonly delegatedLaunched: Set<string>; // lifecycleUids already handed to spawnDelegated
```

The delegated arm of the spawn path runs when `this.runtime.spawnDelegated` is defined:

1. It requires user mode and `remoteAuthority.enrollManagedAgent`. Otherwise the spawn refuses
   before any effect: a delegated seat has no local grant path.
2. It refuses before enrollment when the manager's registry record for the space is missing, or its
   exchange URL differs from `remoteAuthority.agentBearerExchangeUrl`.
3. It refuses, before enrollment and before any runtime effect, every spawn choice that only the
   manager's host can honour, naming the choice:
   - `resume`: the session id names a session on the manager's host, and a delegated child starts
     a fresh connector session. Portable resume is not part of this cut.
   - `cwd`: the path is on the manager's filesystem. The child runs in the provider resource's own
     working directory and never in the manager's workspace root.
   - shared MCP servers: the set `connectorServers(loadCotalConfig(workspaceRoot), agent,
     parseShareSelection(shareTools))` must be empty, because each server is a command on the
     manager's host. A spawn that would share any, from `--share-tools` or from the config default,
     refuses and names them; `--share-tools none` passes.
   - `supervise`: already refused for every user-mode seat (`manager.ts:5196`).

   The operator's `spawn.env` allow-list does not apply: it selects names from the manager's own
   environment, and no value from that environment crosses.
4. `enrollUserAgent` keeps its behavior: one enrollment, digest only, the host's UID, the token in
   the manager's own `SecretStore`, and the in-process bearer preflight that proves the chain before
   the handoff leaves.
5. Its result additionally carries the enrollment result fields above and the token it generated,
   so `composeManagedHandoff` needs no second read. A host exchange URL that differs from the record
   fails the spawn after enrollment through the existing post-enrollment rollback, which retires that
   lifecycle.
6. The manager resolves the persona and role as today and passes the persona's text and the role it
   enrolled with. It resolves the connector locally only for its existing gates (readiness window,
   prompt support, event channel). It never calls `connector.buildLaunch` for a delegated seat, so
   no launch-material file, control token or manager path is produced.
7. It adds the UID to `delegatedLaunched`, calls `spawnDelegated(launch, handoff)` once, and drops
   its reference to the handoff. A UID already in the set refuses a second call.
8. Readiness is `awaitReadiness` unchanged: exact-principal and exact-incarnation presence.

## Readiness and the lost acknowledgement

Readiness stays observed from mesh presence. `✓ started` still means the child joined as
`owner.actor` at `lifecycleUid`.

A create whose acknowledgement is lost, times out or answers ambiguously leaves the handle
`"running"`. The readiness window then settles as `uncertain` through the existing branch
(`manager.ts:6455-6456`), the agent stays managed and held, and the diagnostic names what was not
observed: no presence for that principal and incarnation, and no provider exit or close. The manager
never reports it exited on that evidence, never calls `spawnDelegated` again for that UID, and never
enrolls again for that name while the alias is held.

A provider read that finds no resource under the key does not change this. After an ambiguous
create, the create may still be in flight and materialize later, so absence is not an exit and the
handle stays `"running"`. Only an observed child exit, or a fenced close that completed, makes it
`"exited"`. This matters because the manager reaps any handle that reads `"exited"` through
`onAgentExit` (`manager.ts:2450`, `:6463`, `:6498`), which would free the alias while a create could
still start a child.

A child that joins later is observed by presence as usual. An operator who decides it is gone stops
it through the retirement path below. Its close by key is fenced, so it settles whether or not the
child ever started and never completes ahead of a create that could still land.

The labelled pooled fixture runtime in `implementations/manager/smoke/remote-manager-proc.ts` marks a
non-200 create as exited. That is a test fixture, and a `spawnDelegated` runtime must not copy it.

## Retirement

Retirement reuses the remote path that exists. There is no second retirement protocol, no
participant stop kind, and no close or adopt keyed on the agent name.

With the enrolling manager present, a stop of a delegated seat runs, in order:

1. `remoteAuthority.prepareAgentRetirement({ target: { owner, actor, lifecycleUid }, opId: managedRetirementOpId(lifecycleUid) })`.
   The host revokes the managed grant and finishes its resumable release while keeping the UID. From
   here the child can obtain no fresh bearer.
2. The known-handle provider closure: `stop()` on the handle `spawnDelegated` returned, which is the
   fenced close of the resource at `managedRuntimeKey(target)`, then a bounded `waitForExit()`. A
   close that cannot yet prove no create for the key is pending leaves this step uncertain.
3. The terminal barrier: `mintRetirementRequester` and the auth `retireLifecycle` rail with the same
   operation id, as `driveDeprovision` does today (`manager.ts:4100-4110`).

For a delegated seat the manager's stop does not call `handle.stop()` before step 1. Step 2 sits
between the two calls the remote branch of `driveDeprovision` already makes. A failure or an
uncertain outcome at any step keeps the alias held, and a retry repeats the same steps with the same
operation id.

After the enrolling manager is gone, the host runs the same three steps with its own authority: its
own grant revocation and release (the host operation behind `prepareAgentRetirement`), the fenced
close at `managedRuntimeKey(target)`, and `POST /managed-lifecycle/retire` (`MANAGED_RETIRE_PATH`)
with `{ owner, actor, lifecycleUid }`. That door and the rail share one flight and one operation id,
so a late manager request and the host call converge on one barrier. The host does not know whether
the manager's create was answered, so its close must fence the key itself.

A composition supplies `spawnDelegated` only if its host can perform the fenced close by
`managedRuntimeKey` without the manager: the provider offers a close that refuses any later create
under the key, or a way to prove that no create for the key is still pending. A runtime that keeps
the only provider handle inside the manager's process does not qualify, because its seats could not
be closed after the manager is gone.

A delegated lifecycle is not resumed or re-handed by a later manager incarnation in this cut. It runs
until a stop, and a stop always takes the path above.

## Relation to the runtime-create kinds

`manager-managed-agent-runtime-create` and `-runtime-status` (SPEC §13.1) address a runtime the host
creates and whose provider reference only the host holds. Their closed schemas carry no material, so
a host-created child cannot receive the raw token from the manager without a relay this design does
not add. They stay as they are. `spawnDelegated` covers the case where the manager's runtime creates
the child and hands it the material; a later change may join the two.

## Rejected shapes

- A second enrollment from the child. It makes a lifecycle the host did not intend and a second grant
  to retire.
- A copy of the manager's token, sentinel or launch-material files into the child. It exports
  manager paths and custody the child does not need.
- A host-minted redeem URL for a manager-enrolled lifecycle. Forbidden by `SPEC.md:1340-1341` and
  `docs/embedding.md:370-372`, as above.
- A manager-served redeem URL. It adds a listener for one read.
- Passing material through `LaunchSpec.env` or argv. Both are inherited or visible.
- Custody inside the spawn handler. `runCli` parses flags strictly, prints help and seeds
  extensions before it calls a handler, and each can exit with the file still on disk.
- A general delegation framework (sealed relays, attested keys, a delegation token). Larger than the
  one consumer this issue needs.

## Native acceptance

These are hand tests an operator runs on a disposable stack against the implementation. They are not
smoke suites. Each names what to observe. Rows A1 to A5 are the issue's acceptance list.

Setup: a broker, the auth service and a host composition that implements `enrollManagedAgent`,
`prepareAgentRetirement` and `MANAGED_RETIRE_PATH`; a signerless remote manager; a runtime with
`spawnDelegated` whose child runs in a container or a mount namespace where the manager's workspace
root, `COTAL_HOME` and tmpdir are absent; a real connector with a pinned model.

| Row | Do | Observe |
| --- | --- | --- |
| A1 | `cotal spawn <persona> --detach --model <pinned>` on the manager, then DM the seat | presence shows the enrolled `owner`, `actor` and `lifecycleUid`; the seat answers with a real turn on the pinned model |
| A2 | read the host ledger and enrollment records for the actor | one enrollment and one grant for that UID; the grant's token digest equals the digest the manager sent; no other UID for the name |
| A3 | `cotal stop <name>` on the manager | host log shows prepare, then provider close at `managedRuntimeKey`, then the barrier; lifecycle head `retired` at that UID; the alias is free (a new spawn gets a new UID) |
| A4 | spawn again, kill the manager, then run the host's retirement for the UID | the same three steps without the manager; `POST /managed-lifecycle/retire` answers `retired: true`; alias released |
| A5 | start the child by hand three times, each with one of `--expect-owner`, `--name`, `--expect-lifecycle-uid` changed | each exits non-zero naming the field; the broker shows no connection from the child, the auth service shows no exchange request, the handoff file is gone |
| A6 | drop the provider's create answer once (a proxy that closes the connection after forwarding) | the manager reports launch status uncertain, `cotal ps` shows the seat held and not exited, the provider shows one create for the key, and nothing enrolls or creates again |
| A7 | inside a running child, list its environment and search its filesystem | no manager path, no `issuer.json`, `callout.json` or `auth-service.json`, no provisioner or supervisor creds, no control token; `COTAL_MANAGED_HANDOFF_FILE` is absent from the harness's environment and its file is deleted |
| A8 | rerun the child's command with the same handoff path | refused, the file no longer exists |
| A9 | redeem a host-minted enrollment URL with `COTAL_ENROLLMENT_FILE` on the same build | unchanged behavior |
| A10 | read a handoff with one extra field, a wrong `kind`, mode 0644, or a token in argv | each refused before any plane opens |
| A11 | start the child by hand with a valid handoff file and, in turn, `--detach`, `COTAL_ENROLLMENT_FILE` also set, no `--expect-owner`, and a `--config` that does not load | each exits non-zero naming the problem and no file content; the handoff file is gone every time |
| A12 | on the manager, `cotal spawn <persona> --detach` with, in turn, `--resume <id>`, `--cwd <dir>`, `--share-tools <server>`, and no flag while the config shares a server with that connector | each refused naming the choice; the host shows no enrollment and the provider no create; `--share-tools none` spawns |
| A13 | hold the provider's create behind a proxy that drops its answer and delays it, read status while the provider still reports no resource for the key, then release the create and run `cotal stop <name>` | `cotal ps` keeps the seat held and not exited throughout; the stop's close does not complete until the create has landed or the key is fenced; afterwards no resource exists under the key and the alias is free |
| A14 | start the child's command by hand with a valid handoff file and, in turn, `--space` given twice, `--space` with no value, `--help`, `cotal --version`, an unknown command, and a Node older than 22 | each ends as the same command does without a handoff; the handoff file is gone every time |

## Evidence behind this record

The gap was reproduced at the pinned head with the labelled pooled execution-host fixture
(`remote-ef-accepted-goal.smoke.ts` with `EF_POOLED=1`): the child joins on a shared filesystem and
inside an unmasked mount namespace, and fails with `ENOENT` once the manager's workspace root is
masked from it. The redeem input was run live against a detached spawn and refused before any
network call. A live redeem of a manager-enrolled lifecycle's material through a host-held URL was
not run, because no host can mint one without the raw token, and building one would fabricate the
bundle under test.
