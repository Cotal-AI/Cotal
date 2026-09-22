# Signer isolation

> **Design** (non-normative, not shipped) · Closes [embedding](../embedding.md) remaining gap
> ("The remaining hosted gap is signer isolation"). Wire contract unchanged: no new subject, no new
> stream, no new message type. This is a composition-root and OS-custody seam.

**Status:** design. Nothing here is implemented. Review gate: this doc is approved before any code
lands.

**Citations.** Every `file` / function below was read in this worktree at `c5c462886`. No seed, key,
or credential value is reproduced.

The account signer is the nkey seed that issues user JWTs for one space's data account. Today the
manager process loads that seed and also spawns agent children. This document moves the seed to a
separate uid (and, where the operator opts in, a private mount namespace) so that an agent child,
or code that later runs with the manager's privileges after a compromise of the agent-facing
surface, cannot read it. The proof is a failed read from an agent, with a positive control that
the manager can still mint.

---

## 1. Where the signer lives today

A space is one NATS account. Every agent is a user in it. The module comment on
`packages/core/src/provision.ts` states the rule: the signing key stays with whoever holds
`SpaceAuth.account.signingSeed`. That field is the provisioner secret
(`SpaceAccountAuth` in `provision.ts`). The operator seed and the account seed are a higher
privilege (they re-issue account and operator JWTs). They are named below where rotation needs
them. They are not the signer this isolation is about.

### 1.1 The bytes

On a workstation the default store is `workspaceSecretStore(root)`
(`packages/workspace/src/secret-store-fs.ts`), which is `new FsSecretStore(join(root, ".cotal"))`.
`FsSecretStore.get` reads the file as UTF-8. `FsSecretStore.put` creates the parent with
`mkSecretDir` (`packages/core/src/secret-fs.ts`, mode `0o700` at create) and writes with
`writeSecretFileAtomic` → `writeSecretFile` (mode `0o600` at create). Those modes contain other
uids. They do not contain a same-uid reader.

The signer-bearing keys (`packages/workspace/src/auth-paths.ts`):

| Store key | Function | Default path under `.cotal/` |
|---|---|---|
| `BROKER_AUTH_KEY` (`auth/broker.json`) | broker operator + system-account JWTs | `auth/broker.json` |
| `spaceAccountKey(space)` (`auth/account.<hex>.json`) | this space's data account, including `account.signingSeed` | `auth/account.<hex>.json` |
| `SPACE_AUTH_KEY` (`auth/auth.json`) | legacy monolith / `cotal mint --signer` mount | `auth/auth.json` |

`getSpaceAuth(store, space)` is the reader for every signer-bearing path: manager start, renewal,
CLI mint. It composes broker + account records, or accepts the legacy monolith when both split
records are absent. `loadSpaceAuth(dir, space)` is the filesystem twin, including the stripped
signer shape (`stripSpaceAuth` in `provision.ts`): operator blanked, `account.signingSeed` kept.
`cotal mint --signer` (`implementations/cli/src/commands/mint.ts`, `mint`) writes that stripped
bundle with `writeSecretFile`.

`SecretStore` itself says the quiet part (`packages/core/src/secret-store.ts`): `get` exports the
value, v1 accepts that signing material enters process memory (`mintCreds`), and a non-exportable
sign/mint seam would be a separate capability. Isolation is that seam.

### 1.2 Load, hold, use in the manager

`Manager` (`implementations/manager/src/manager.ts`):

- **Load.** `constructor` sets `this.secrets` to `opts.secretStore` or
  `workspaceSecretStore(this.workspaceRoot)` (`ManagerOptions.secretStore`). `runStart` assigns
  `this.auth = await getSpaceAuth(this.secrets, this.space)` and keeps that composed `SpaceAuth`
  for the process lifetime.
- **Hold.** `this.auth.account.signingSeed` is then in the manager's address space. Injecting
  KMS/Vault through `secretStore` changes where the bytes are stored at rest. It does not stop
  `getSpaceAuth` from decrypting them into `this.auth`. `docs/embedding.md` already names this:
  custody is resolved, isolation is not.
- **Use.** Every mint in this process calls `mintCreds` / `provisionAgent` with `this.auth` (or a
  closed-over `auth` from `runStart`). `mintCreds` (`provision.ts`) does
  `fromSeed(auth.account.signingSeed)` and `encodeUser(..., { signer })`. `provisionAgent` is
  durables then `mintCreds(..., "agent")`. `mintPublicUserJwt` is the same `fromSeed` for the
  closed remote-manager protocol.

Every production `mintCreds` / `getSpaceAuth` on this host is a signer client after isolation.
Smokes that mint into a fixture are not.

**`Manager` (`manager.ts`) holds `this.auth` and passes it into `mintCreds`:**

| Profile | Function |
|---|---|
| `supervisor` | `runStart` (standing cred, self-renewed from the same seed) |
| `provisioner` | `withProvisioner`; also spawn rollback / session-plane helpers |
| `issuer` | `withIssuer` |
| `lifecycle-executor` | `withLifecycleExecutor` |
| `endpoint-serve-executor` | `withEndpointServeExecutor` |
| `endpoint-serve` | registration / serve mint |
| `agent` | spawn (`provisionAgent` via `withIssuer` + `withProvisioner`); `renewManagedStaticCred` / `driveManagedStaticCredRenewal` |
| `purger` | `opPurge` |
| `deprovisioner` | static teardown |
| `retirement-requester` | retirement rail |
| `goal-writer` | goal index |
| `session-ledger` / `session-serving` / `session-caller` | console session plane |

**`RunHosting` (`implementations/manager/src/run-hosting.ts`) is a second holder of the same
object.** `Manager.runStart` constructs it with `auth: this.auth` (`manager.ts`).
`RunHostingContext.auth` is that `SpaceAuth`. Its mint sites:

| Profile | Function |
|---|---|
| `run-admitter` | `withAdmitter` |
| `run-driver` | `drive` (first mint) and `renew` (same nkey) |
| `run-mediator` | `drive` and `renew` |
| `run-operator` | `withOperator` (one-shot read / answer) |

**Barrier helpers take `opts.auth: SpaceAuth` from the manager (or from the CLI below) and mint
in-process today:**

| Profile | Function |
|---|---|
| `endpoint-evictor` | `makeManagerEndpointEvictionEvidence` (`endpoint-evict.ts`) |
| `endpoint-evictor` | `makeManagerHolderLivenessProbe` (`holder-liveness.ts`) |

**Operator commands in the manager package load their own bundle with `getSpaceAuth` and mint.
They are not `this.auth`, but they are the same seed on this host:**

| Profile | Function |
|---|---|
| `endpoint-serve-executor` | `runReconcileGate` (`commands.ts`) |
| `control-caller-privileged` | `runDeregisterInstance` (probe) |
| `endpoint-serve-executor` | `runDeregisterInstance` (delete) |

`remintDaemonCreds` (`packages/workspace/src/renewal.ts`) is the standing renewal owner: it
calls `getSpaceAuth` on the same store, then `mintCreds` for the `delivery` and `membership-rw`
profiles. The manager invokes it from `runStart`'s renewal path. `cotal doctor auth --fix` is the
offline caller.

**CLI signer clients** (each `getSpaceAuth` / `getSoleSpaceAuth` then `mintCreds`): `mint`
(`implementations/cli/src/commands/mint.ts`); `up` (provisioner, membership-rw, control-caller-admin);
`spawn` (operator, provisioner, deprovisioner); `join` (provisioner); `status` (observer, deployer);
`agents` (session-caller); `down-manifest` (`teardown`); `backup` / restore; `delivery-proc`
(`delivery`); `spawn-manifest` (`channel-writer`); attach scatter probe
(`implementations/cli/src/lib/control.ts`, `control-caller-privileged`). They run as a uid on the
signer allowlist after §6, never as `cotal-agent`.

`connect.ts` (`packages/workspace/src/connect.ts`) mints `control-caller-privileged`,
`control-caller-admin`, and `deployer` from `target.auth`. `preflight.ts` mints `probe` from
`target.auth`. Both are the CLI/workspace composition, not a child of the manager.

**Other production processes on this host that mint from a loaded `SpaceAuth` today:**

| Profile | Function |
|---|---|
| `issuer` | `withIssuerSession` (`packages/core/src/issuer-session.ts`); any caller that already holds `SpaceAuth` |
| `delivery` | `runDelivery` `--dev-mint` (`implementations/delivery/src/delivery.ts`); production delivery reads a pre-minted cred and does not load the signer |
| `run-mediator` / `run-admitter` | local `cotal run` (`implementations/runtime/src/run-command.ts`) from `conn.auth` |
| `channel-purger` | `web()` (`implementations/web/src/web.ts`); last use of `conn.auth` before the handler drops the seed |
| `session-serving` / `retirement-requester` / `endpoint-serve` / `remote-manager` / `goal-writer` / `session-ledger` | `mintPublicUserJwt` in `openAuthAuthorityPlane` (`implementations/auth/src/service.ts`): the `credential` helper at the `issueManagerServiceAuthority` arm, and the later session / retire / activate arms, each pass `{ space, account: { pub, signingSeed } }` |

**Auth-service process.** It does not load the seed through `getSpaceAuth`. `runAuthService`
(`implementations/auth/src/service.ts`) calls `loadServiceKeys` (`store.ts`), which requires
`dataAccount.signingSeed` in the `service-keys.json` projection, then hands that pair to
`openAuthAuthorityPlane` and `startAuthCallout`. Production uses of those bytes in this process
are not only JWT minting:

| Use | File / function | What the bytes do |
|---|---|---|
| JWT `encodeUser` | `startAuthCallout` (`callout.ts`) `fromSeed(opts.dataAccount.signingSeed)` as `userSigner` | connect-time user JWTs |
| JWT `encodeUser` | `openAuthorityClient` (`authority-client.ts`) `fromSeed(opts.dataAccount.signingSeed)` | self-minted infra connections |
| JWT `mintCreds` | `makeDeliveryAdminEvictor` (`barrier-evict.ts`) builds a stripped `SpaceAuth` and mints `supervisor` | per-call delivery-admin evictor |
| JWT `mintCreds` | `makeDeliveryAdminPlaneOracle` (`plane-claim.ts`) same stripped `SpaceAuth` | per-call plane liveness oracle |
| JWT `openAuthorityClient` | `makeDrainRepairers` (`drain-repair.ts`) | per-repair applier credential |
| JWT `mintPublicUserJwt` | `openAuthAuthorityPlane` (`service.ts`) `issueManagerServiceAuthority` | remote-manager user JWTs |
| HMAC-SHA256 | `remoteManagerCurrentRegistrationProof` (`retained-manager-validation.ts`) `createHmac("sha256", secret)` | registration proof over a domain-separated payload |
| HMAC-SHA256 | `openAuthAuthorityPlane` (`service.ts`) passes `dataAccount.signingSeed` as `proofSecret` into `authorizeRemoteRetainedAgentValidation`, `authorizeRemoteManagerGoalIndexScan`, and `authorizeRemoteManagerAdmin`, and as the secret of `remoteManagerCurrentRegistrationProof` when issuing `nextRegistrationProof` | the same MAC, four call sites |
| Public-key derivation | `userAuthTrustFingerprint` (`continuity.ts`) `publicFromSeed(keys.dataAccount.signingSeed)` | `fromSeed` then `getPublicKey`; the fingerprint does not sign |

`deriveOwnerToken` (`derive.ts`) also HMACs, but its secret is the owner-derivation secret from
`loadOwnerSecret`, not `account.signingSeed`.

Isolation that only wraps `encodeUser` leaves the HMAC call sites holding the seed. The auth
service is a sibling signer client on the same host. After §3 it dials the same socket for
`sign-user` and `mac`, and its store projection keeps `pub` / `signingPub` only.

### 1.3 What is not the account signer

`loadManagerInstanceIdentity` / `saveManagerInstanceIdentity` (`auth-paths.ts`) persist the
manager's serve nkey seed. That is the instance's own user identity (SPEC 13.6), not the account
signing seed. Isolation of the account signer does not move it.

`rotateSystemAccount` / `rotateSystemCreds` (`provision.ts`, `packages/workspace/src/system-rotation.ts`)
need the operator seed. That material is broker-wide. It does not belong in the user-JWT signer.

### 1.4 The agent-facing surface is not a Unix control socket

The brief's "control socket" on the manager is HTTP. `AttachEndpoint`
(`implementations/manager/src/attach-endpoint.ts`) is created in `Manager`'s constructor
(`attachHost` default `127.0.0.1`, `consolePort` default `0`). `AttachEndpoint.start` binds
`this.#http.listen(this.#port, this.#host)`. Data routes require the per-process console token
(`#authorized`). WebSocket upgrades are refused with 400. `cotal attach` reaches a manager over
the mesh session, not by dialing this face. There is no manager Unix socket to permission.

The Unix socket that does exist is seat custody, in `packages/seat`. It is the pattern this
design copies for the signer, not a path that currently carries the seed.

---

## 2. The threat

The spawn path never changes uid, never unshares a mount namespace, and still forwards `HOME`.
File mode `0o600` is then the same uid on both sides of the "boundary".

### 2.1 Uid

`LegacyPtyRuntime.spawn` (`implementations/manager/src/runtime/pty.ts`) calls `pty.spawn` with
`cwd` and `env: spec.env ?? {}`. No `uid` / `gid` option.

Production Linux goes through `CustodialPtyRuntime.spawn`
(`implementations/manager/src/runtime/custodial-pty.ts`) → `launchSeat`
(`packages/seat/src/launcher.ts`). `launchSeat` `spawn`s the custodian with `detached: true` and
a scrubbed env. `runCustodian` (`packages/seat/src/custodian.ts`) then `pty.spawn`s the agent
with `launch.env`. Neither spawn drops uid. Custodian, agent child, and manager share the
operator uid that started `cotal up`. After isolation the manager is `cotal-manager` and cannot
`setuid`; §3.3 names the privileged launcher that performs the drop.

### 2.2 Mount namespace

No spawn site calls `unshare` or enters a private mount namespace. The agent's view of
`$ROOT/.cotal/auth` is the manager's view.

### 2.3 Environment inheritance

`launchEnv` (`extensions/connector-core/src/launch.ts`) copies a fixed OS allow-list, including
`HOME`, `USERPROFILE`, and the `XDG_*` roots, plus `spawnEnvAllow(config)` extras
(`packages/core/src/connector-config.ts`, read by `Manager` at spawn as `envAllow`). The file
comment on `launch.ts` is honest: the allow-list does not close filesystem secret access. A child
with a shell reads `~/.cotal` off disk.

Cotal connection material is not in the environment. `materialEnv` writes a `0o600` launch file
and puts only its path in `COTAL_LAUNCH_MATERIAL` (`packages/core/src/launch-material.ts`,
`writeLaunchMaterial`). That file holds the agent's own creds path and control token, not
`account.signingSeed`. A same-uid process that wants the signer does not need it: it opens
`auth/account.<hex>.json` or `auth/auth.json`.

### 2.4 Sockets the child can reach

Seat: `runCustodian` `mkdirSync`s the socket directory at `0o700`, `listen`s on
`socketPath(root, id)` (`packages/seat/src/record.ts`, `…/seat.sock`), then `chmodSync(..., 0o600)`.
Every request runs `peerCredentials(sock)` (`packages/seat/src/peercred.ts`, `SO_PEERCRED`) and
refuses a peer uid other than the custodian's own. `hello` then checks the capability token.
Same uid is the intended manager-to-custodian path. An agent child that is that uid and that
learns the token (the launch JSON is the token's home) is a same-uid peer. This socket does not
hold the account signer. It shows the only permissioned Unix pattern in the tree.

Manager attach: loopback HTTP plus a token printed to the manager's own output. An agent that
can read that output and reach the bind host can hit roster / feed / `POST /session/<name>`.
That is session mint, still using `this.auth` in-process. It is not a Unix ACL.

### 2.5 What a compromise actually gets

Two attackers, same missing boundary:

1. **Agent child (or a tool it shells out to).** Same uid, same mounts, `HOME` set. It reads the
   account record and now mints any profile `permissionsFor` will encode, including `admin` /
   `provisioner` / `purger`. `docs/embedding.md` ("Hazardous provisioning primitives") already
   warns against co-locating signer access with an untrusted connector at the same OS uid.
2. **Code running as the manager after the agent-facing surface is compromised.** `this.auth` is
   already in memory; `FsSecretStore.get` still works. Isolation cannot stop that process from
   *asking* a signer to mint while it is still the authorized client. Isolation can stop it from
   *copying the seed* for use after the manager is killed and the signing key is rotated.

---

## 3. The design

A dedicated signer process holds `account.signingSeed`. The manager, the auth service, and
`cotal mint` / `remintDaemonCreds` never observe the seed. They send already-built user-JWT
claims or a MAC payload over a permissioned Unix socket and receive a signed JWT or a hex
digest. If the socket is absent, or if a composed `SpaceAuth` or service-keys projection still
carries a non-empty `signingSeed` in the caller's process, the caller throws. There is no
in-process `fromSeed` or `createHmac(signingSeed)` fallback.

Linux is the production path, matching `@cotal-ai/seat`. Other platforms refuse a static-auth
manager start with a named error rather than signing in-process.

### 3.1 Smallest interface

`mintCreds`, `mintPublicUserJwt`, `encodeUser` in `openAuthorityClient` / `startAuthCallout`,
and the stripped `SpaceAuth` mints in `barrier-evict.ts` / `plane-claim.ts` need the seed for
one call: `encodeUser`. `remoteManagerCurrentRegistrationProof` needs it for a different call:
`createHmac("sha256", secret)` over a domain-separated prefix plus a JSON payload
(`retained-manager-validation.ts`). Permission rows, lifetimes, issuance fences, and creds
wrapping stay in the caller. The signer does not implement `permissionsFor`, SPEC 13.9, or the
issuance ledger. A separate proof secret is not introduced: today's four HMAC call sites already
bind the registration proof to this seed, and splitting it would leave a second retained secret
on the auth-service uid.

Two requests, one socket:

```
sign-user
  name:        JWT name (the profile label mintCreds already passes to encodeUser)
  userPub:     user nkey public id
  accountPub:  data-account public id
  claims:      the object mintCreds already passes as perms + principalTags
  iat, exp:    the valid dates userValidDates already computed

mac
  domain:      the exact prefix remoteManagerCurrentRegistrationProof already concatenates
               before the payload (today: cotal/manager-current-registration/v1 plus NUL)
  payload:     the JSON string that function already HMAC-updates after the prefix
```

`sign-user` replies with the signed user JWT string. The caller still runs `fmtCreds` /
issuance release. `mac` replies with the hex digest (the `sha256:` prefix is still applied by
`remoteManagerCurrentRegistrationProof`). `userAuthTrustFingerprint` needs only the public key
of this seed (`publicFromSeed` in `continuity.ts`); after isolation that value is
`account.signingPub` on the projection, so the fingerprint does not dial the socket.

The signer holds the seed for **one** space account. A host with several spaces runs one signer
process per space (or one process with several private seeds, still no export).

### 3.2 What it refuses

The signer never returns the seed, never logs it, and never writes it to a path the manager uid
or the auth-service uid can read.

It refuses, loud:

- Peer uid not in the allowlist (`SO_PEERCRED`, same helper as `peerCredentials` in
  `packages/seat/src/peercred.ts`). The allowlist is `cotal-manager` and the auth-service uid
  (same group, or a dedicated `cotal-auth` uid added to `cotal-manager`).
- Missing or mismatched capability token (same shape as `runCustodian`'s `hello`).
- `accountPub` other than the held account (`sign-user`).
- A claims object that is not a NATS user-JWT body (no operator/account JWT encoding, no
  arbitrary byte sign).
- `mac` whose `domain` is not the one frozen prefix `remoteManagerCurrentRegistrationProof`
  uses. No generic HMAC, no empty domain, no caller-chosen hash.
- `sign-user` or `mac` after the process has been asked to stop holding the seed (rotation drain).
- Any export / dump / rotate-seed op on the **manager-facing** socket. Rotation is §4.

A compromised manager can still mint for as long as it can open the socket. That is the
authorized client. It cannot take the seed with it.

### 3.3 Uid split

Three uids, one group. The auth service, when present, is a fourth uid in that group:

| Uid | What it can open |
|---|---|
| `cotal-signer` | the seed file (`0600`), the socket (owner) |
| `cotal-manager` | the socket (group), the capability-token file (`0640` signer:manager-group), the rest of the workspace |
| `cotal-auth` (optional; otherwise the auth service runs as `cotal-manager`) | the socket (group) and the token file; not the seed |
| `cotal-agent` | the agent's own launch material and creds file, not the seed, not the token file, not the socket |

Suggested group: `cotal-manager`. The signer user owns the seed directory `0700`. The socket
directory is `0750` `cotal-signer:cotal-manager`. The socket is `0660` after bind (the seat
pattern is `chmodSync(path, 0o600)` in `runCustodian`; here the group must be able to connect,
so `0660`, then `SO_PEERCRED` allowlist). `connect(2)` needs the write bit on a Unix socket,
not the read bit, so `0660` is the smallest mode that admits the group.

`cotal-agent` is in none of these groups. It holds only its own primary group, and the
seat-launch helper refuses to spawn if it is a member of `cotal-manager` (§3.3). The seat
files a `cotal-agent` custodian writes still carry group `cotal-manager`, because the
directory they are created in carries the set-group-id bit, which is a property of the
directory rather than a group the writer holds.

The current spawn chain cannot perform that drop. `launchSeat` (`packages/seat/src/launcher.ts`)
`spawn`s the custodian as the caller; `runCustodian` then `pty.spawn`s the agent. Neither call
sets uid. A process already running as `cotal-manager` that calls `setuid(cotal-agent)` gets
`EPERM`. A linger `systemctl --user` unit cannot start a unit as another uid. Isolation is not
on until a **privileged launcher** exists; the manager throws at start if it is absent.

**Named boundary: `cotal-seat-launch`, a system unit, not a user unit.** It is the only process
that may change uid. The manager never receives `CAP_SETUID`.

- Unit: `cotal-seat-launch.service`, `User=root` (or a dedicated user whose
  `CapabilityBoundingSet` / `AmbientCapabilities` are only `CAP_SETUID` and `CAP_SETGID`).
- Socket: `/run/cotal/seat-launch.sock`, directory `0750` `root:cotal-manager`, socket `0660`
  after bind. Same listen / chmod / truncation check as `runCustodian`.
- Auth: `peerCredentials` allowlist is the `cotal-manager` uid only, then a capability token
  (the seat `hello` pattern).
- Request: the existing custodian launch JSON plus target uid/gid, which the helper hard-codes
  to `cotal-agent` (it refuses any other target).
- Action, **before** `setuid`:
  1. Resolve the custody root from the launch JSON (`root` in `launchSeat`). Isolation
     **changes the shipped default.** Today's `defaultCustodyRoot`
     (`implementations/manager/src/runtime/custodial-pty.ts`) is
     `join(homedir(), ".cotal", "seats")`, so a manager started as `cotal-manager` lands
     at `/home/cotal-manager/.cotal/seats`. That path is not traversable by `cotal-agent`
     after the drop. `mkSecretDir` (`packages/core/src/secret-fs.ts`) creates
     `~/.cotal` at `0700` (then `hardenPrivate` reasserts `0700` on POSIX). `FsSecretStore.put`
     (`packages/workspace/src/secret-store-fs.ts`) calls `mkSecretDir(dirname(p))` for every
     secret under that tree, including `auth/`. A Node `mkdirSync(..., { recursive: true,
     mode: 0o700 })` of the seats path (the `CustodialPtyRuntime` constructor and
     `launchSeat`) creates the same `0700` ancestor chain: measured, `home`, `.cotal`, and
     `seats` all come out `0700`. Chowning only the custody root and the per-seat directory
     does not grant traverse of `/home/cotal-manager/.cotal`. Measured: opening
     `seat.sock` through an ancestor with execute stripped fails `EACCES` even when the
     children are `0777`; the same open succeeds after that ancestor is `0711`. Widening
     `~/.cotal` to `0711` is refused: that directory holds every credential
     (`auth/account.<hex>.json`, launch material, daemon creds) and `mkSecretDir` /
     `hardenPrivate` would put it back to `0700` on the next secret write. The helper
     therefore does not chmod `.cotal`. The shipped default after isolation is
     `/var/lib/cotal/seats`. `CustodialPtyRuntime` on Linux static-auth uses that path
     unless `COTAL_SEAT_ROOT` names another **agent-traversable** root. `$HOME/.cotal/seats`
     is no longer a valid default.
  2. Walk every ancestor of the resolved root from `/` to the seat directory. Required
     layout for the shipped default (install asserts this; the helper refuses a mismatch
     and never widens a mode it did not create):

     | Path | Mode | Owner |
     |---|---|---|
     | `/` | kernel | root |
     | `/var` | `0755` | `root:root` |
     | `/var/lib` | `0755` | `root:root` |
     | `/var/lib/cotal` | `0711` | `root:root` |
     | `/var/lib/cotal/seats` (custody root) | `2771` | `root:cotal-manager` |
     | `/var/lib/cotal/seats/<id>` (per-seat) | `2770` | `cotal-agent:cotal-manager` |

     `/var/lib/cotal` is `0711` so `cotal-agent` and `cotal-manager` can traverse to
     `seats/` without listing siblings (`signer/` lives under the same parent as
     `0700 cotal-signer`; execute-without-read is the same pattern as a private home).
     `0711` does not let `cotal-agent` open a sibling it cannot name. The custody root
     is owned by `root`, not by `cotal-agent`: the agent uid falls in the **other**
     class there and holds `--x`, so it can traverse into its own seat directory and
     cannot list the root or create a second entry in it. An operator override via
     `COTAL_SEAT_ROOT` must match the same rule: every ancestor from `/` down to the
     parent of the custody root is traversable by `cotal-agent` (`o+x` or an ACL that
     uid holds), the custody root is `2771` `root:cotal-manager`, and no ancestor is a
     `0700` directory owned by `cotal-manager` (so not `~/.cotal`). If any ancestor is
     missing, not a directory, owned by the wrong uid, or has a mode that denies
     `cotal-agent` execute, the helper throws, names the path, and does not `chmod` it.
     It never grants traverse on `/home/cotal-manager`, `/home/cotal-manager/.cotal`,
     or `.cotal/auth`.
  3. Assert that the `cotal-agent` user is **not** a member of the `cotal-manager`
     group, by reading that group's member list and the agent user's primary group.
     If it is a member, throw and name both: section 3.2 gives `cotal-manager` read on
     the signer capability-token file and connect on the signer socket, so an agent
     that held the group would reach the signer. This assertion is the reason the
     mechanism in (4) is the setgid bit and not group membership.
  4. `mkdir` only the custody root and the per-seat directory (`join(root, id)`) as
     root. Set the custody root to `2771` `root:cotal-manager` and the per-seat
     directory to `2770` `cotal-agent:cotal-manager`. The seat id is already minted
     before the launch: `reserve()` in `CustodialPtyRuntime`
     (`implementations/manager/src/runtime/custodial-pty.ts`) mints it and the manager
     records it durably, so the helper knows the directory name before any drop.

     The set-group-id bit on the per-seat directory is the whole mechanism. Linux gives
     a new inode the **creating process's effective gid** unless the parent directory
     carries that bit, in which case the new inode takes the **directory's** gid, and a
     new subdirectory takes the gid and the bit. Supplementary membership never selects
     an inode's group. Measured on a real filesystem: inside a plain `0750` directory
     whose group is `G`, a process with effective gid `1000` holding `G` only as a
     supplementary group created a `0640` file with gid `1000`, so the group could not
     read it; inside the same directory at `2750`, the same process created a `0640`
     file with gid `G`. Measured again from a process that did **not** hold `G` at all
     (effective gid and every supplementary group different from `G`): inside the
     `2750` directory, its new `0640` file, its new `0660` bound socket, and its new
     subdirectory all came out with gid `G`, and the subdirectory carried the bit
     forward. That is why the custodian never needs the manager group.

     `chown` does not clear the bit on a directory (measured: `2750` stayed `2750`
     across a `chown`), so the helper may `chown` and `chmod` in either order, and the
     `chmod` is the authoritative step. `mkdir` cannot set the bit, because the mode
     argument is masked by the umask (measured: `mkdir` with mode `0o2750` produced
     `0750`). The helper therefore always `chmod`s after `mkdir`. `chmod` itself is
     umask-independent (measured at umask `000`, `022`, `027`, and `077`).

     Today's `CustodialPtyRuntime` constructor
     (`mkdirSync(this.root, { recursive: true, mode: 0o700 })`) and `launchSeat`
     (`mkdirSync(opts.root, … 0o700)` then `mkdirSync(dirname(recPath), … 0o700)`)
     create those paths as the caller. After isolation the manager is `cotal-manager`
     and cannot chown to `cotal-agent`. If those calls still run as the manager, the
     root stays `0700` `cotal-manager` and the dropped custodian cannot write
     `seat.sock`. The helper creates only those two directories. It does not
     `mkdir -p` through `/var/lib/cotal` on a missing spine; install creates the
     `0711` parent, and a missing parent is the refusal in (2).
  5. Write the launch JSON into the per-seat directory as `launch.json` mode `0600`,
     `open` it, `unlink` it, and keep the descriptor. That is today's `launchSeat`
     sequence (`writeFileSync(launchPath, payload, { mode: 0o600 })`, `openSync`,
     `unlinkSync`), performed by the helper as root instead. The file is gone from the
     directory before any uid changes, and the open descriptor survives both the
     `unlink` and the `setuid`, so the token and `spec.env` reach the custodian on
     stdin with no agent-readable copy on disk at any moment.
  6. Then `fork`; in the child `setgid(cotal-agent)`, `initgroups("cotal-agent",
     cotal-agent)`, `setuid(cotal-agent)`, and `exec` the existing custodian entry with
     that descriptor as stdin. That is today's `launchSeat` minus the same-uid `spawn`.
     The PTY child then inherits `cotal-agent` without a second drop.

#### Process identities

Read every hop below against this table. Supplementary groups are the full set the
process holds after `initgroups`, not a subset.

| Process | Effective uid | Effective gid | Supplementary groups |
|---|---|---|---|
| `cotal-seat-launch` helper | `root` | `root` | none (`setgroups([])` at start) |
| custodian after the drop | `cotal-agent` | `cotal-agent` | `cotal-agent` only |
| agent PTY child | `cotal-agent` | `cotal-agent` | `cotal-agent` only |
| manager | `cotal-manager` | `cotal-manager` | `cotal-manager` only |
| signer | `cotal-signer` | `cotal-signer` | `cotal-signer` only |

The custodian holds `cotal-manager` neither as its effective gid nor as a supplementary
group. Step (3) asserts that before the drop and the helper refuses otherwise. The
custodian and the agent child therefore fail the group class on the signer socket
(`0660` `cotal-signer:cotal-manager`) and on the capability-token file (`0640`
`cotal-signer:cotal-manager`), whose other class is empty. The seat leaves still carry
group `cotal-manager` because the setgid bit put it there, not because the writer holds
it.

#### What the custodian writes after the drop

Today's `runCustodian` (`packages/seat/src/custodian.ts`) `mkdirSync`s
`dirname(launch.socket)` (`0o700`), `listen`s, `chmodSync(launch.socket, 0o600)`, and
`writeRecord` (`packages/seat/src/record.ts`) writes `record.json` `0600` then
`chmodSync(dirname(path), 0o700)`. Measured on a live `launchSeat` in this worktree:
directory `0700`, `seat.sock` `0600`, `record.json` `0600`. Applying only a helper
`chmod` of the per-seat directory to `0750` left the two leaves `0600`. Directory group
access does not add group permission to a `0600` leaf. Isolation therefore changes the
custodian, not a helper `chmod` of the directory. After the drop the custodian writes:

| Path | Mode | Owner | Who sets it |
|---|---|---|---|
| `/var/lib/cotal/seats/<id>` | `2770` | `cotal-agent:cotal-manager` | helper, preserved by the custodian |
| `/var/lib/cotal/seats/<id>/record.json` | `0640` | `cotal-agent:cotal-manager` | custodian `chmod`, group from the setgid bit |
| `/var/lib/cotal/seats/<id>/seat.sock` | `0660` | `cotal-agent:cotal-manager` | custodian `chmod` after `listen`, group from the setgid bit |
| `/var/lib/cotal/seats/<id>/custodian.log` | `0600` | `cotal-agent:cotal-manager` | custodian `appendFileSync` |

Four rules make that layout hold, and all four are changes to the shipped tree:

- The custodian sets `process.umask(0o027)` before it binds. `chmod` is
  umask-independent, so the umask does not decide the final mode, but it does decide the
  mode the socket carries between `listen` and the `chmod` on the next line. Measured at
  the inherited umask `0002` a freshly bound socket is `0775`, which is an other-class
  connect for the length of that window; measured at `0027` it is `0750`, which is not.
  Measured at `0027` the following `chmodSync(0o660)` still lands `0660`.
- `writeRecord` stops calling `chmodSync(dirname(path), 0o700)`. That call strips the
  setgid bit and the group bits from the directory the helper built (measured: `2750`
  became `0700`), which orphans every later inode and takes the manager's traverse with
  it. It also stops writing the record `0600`: the mode becomes `0640`, set by an
  explicit `chmodSync(path, 0o640)` after the write, because `writeFileSync` applies its
  `mode` argument only when it creates the file (measured: a rewrite with `mode: 0o600`
  left an existing `0640` file at `0640`).
- `writeRecord` stops calling `mkdirSync(dirname(path), { recursive: true, mode: 0o700 })`,
  and `runCustodian` stops calling `mkdirSync(dirname(launch.socket), { recursive: true,
  mode: 0o700 })`. On the directory the helper already made, both are no-ops (measured:
  a `2770` directory survived `mkdirSync(…, { recursive: true, mode: 0o700 })`
  unchanged), so they are not the failure; the failure is the case where the directory
  is absent. A `0700` directory created there by the custodian would inherit group
  `cotal-manager` from the custody root's setgid bit and still deny the group every
  bit, which reads as a correct group and adopts as `EACCES`. Both calls become a
  `statSync` assertion: the per-seat directory exists, is owned by this uid, has group
  `cotal-manager`, and carries mode `2770`. Anything else throws by name before the PTY
  is spawned.
- `runCustodian` `chmod`s the socket `0660` rather than `0600` after `listen`, keeping
  the truncation check ahead of it.

The peer check changes with them. Today's `handle` in `runCustodian` refuses any peer
whose `SO_PEERCRED` uid is not `process.getuid()` (the "peer uid mismatch" destroy).
After the drop that uid is `cotal-agent`, so a distinct `cotal-manager` is refused even
on a `0660` socket. The launch JSON gains an `adopterUid`, which the helper fills in
from the `SO_PEERCRED` of the manager's own connection to the launch socket and never
from a value the manager states. `handle` accepts that uid and no other. The agent uid
owns the socket and can therefore reach `connect`, and this check is what refuses it one
frame later, before `hello` is even read.

Readiness is the seat record, not a helper stdout line. `launchSeat`
(`packages/seat/src/launcher.ts`) polls `readRecord(recPath)` until `custodianPid > 0`
and `childPid > 0`. The dropped custodian still writes that record (`writeRecord` in
`runCustodian`). The JSON line `{ ready: true, childPid, custodianPid }` is written to
`custodian.log` when `logPath` is set, else to stdout (`custodian.ts`). The helper
`exec`s with the same launch JSON, so `logPath` is set and stdout is not the channel.
The helper polls `record.json` the same way `launchSeat` does. If that record never
appears, spawn throws. Today's `launchSeat` is `detached: true` and, on an early
custodian exit, reads `custodian.log` (`launcher.ts`). The helper is the parent of the
`fork` rather than a detached spawn, so an early exit is a `waitpid`, and the helper is
root, so it can also read that `0600` agent-owned log and return the message to the
manager over the launch socket. The manager never opens the log itself.

The helper never reads the account signing seed and is not on the signer allowlist.
After `exec` it never chmods a path it created in this request. A `COTAL_SEAT_ROOT`
under `~/.cotal` is a mismatch of (2) and is refused. The ancestor walk and both
`mkdir`s stay before `setuid` so the dropped custodian can create the leaves at all.

#### The adopt path, hop by hop

The manager runs as the identity in the table above: effective uid `cotal-manager`,
effective gid `cotal-manager`, supplementary groups `cotal-manager` only. It is not the
owner of any inode below, so every access is decided by the **group** class. The
permission classes are checked in order and the first matching class decides, so owner
bits do not add to group bits and a group bit never rescues an owner-class denial.
Measured on this filesystem: a `0040` file could not be read by its own owner
(`EACCES`), and a `0060` socket could not be connected by its own owner (`EACCES`).

| Hop | Call | Inode | Mode | Owner | Class used |
|---|---|---|---|---|---|
| 1 | traverse | `/` | kernel | `root:root` | other `x` |
| 2 | traverse | `/var` | `0755` | `root:root` | other `x` |
| 3 | traverse | `/var/lib` | `0755` | `root:root` | other `x` |
| 4 | traverse | `/var/lib/cotal` | `0711` | `root:root` | other `x`, no `r` |
| 5 | traverse, `readdir`, `unlink` an entry | `/var/lib/cotal/seats` | `2771` | `root:cotal-manager` | group `rwx` |
| 6 | traverse, `readdir`, `unlink` an entry | `/var/lib/cotal/seats/<id>` | `2770` | `cotal-agent:cotal-manager` | group `rwx` |
| 7 | `openat(O_RDONLY)` | `…/<id>/record.json` | `0640` | `cotal-agent:cotal-manager` | group `r` |
| 8 | `connect` | `…/<id>/seat.sock` | `0660` | `cotal-agent:cotal-manager` | group `w` |

1. Hops 1 to 4 are the traverse spine. `cotal-manager` holds no bit but the other-class
   `x` on all four, which is `search` permission and nothing else. At hop 4 it cannot
   `readdir`, so it cannot enumerate `/var/lib/cotal/signer`.
2. Hop 5 is the custody root. The manager is in its group, so it may `readdir` (the
   proof in section 5 globs `*/record.json` for a named seat) and may remove an entry,
   which is what `reapSeat` (`packages/seat/src/reap.ts`) needs when it `rmSync`s the
   seat directory. `cotal-agent` is other here and holds `--x`: it reaches its own seat
   directory and cannot list or create siblings.
3. Hop 6 is the per-seat directory. The manager needs `x` to resolve the two leaves,
   `r` for the same glob, and `w` because `reapSeat` unlinks `record.json` before
   removing the directory. Removing a name requires write on the containing directory,
   not on the file: measured, `unlink` of a file inside a `0570` directory failed
   `EACCES` for the directory's owner and succeeded at `0750`.
4. Hop 7 is `readRecord` / `loadSeat` (`packages/seat/src/record.ts`), reached from
   `CustodialPtyRuntime.adopt` and from the helper's readiness poll. `readFileSync`
   needs the group `r` bit that the setgid bit put a `cotal-manager` group on.
5. Hop 8 is `SeatClient.connect` (`packages/seat/src/client.ts`), called by
   `adoptSeatSync` (`packages/seat/src/handle.ts`) from `CustodialPtyRuntime.spawn` and
   `.adopt`. `connect(2)` on a Unix socket requires the **write** bit on the socket
   inode, not the read bit. Measured by stripping bits on a live listener: mode `0200`
   connected, mode `0400` failed `EACCES`, mode `0000` failed `EACCES`. `0660` gives the
   group that write bit.
6. Inside the custodian, `handle` calls `peerCredentials(sock)`
   (`packages/seat/src/peercred.ts`), which reads `SO_PEERCRED` through the native
   helper and returns the peer's pid, uid, and gid as the kernel recorded them at
   `connect`. The custodian compares that uid with `launch.adopterUid` and destroys the
   socket on a mismatch. A uid cannot state its own credential here, so a compromised
   agent that reached hop 8 as the socket's owner is refused at this line.
7. The manager then sends `hello` with the `token` it read at hop 7. The custodian
   compares it with `launch.token` and, on a match, adds the socket to `controllers`,
   disarms the unattended timer, and replies with the seat's name, child pid, geometry,
   and status. What it hands over is that frame stream and nothing else: there is no
   `SCM_RIGHTS` anywhere in `packages/seat`, so the PTY master descriptor stays in the
   custodian and the manager drives the seat by frames over the socket it already
   connected.
8. `reapSeat` signals only pids whose recorded start identity still matches, and
   `kill(2)` across a uid boundary is `EPERM` for an unprivileged sender (measured
   against pid 1). A manager that must reap a `cotal-agent` custodian therefore goes
   back through the `cotal-seat-launch` helper, which is the only process that may
   signal across that boundary. Reaping the record and the directory, hops 5 and 6, is
   the manager's own work and needs no privilege.

A distinct second uid was not available on the workstation where this design was
written, so hops 1 to 8 name the class each access falls into rather than claiming a
cross-uid run. The class rule itself, the setgid inheritance, the `connect` write bit,
the owner-class-first ordering, the `unlink` requirement, the umask window, and the
`chmod` behaviour were each measured on a real filesystem as reported above. Section 5
is the operator procedure that exercises the whole path with the real uids present.

`CustodialPtyRuntime.spawn` becomes a client of this socket. It no longer `mkdirSync`s the
root itself on Linux static-auth: that create is the helper's privileged step. If the
socket is missing, or the peer is not the helper, spawn throws. No in-process `pty.spawn`
fallback on Linux static-auth.

#### Required changes, by file

Stated as changes to the shipped tree, not as descriptions of it.

- `packages/seat/src/custodian.ts`: set `process.umask(0o027)` at the top of
  `runCustodian`; replace `mkdirSync(dirname(launch.socket), { recursive: true, mode:
  0o700 })` with a `statSync` assertion that the per-seat directory is mode `2770`,
  owned by this uid, and in the `cotal-manager` group; change
  `chmodSync(launch.socket, 0o600)` to `0o660`; add `adopterUid` to `CustodialLaunch`
  and change the peer check in `handle` from `cred.uid !== process.getuid()` to
  `cred.uid !== launch.adopterUid`.
- `packages/seat/src/record.ts`: in `writeRecord`, drop the `mkdirSync` of the parent,
  drop `chmodSync(dirname(path), 0o700)`, write the record with `mode: 0o640`, and
  `chmodSync(path, 0o640)` after the write so a rewrite of an existing record still
  lands `0640`.
- `packages/seat/src/launcher.ts`: on Linux static-auth, `launchSeat` stops
  `mkdirSync`ing `opts.root` and `dirname(recPath)`, stops writing `launch.json`, and
  stops `spawn`ing the custodian. It sends the launch request to the
  `cotal-seat-launch` socket and polls `readRecord(recPath)` as it does today. The
  `custodian.log` read on an early exit moves to the helper, which is root and can read
  that `0600` agent-owned file; the manager receives the message in the launch reply.

Seat records and `seat.sock` are written by the custodian as `cotal-agent`, under a
directory the helper created with the setgid bit, so they carry group `cotal-manager`
without the custodian ever holding that group. The agent still cannot open the signer
seed or the signer socket.

Optional mount namespace (operator hardening, not required for the proof in §5): the signer
unit uses a private mount for the seed directory. The manager's namespace has only the socket
bind-mounted in. An agent with a stolen manager uid still cannot `open` the seed path because
it is not mounted there. The Unix socket plus `SO_PEERCRED` remain the mandatory gate.

### 3.4 How the manager reaches it

Copy the seat pattern, do not invent a new one:

1. Directory created `0750`, socket bound, mode set after listen (`runCustodian`).
2. Truncation check against the requested path (`runCustodian`'s `listening.address()` guard).
3. Every frame: `peerCredentials(sock)` then capability token (`custodian.ts` `handle`).
4. Length-prefixed JSON frames (`packages/seat/src/protocol.ts`), two ops (`sign-user`, `mac`).

The manager is configured with the socket path (unit env or `cotal.yaml` / supervise flag). It
dials at `runStart` **before** `getSpaceAuth` is allowed to succeed with a signing seed. A
composed read used by the manager, `remintDaemonCreds`, and `cotal mint` must yield
`account.signingSeed === ""` (or omit it). `mintCreds` takes a `signUser` function from that
dial, not `fromSeed`. `remoteManagerCurrentRegistrationProof` takes a `mac` function from the
same dial, not `createHmac` over a local seed. `runAuthService` refuses a `service-keys.json`
whose `dataAccount.signingSeed` is non-empty; after isolation that projection is `pub` plus
`signingPub`.

`getSpaceAuth` staying able to return a seed is the residual that would make isolation optional
in process memory. The manager's start therefore **refuses** a store value whose account record
still contains a non-empty `signingSeed`. The signer process is the only reader of the seed
file. The workstation store's account record becomes the public half (`pub`, `jwt`,
`signingPub`). That split is the migration in §6.

### 3.5 Absent service

No fallback to in-process signing. Named refusals:

- Socket path missing or not a socket: throw, name the path, name the unit to start.
- Dial timeout / peer uid mismatch / token mismatch: throw, do not call `fromSeed` or `createHmac`.
- `getSpaceAuth` / `loadSpaceAuth` for a signer client returns a non-empty `signingSeed`: throw,
  name the key, tell the operator to finish §6 (the seed is still readable by this uid).
- `loadServiceKeys` returns a non-empty `dataAccount.signingSeed`: throw, same class of error.
  The auth service is a signer client; it does not keep a local HMAC secret.
- Linux-only native `SO_PEERCRED` helper missing: throw, same class of error as
  `peerCredentials` when the helper is absent.
- Non-Linux: throw at manager start for any mesh that would have loaded `SpaceAuth`. Open-mode
  meshes have no signer and are unchanged.
- Seat-launch socket missing, peer not the helper, or helper not privileged: throw at start
  and at spawn. No in-process `pty.spawn` fallback on Linux static-auth.
- Dropped custodian still writes `record.json` `0600` or `seat.sock` `0600`, or
  still requires peer uid `=== process.getuid()`: throw at spawn.
  `cotal-manager` cannot poll or adopt. No helper-only chmod fallback.
- Per-seat directory missing the set-group-id bit, or not in the
  `cotal-manager` group, when the custodian asserts it after the drop: throw
  before the PTY is spawned. Without that bit every leaf takes the custodian's
  own gid and the manager is locked out of a seat that otherwise looks live.
- `cotal-agent` is a member of the `cotal-manager` group: the helper throws
  before it creates anything. That membership would give the agent uid the
  signer socket and the capability-token file.

`SecretStore` adapters that export the seed into the manager process do not satisfy this
design. A KMS that signs without export is a different implementation of the same
`sign-user` seam, not a second fallback.

`remintDaemonCreds` today returns per-file skips and never throws (`renewal.ts`). That
contract is not a fallback here: when isolation is on, a missing socket or a non-empty
`signingSeed` in the caller is a hard failure, and `mintCreds` itself refuses `fromSeed`
in a signer-client process. User-mode meshes still self-mint the supervisor cred from this
seed (`runStart`); they take the same socket.

---

## 4. Rotation after the split

### 4.1 Revoking minted users

Unchanged. SPEC 13.9 is the broker ceiling on what a user JWT may do; SPEC 13.1 is issuance,
retirement, and eviction. Isolation does not add a subject. A stolen **user** cred is still
retired on the ledger and kicked. A stolen **seed** is §4.2.

### 4.2 Rotating the data-account signing key

`rotateDataAccountSigningKey` (`provision.ts`) requires `auth.operator.seed` and
`auth.account.seed`. A stripped signer cannot rotate (`throw` in that function). The user-JWT
signer must not gain those seeds.

Rotation is an operator procedure, not a manager RPC:

1. Stop new `sign-user` (signer drain) so no JWT is issued under a key about to be retired.
2. On an operator-only path (tty or a second socket bound `0600` to the operator uid, not the
   manager group), run the existing `rotateDataAccountSigningKey` in a short-lived process that
   already holds operator/account seeds (today: `cotal` as the operator). That process writes
   the new account JWT into the broker trust records the manager may read, and writes **only**
   the new `signingSeed` into the signer-only file.
3. Restart the signer (or a replace-seed command on the operator socket). The manager-facing
   socket still has no export.
4. Reload the broker with the new account JWT (`signing_keys` now the new public key). The old
   signer is no longer trusted.
5. Remint standing creds through the socket: supervisor, delivery, membership-rw
   (`remintDaemonCreds`), live managed-static agents (`renewManagedStaticCred` cannot keep the
   old JWT; this is a new signing key, so it is re-issue, not the SPEC 13.15 same-generation
   renewal). Agents whose creds were not re-issued die at the broker.

Crash between 3 and 4: the signer holds a seed the broker does not yet list. Minted JWTs fail
preflight. `remintDaemonCreds` already refuses to overwrite last-good creds with an unproven
JWT. Crash between 4 and 5: live creds are broker-dead until remint; that is the same window
as today's rotation.

### 4.3 System-account rotation

`rotateSystemCreds` stays FS-and-operator-seed as it is today (`system-rotation.ts`). It does
not talk to the user-JWT signer.

### 4.4 Manager compromise after isolation

Kill the manager. Rotate (§4.2). The attacker had mint-while-connected, not a copy of the seed.
JWTs they minted remain valid until expiry or eviction; standing ones are re-issued under the
new key or they die.

---

## 5. The proof

Operator procedure on Linux. Substitute the workspace root, the space name, and the isolated
uids from §6. Do not print file contents: a successful steal would be a JWT or a seed, and
either one is a failed proof.

Do not print process argument vectors. Command lines on a shared host are a publication
surface (a runtime can pass a persona as an argv token). This procedure therefore never uses
`ps -o cmd`, `ps -f`, `ps -ef`, `pgrep`, `pgrep -f`, `pgrep -u`, or `/proc/<pid>/cmdline`.
Identify a process by uid, `comm`, unit metadata, a seat `record.json`, or a single named
environment key.

Positive control uses `cotal mint` (or a managed spawn) as the authorized client. The negative
arms run as the agent uid, which is the child's uid after the spawn drop.

1. Confirm the three system units. Isolation is not a linger `--user` layout (that cannot
   change uid; §3.3). Prefer the unit, which already names the User:

   ```bash
   systemctl show cotal-signer@<space>     -p User -p ExecMainPID
   systemctl show cotal-manager@<space>    -p User -p ExecMainPID
   systemctl show cotal-seat-launch        -p User -p ExecMainPID
   # User=cotal-signer, User=cotal-manager, and User=root (or the dedicated setuid helper
   # user). Do not pass -p Environment (it dumps every variable).
   ```

   If the units are not installed yet, list by comm and uid only, then read one env key:

   ```bash
   ps -o user,pid,comm -C node
   # then, for each pid whose USER is cotal-signer or cotal-manager:
   tr '\0' '\n' < /proc/<pid>/environ | grep -E '^COTAL_NAME='
   # print only that key. Do not dump the rest of environ (tokens live there).
   ```

2. Confirm the seed file is not readable by the manager uid or the agent uid.
   Assign the seed path once; later steps reuse it, they do not invent a new one:

   ```bash
   SPACE=<space>
   SEED=/var/lib/cotal/signer/$SPACE/signing.seed
   sudo -u cotal-manager test -r "$SEED"; echo $?
   sudo -u cotal-agent   test -r "$SEED"; echo $?
   # both must print 1
   sudo -u cotal-signer  test -r "$SEED"; echo $?
   # must print 0
   ```

3. Confirm the manager's composed store view has no signing seed (the start refusal in §3.5).
   As `cotal-manager`, a store read of `auth/account.<hex>.json` must not contain a
   `signingSeed` field with length greater than zero. Do not dump the file; query existence
   only. Assign the workspace root and the account-record path before python runs:

   ```bash
   ROOT=/home/cotal-manager
   ACCOUNT_RECORD="$ROOT/.cotal/auth/account.<hex>.json"
   sudo -u cotal-manager python3 -c \
     'import json,sys
p=sys.argv[1]
try:
    d=json.load(open(p))
except (OSError, json.JSONDecodeError) as e:
    sys.stderr.write("UNREADABLE\n")
    raise SystemExit(2)
seed=d.get("account",{}).get("signingSeed","")
if seed:
    sys.stderr.write("LEAK\n")
    raise SystemExit(3)
raise SystemExit(0)' \
     "$ACCOUNT_RECORD"; echo $?
   # must print 0. 2 means this uid could not open the record. 3 means the record still
   # carries a signingSeed: stop, finish §6, rotate if that copy was ever readable by
   # another uid.
   ```

4. Positive control: mint still works through the socket.

   ```bash
   umask 077
   sudo -u cotal-manager mkdir -p /home/cotal-manager/cotal-proof
   sudo -u cotal-manager cotal mint proof-agent --profile agent --out /home/cotal-manager/cotal-proof/proof-agent.creds >/dev/null
   echo $?
   # must print 0. Judge only the exit status; do not copy stdout (it names the new
   # principal) into a log or channel. Do not write the creds file under /tmp.
   ```

5. Negative control: the managed agent child cannot read the seed. Spawn one named agent
   whose seat `name` is unique on this host (example name `proof`). Do not pick a pid by uid
   or recency. The manager records the seat id on the static slot (`recordSlotCustody` in
   `manager.ts`); the custodian writes `record.json` (`writeRecord` in
   `packages/seat/src/record.ts`) with `name`, `childPid`, and `childStart`. After
   isolation the shipped custody root is `/var/lib/cotal/seats` (§3.3), not
   `$HOME/.cotal/seats` (`defaultCustodyRoot` in `custodial-pty.ts` today).
   `COTAL_SEAT_ROOT` may name another agent-traversable root. Pin the child
   by walking those records for that name and matching `childStart`, then enter *its*
   mount namespace:

   ```bash
   SEAT_ROOT=/var/lib/cotal/seats
   AGENT_NAME=proof
   AGENT_UID=$(id -u cotal-agent)
   pid=$(sudo -u cotal-manager python3 -c '
   import json, pathlib, sys
   root, name, expect_uid = sys.argv[1], sys.argv[2], sys.argv[3]
   hits = []
   for rec_path in pathlib.Path(root).glob("*/record.json"):
     rec = json.loads(rec_path.read_text())
     if rec.get("name") != name: continue
     pid = rec.get("childPid")
     start = rec.get("childStart")
     if not isinstance(pid, int) or pid <= 0: sys.exit("no childPid")
     if not start: sys.exit("no childStart")
     stat = pathlib.Path("/proc/%d/stat" % pid).read_text()
     token = stat[stat.rindex(") ")+2:].split(" ")[19]
     if token != start: sys.exit("pid reused")
     uid = pathlib.Path("/proc/%d/status" % pid).read_text()
     real = [ln for ln in uid.splitlines() if ln.startswith("Uid:")][0].split()[1]
     if real != expect_uid: sys.exit("not cotal-agent")
     hits.append(pid)
   if len(hits) != 1: sys.exit("need one live seat named %s, got %d" % (name, len(hits)))
   print(hits[0])
   ' "$SEAT_ROOT" "$AGENT_NAME" "$AGENT_UID")
   ```

   `SEAT_ROOT`, `AGENT_NAME`, and `AGENT_UID` are assigned on their own lines, then passed
   as `sys.argv`. Capture only the printed pid. Do not print the record, the start token,
   or `/proc/<pid>/environ`. Then:

   ```bash
   sudo nsenter -t "$pid" -m -- sudo -u cotal-agent test -r "$SEED"; echo $?
   # must print 1
   ```

   The account-record check is a second failed open of a path the parent already resolved.
   Pass that path as an argument to python, never as a shell assignment that another
   command later expands. Each arm writes a distinct sentinel on stderr and a distinct
   exit status, so a readable leaked seed cannot be mistaken for a failed open:

   ```bash
   sudo nsenter -t "$pid" -m -- sudo -u cotal-agent python3 -c \
     'import json,sys
p=sys.argv[1]
try:
    d=json.load(open(p))
except OSError:
    sys.stderr.write("DENY\n")
    raise SystemExit(1)
except json.JSONDecodeError:
    sys.stderr.write("UNPARSEABLE\n")
    raise SystemExit(2)
seed=d.get("account",{}).get("signingSeed","")
if seed:
    sys.stderr.write("LEAK\n")
    raise SystemExit(3)
sys.stderr.write("EMPTY\n")
raise SystemExit(0)' \
     "$ACCOUNT_RECORD"; echo $?
   # DENY / 1 is the pass: the agent uid cannot open the manager-owned record.
   # EMPTY / 0 means the record was readable but signingSeed was empty (migration
   # happened; isolation of this file is still incomplete). LEAK / 3 is a stolen
   # seed: stop, rotate (§4.2). UNPARSEABLE / 2 is a broken record, not a pass.
   ```

6. Negative control: the agent child cannot dial the signer.

   ```bash
   SIGNER_SOCK=/var/run/cotal/signer/$SPACE.sock
   sudo -u cotal-agent python3 -c \
     'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])' \
     "$SIGNER_SOCK"; echo $?
   # must be non-zero (EACCES). If connect succeeded, the proof has failed even before peercred.
   ```

7. The adopt path, as the modes on disk. Run this as the manager uid while the seat from
   step 5 is live. It checks the whole chain of §3.3 rather than one inode.

   ```bash
   stat -c '%n %a %U:%G' /var/lib/cotal /var/lib/cotal/seats
   # /var/lib/cotal       711  root:root
   # /var/lib/cotal/seats 2771 root:cotal-manager
   SEAT_DIR=$(sudo -u cotal-manager dirname "$(sudo -u cotal-manager \
     grep -rl "\"name\":\"$AGENT_NAME\"" /var/lib/cotal/seats/*/record.json)")
   stat -c '%n %a %U:%G' "$SEAT_DIR" "$SEAT_DIR/record.json" "$SEAT_DIR/seat.sock"
   # <dir>             2770 cotal-agent:cotal-manager
   # <dir>/record.json  640 cotal-agent:cotal-manager
   # <dir>/seat.sock    660 cotal-agent:cotal-manager
   ```

   A group of `cotal-agent` on either leaf is the failure the set-group-id bit exists to
   prevent: the seat looks live and the manager cannot reach it. Then show the two
   accesses of hops 7 and 8, without printing either payload (`record.json` carries the
   seat capability token):

   ```bash
   sudo -u cotal-manager test -r "$SEAT_DIR/record.json"; echo $?
   # must print 0
   sudo -u cotal-manager python3 -c \
     'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()' \
     "$SEAT_DIR/seat.sock"; echo $?
   # must print 0: connect(2) needs the group write bit, which 0660 gives
   id -nG cotal-agent
   # must not list cotal-manager
   ```

   The agent uid owns `seat.sock` and can therefore `connect` to it. That is expected and
   is not a finding: `handle` in `runCustodian` reads `SO_PEERCRED` on the first frame and
   destroys any peer that is not `launch.adopterUid` (§3.3). What the agent uid must not
   reach is the signer, which is step 6.

8. Repeat step 4 after steps 5 to 7 to show mint still works.

A proof that skips step 4, or that runs steps 5 and 6 as `cotal-manager`, proves nothing. A
proof that prints a seed or a JWT has leaked; destroy that output, rotate (§4.2), re-run.

---

## 6. Migration

Existing self-hoster, one space, workstation store. Several spaces: one signer unit per space,
same steps.

### 6.1 What the operator does

1. Create uids `cotal-signer`, `cotal-manager`, `cotal-agent` and group `cotal-manager`.
   The operator user that currently runs `cotal up` is typically added to `cotal-manager` for
   CLI mint. Give each of the three uids its own primary group and add none of them to
   another's. `cotal-agent` must not be in `cotal-manager`: that group reads the signer
   capability-token file and connects to the signer socket. The seat-launch helper asserts
   this before it creates a directory (§3.3) and throws if it does not hold.
2. Install the signer unit. Create `/var/lib/cotal` first as `0711` `root:root` (the
   traverse spine in §3.3; do not leave this parent `0700`). Seed directory
   `/var/lib/cotal/signer/<space>/` mode `0700` owner `cotal-signer`; socket
   `/var/run/cotal/signer/<space>.sock`; token file
   `/etc/cotal/signer/<space>.token` mode `0640` `cotal-signer:cotal-manager`. The
   signer leaf stays `0700`; only the parent is traversable.
3. Copy `account.signingSeed` from the current account record into
   `/var/lib/cotal/signer/<space>/signing.seed` as `cotal-signer` mode `0600`. Do not leave a
   second copy in the journal, in a backup that the manager uid can read, or in the shell
   history.
4. Rewrite the account record (and any `auth/auth.json` stripped bundle) so `signingSeed` is
   empty. Keep `pub` / `jwt` / `signingPub`. Rewrite `service-keys.json` the same way:
   `loadServiceKeys` today requires a non-empty `dataAccount.signingSeed` (`store.ts`); the
   implementation of this design must persist `pub` / `signingPub` without the seed, or
   `runAuthService` refuses. `putSpaceAuth` today writes `account` whole (`auth-paths.ts`);
   the implementation of this design must persist the public half without the seed.
5. Install `cotal-seat-launch.service` (§3.3). Create `/var/lib/cotal` `0711` `root:root`
   and `/var/lib/cotal/seats` `2771` `root:cotal-manager` (install must make both; the
   helper asserts them and never widens a mode it did not create). The set-group-id bit
   on the custody root is load-bearing, not cosmetic: it is what puts group
   `cotal-manager` on each per-seat directory the helper creates inside it, and the same
   bit on that per-seat directory is what puts the group on `record.json` and
   `seat.sock`. Verify it with `stat -c '%a %U:%G' /var/lib/cotal/seats`, which must
   print `2771 root:cotal-manager`. Run the manager as `cotal-manager`, the signer as
   `cotal-signer`. Point the manager at the signer socket and the seat-launch socket. Do
   not set `COTAL_SEAT_ROOT` to `$HOME/.cotal/seats`: that ancestor is `0700`
   `cotal-manager` (`mkSecretDir`) and the helper refuses it. Agents are `cotal-agent`
   only because that helper creates the per-seat directory `2770`
   `cotal-agent:cotal-manager`, then `setuid`s before `exec` of the custodian. The
   dropped custodian, not the helper, then writes `record.json` `0640` and `seat.sock`
   `0660`, both in group `cotal-manager` by inheritance from that bit, so the manager
   can poll and adopt while the custodian holds only its own group. The manager never
   drops uid itself and never `mkdir`s a `0700` seats tree under `~/.cotal`.
6. `cotal mint`, `cotal doctor auth --fix`, and `remintDaemonCreds` use the same signer
   socket. They run as a uid on the signer allowlist.

### 6.2 What refuses if they do not

| If the operator skips | What throws |
|---|---|
| No signer unit / no socket | `runStart`, `cotal mint`, `remintDaemonCreds`: socket absent, named path, named unit |
| Socket up, seed still in the account record | `runStart` / `getSpaceAuth` for signer clients: non-empty `signingSeed` in this process |
| Socket up, seed still in `service-keys.json` | `runAuthService` / `loadServiceKeys`: non-empty `dataAccount.signingSeed` in this process |
| Socket up, HMAC still computed in `openAuthAuthorityPlane` | start refuses: `createHmac` over a local seed is the leftover the `mac` op exists to replace |
| Socket up, seed file still `0600` as the old operator uid | isolation is not on; start refuses if that uid is the manager uid |
| No `cotal-seat-launch` socket / helper not privileged | start refuses: cannot drop to `cotal-agent` |
| Helper drops uid without creating the per-seat directory as `cotal-agent` | spawn never becomes ready: `runCustodian` cannot write `seat.sock` under a `0700` manager-owned root (`custodial-pty.ts` constructor, `launchSeat`, `writeRecord`) |
| Custody root or per-seat directory created without the set-group-id bit | spawn refuses at the custodian's directory assertion; without it the leaves take the custodian's own gid and the manager fails the group class on both |
| Helper chmods only the per-seat directory after ready, leaving shipped `0600` leaves | start / spawn refuse: `cotal-manager` cannot `readRecord` or `connect` `seat.sock` (`writeRecord` `0600`, `runCustodian` `chmodSync(socket, 0o600)`). The custodian must write `0640` and `0660` under a `2770` directory |
| Dropped custodian still requires peer uid `=== process.getuid()` | spawn / adopt refuse: `handle` in `runCustodian` destroys a distinct `cotal-manager` with "peer uid mismatch". The check must compare against `launch.adopterUid` |
| `cotal-agent` added to the `cotal-manager` group to make the leaves readable | helper refuses at spawn: that group reaches the signer socket and the capability-token file. The set-group-id bit is the supported mechanism |
| Custody root still `$HOME/.cotal/seats`, or any ancestor `0700` `cotal-manager` | helper refuses before `setuid`: `cotal-agent` cannot traverse `mkSecretDir`'s `0700` `~/.cotal`; `writeRecord` never appears and `launchSeat`'s poll throws |
| Agents still spawned as `cotal-manager` | start refuses: spawn uid is not `cotal-agent` |
| `cotal mint --signer` used as a mount of the seed into the manager | refused; that command's purpose (strip operator, keep signing seed) is the old co-location |
| Non-Linux host | static-auth manager start refuses |

`cotal mint --signer` as a way to hand a container the seed is replaced by handing it the
socket (or a KMS `sign-user`). A stripped bundle that still contains `signingSeed` is a failed
migration, not an alternate mode.

### 6.3 What does not change

SPEC 13.9, profiles, issuance fences, delivery, the attach HTTP face, seat custody of PTYs.
`SecretStore` still stores standing **user** creds and daemon creds. It no longer stores the
account signing seed on a path the manager can `get`.

---

## 7. Residuals

1. **Mint-while-compromised.** A live manager that can dial the socket can still issue JWTs.
   Isolation is seed-theft resistance plus agent-uid confinement, not an HSM policy engine
   inside the signer. Narrowing which profiles the signer will encode is a later policy, not
   required to close the gap `docs/embedding.md` names.
2. **Operator/account seeds.** Still on the operator path for rotation and for
   `createBrokerAuth` / `createSpaceAccountAuth`. A host that also wants those off the manager
   disk already has that as a separate custody problem.
3. **Same-group Unix clients.** Any uid in `cotal-manager` that can read the token file is an
   authorized mint client. Keep that group small.
4. **Backups.** A backup of `/var/lib/cotal/signer` is the seed. Treat it like today's
   `auth/account.<hex>.json`. A backup of `.cotal/auth` after migration must not still contain
   the seed; restore tests should run step 3 of §5.
5. **Windows / macOS.** No isolation in this design. Refuse rather than ship a same-uid
   manager that believes it is isolated.
