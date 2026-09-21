# Signer isolation

> **Design** (non-normative, not shipped) · Closes [embedding](../embedding.md) remaining gap
> ("The remaining hosted gap is signer isolation"). Wire contract unchanged: no new subject, no new
> stream, no new message type. This is a composition-root and OS-custody seam.

**Status:** design. Nothing here is implemented. Review gate: this doc is approved before any code
lands.

**Citations.** Every `file` / function below was read in this worktree at `b4b534b07`. No seed, key,
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

Manager call sites that pass `this.auth` (or the `runStart` closure) into `mintCreds` today:

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

`remintDaemonCreds` (`packages/workspace/src/renewal.ts`) is the other standing signer user: it
calls `getSpaceAuth` on the same store, then `mintCreds` for the `delivery` and `membership-rw`
profiles. The manager invokes it from `runStart`'s renewal path. `cotal doctor auth --fix` is the
offline caller.

CLI `mint` (`implementations/cli/src/commands/mint.ts`) loads via `getSpaceAuth` /
`getSoleSpaceAuth` and calls `mintCreds` or `provisionForMint`. It is an out-of-band signer
client, not a child of the manager.

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
operator uid that started `cotal up`.

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

A dedicated signer process holds `account.signingSeed`. The manager and `cotal mint` /
`remintDaemonCreds` never observe the seed. They send already-built user-JWT claims over a
permissioned Unix socket and receive a signed JWT. If the socket is absent, or if a composed
`SpaceAuth` still carries a non-empty `signingSeed` in the caller's process, the caller throws.
There is no in-process `fromSeed` fallback.

Linux is the production path, matching `@cotal-ai/seat`. Other platforms refuse a static-auth
manager start with a named error rather than signing in-process.

### 3.1 Smallest interface

`mintCreds` and `mintPublicUserJwt` need the seed for one call: `encodeUser`. Permission rows,
lifetimes, issuance fences, and creds wrapping stay in the caller. The signer does not implement
`permissionsFor`, SPEC 13.9, or the issuance ledger.

One request:

```
sign-user
  name:        JWT name (the profile label mintCreds already passes to encodeUser)
  userPub:     user nkey public id
  accountPub:  data-account public id
  claims:      the object mintCreds already passes as perms + principalTags
  iat, exp:    the valid dates userValidDates already computed
```

One reply: the signed user JWT string. The caller still runs `fmtCreds` / issuance release.

The signer holds the seed for **one** space account. A host with several spaces runs one signer
process per space (or one process with several private seeds, still no export).

### 3.2 What it refuses

The signer never returns the seed, never logs it, and never writes it to a path the manager uid
can read.

It refuses, loud:

- Peer uid not in the allowlist (`SO_PEERCRED`, same helper as `peerCredentials` in
  `packages/seat/src/peercred.ts`).
- Missing or mismatched capability token (same shape as `runCustodian`'s `hello`).
- `accountPub` other than the held account.
- A claims object that is not a NATS user-JWT body (no operator/account JWT encoding, no
  arbitrary byte sign).
- `sign-user` after the process has been asked to stop holding the seed (rotation drain).
- Any export / dump / rotate-seed op on the **manager-facing** socket. Rotation is §4.

A compromised manager can still mint for as long as it can open the socket. That is the
authorized client. It cannot take the seed with it.

### 3.3 Uid split

Three uids, one group:

| Uid | What it can open |
|---|---|
| `cotal-signer` | the seed file (`0600`), the socket (owner) |
| `cotal-manager` | the socket (group), the capability-token file (`0640` signer:manager-group), the rest of the workspace |
| `cotal-agent` | the agent's own launch material and creds file, not the seed, not the token file, not the socket |

Suggested group: `cotal-manager`. The signer user owns the seed directory `0700`. The socket
directory is `0750` `cotal-signer:cotal-manager`. The socket is `0660` after bind (the seat
pattern is `chmodSync(path, 0o600)` in `runCustodian`; here the group must be able to connect,
so `0660`, then `SO_PEERCRED` allowlist).

Agent spawn gains an explicit uid/gid on the Linux pty path (`CustodialPtyRuntime` /
`runCustodian`'s `pty.spawn`). Absent that drop, isolation is not on. The manager throws at
start rather than supervising same-uid children against a locked seed.

Optional mount namespace (operator hardening, not required for the proof in §5): the signer
unit uses a private mount for the seed directory. The manager's namespace has only the socket
bind-mounted in. An agent with a stolen manager uid still cannot `open` the seed path because
it is not mounted there. The Unix socket plus `SO_PEERCRED` remain the mandatory gate.

### 3.4 How the manager reaches it

Copy the seat pattern, do not invent a new one:

1. Directory created `0750`, socket bound, mode set after listen (`runCustodian`).
2. Truncation check against the requested path (`runCustodian`'s `listening.address()` guard).
3. Every frame: `peerCredentials(sock)` then capability token (`custodian.ts` `handle`).
4. Length-prefixed JSON frames (`packages/seat/src/protocol.ts`), one op.

The manager is configured with the socket path (unit env or `cotal.yaml` / supervise flag). It
dials at `runStart` **before** `getSpaceAuth` is allowed to succeed with a signing seed. A
composed read used by the manager, `remintDaemonCreds`, and `cotal mint` must yield
`account.signingSeed === ""` (or omit it). `mintCreds` takes a `signUser` function from that
dial, not `fromSeed`.

`getSpaceAuth` staying able to return a seed is the residual that would make isolation optional
in process memory. The manager's start therefore **refuses** a store value whose account record
still contains a non-empty `signingSeed`. The signer process is the only reader of the seed
file. The workstation store's account record becomes the public half (`pub`, `jwt`,
`signingPub`). That split is the migration in §6.

### 3.5 Absent service

No fallback to in-process signing. Named refusals:

- Socket path missing or not a socket: throw, name the path, name the unit to start.
- Dial timeout / peer uid mismatch / token mismatch: throw, do not call `fromSeed`.
- `getSpaceAuth` / `loadSpaceAuth` for a signer client returns a non-empty `signingSeed`: throw,
  name the key, tell the operator to finish §6 (the seed is still readable by this uid).
- Linux-only native `SO_PEERCRED` helper missing: throw, same class of error as
  `peerCredentials` when the helper is absent.
- Non-Linux: throw at manager start for any mesh that would have loaded `SpaceAuth`. Open-mode
  meshes have no signer and are unchanged.

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
`ps -o cmd`, `ps -f`, `ps -ef`, `pgrep -f`, or `/proc/<pid>/cmdline`. Identify a process by
uid, `comm`, unit metadata, or a single named environment key.

Positive control uses `cotal mint` (or a managed spawn) as the authorized client. The negative
arms run as the agent uid, which is the child's uid after the spawn drop.

1. Confirm the manager is running under the manager uid and the signer unit is running under
   the signer uid. Prefer the unit, which already names the User:

   ```bash
   systemctl show cotal-signer@<space>  -p User -p ExecMainPID
   systemctl show cotal-manager@<space> -p User -p ExecMainPID
   # User=cotal-signer and User=cotal-manager. Do not pass -p Environment (it dumps every
   # variable). Three-uid isolation is system units. If this host instead runs linger user
   # units, the same two properties are:
   systemctl --user show cotal-signer@<space>  -p User -p ExecMainPID
   systemctl --user show cotal-manager@<space> -p User -p ExecMainPID
   ```

   If the units are not installed yet, list by comm and uid only, then read one env key:

   ```bash
   ps -o user,pid,comm -C node
   # then, for each pid whose USER is cotal-signer or cotal-manager:
   tr '\0' '\n' < /proc/<pid>/environ | grep -E '^COTAL_NAME='
   # print only that key. Do not dump the rest of environ (tokens live there).
   ```

2. Confirm the seed file is not readable by the manager uid or the agent uid:

   ```bash
   sudo -u cotal-manager test -r /var/lib/cotal/signer/<space>/signing.seed; echo $?
   sudo -u cotal-agent   test -r /var/lib/cotal/signer/<space>/signing.seed; echo $?
   # both must print 1
   sudo -u cotal-signer  test -r /var/lib/cotal/signer/<space>/signing.seed; echo $?
   # must print 0
   ```

3. Confirm the manager's composed store view has no signing seed (the start refusal in §3.5).
   As `cotal-manager`, a store read of `auth/account.<hex>.json` must not contain a
   `signingSeed` field with length greater than zero. Do not dump the file; query existence
   only:

   ```bash
   ACCOUNT_RECORD="$ROOT/.cotal/auth/account.<hex>.json" \
   sudo -u cotal-manager --preserve-env=ACCOUNT_RECORD python3 -c \
     'import json,os; d=json.load(open(os.environ["ACCOUNT_RECORD"])); raise SystemExit(1 if d.get("account",{}).get("signingSeed","") else 0)'; echo $?
   # must print 0 (non-zero means the record still carries a signingSeed)
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

5. Negative control: the agent child cannot read the seed. Spawn any managed agent, then:

   ```bash
   pid=$(pgrep -u cotal-agent -n)
   sudo nsenter -t "$pid" -m -- sudo -u cotal-agent test -r /var/lib/cotal/signer/<space>/signing.seed; echo $?
   # must print 1
   ACCOUNT_RECORD="$ROOT/.cotal/auth/account.<hex>.json" \
   sudo nsenter -t "$pid" -m -- env ACCOUNT_RECORD="$ACCOUNT_RECORD" sudo -u cotal-agent --preserve-env=ACCOUNT_RECORD python3 -c \
     'import json,os; d=json.load(open(os.environ["ACCOUNT_RECORD"])); print("empty" if not d.get("account",{}).get("signingSeed","") else "LEAK")'
   # must print empty, never LEAK
   ```

6. Negative control: the agent child cannot dial the signer.

   ```bash
   SIGNER_SOCK=/var/run/cotal/signer/<space>.sock \
   sudo -u cotal-agent --preserve-env=SIGNER_SOCK python3 -c \
     'import os,socket; s=socket.socket(socket.AF_UNIX); s.connect(os.environ["SIGNER_SOCK"])'; echo $?
   # must be non-zero (EACCES). If connect succeeded, the proof has failed even before peercred.
   ```

7. Repeat step 4 after steps 5–6 to show mint still works.

A proof that skips step 4, or that runs steps 5–6 as `cotal-manager`, proves nothing. A proof
that prints a seed or a JWT has leaked; destroy that output, rotate (§4.2), re-run.

---

## 6. Migration

Existing self-hoster, one space, workstation store. Several spaces: one signer unit per space,
same steps.

### 6.1 What the operator does

1. Create uids `cotal-signer`, `cotal-manager`, `cotal-agent` and group `cotal-manager`.
   The operator user that currently runs `cotal up` is typically added to `cotal-manager` for
   CLI mint.
2. Install the signer unit: seed directory `/var/lib/cotal/signer/<space>/` mode `0700` owner
   `cotal-signer`; socket `/var/run/cotal/signer/<space>.sock`; token file
   `/etc/cotal/signer/<space>.token` mode `0640` `cotal-signer:cotal-manager`.
3. Copy `account.signingSeed` from the current account record into
   `/var/lib/cotal/signer/<space>/signing.seed` as `cotal-signer` mode `0600`. Do not leave a
   second copy in the journal, in a backup that the manager uid can read, or in the shell
   history.
4. Rewrite the account record (and any `auth/auth.json` stripped bundle) so `signingSeed` is
   empty. Keep `pub` / `jwt` / `signingPub`. `putSpaceAuth` today writes `account` whole
   (`auth-paths.ts`); the implementation of this design must persist the public half without
   the seed.
5. Run the manager as `cotal-manager`, agents as `cotal-agent` (pty spawn uid drop), signer as
   `cotal-signer`. Point the manager at the socket.
6. `cotal mint`, `cotal doctor auth --fix`, and `remintDaemonCreds` use the same socket. They
   run as a uid on the allowlist.

### 6.2 What refuses if they do not

| If the operator skips | What throws |
|---|---|
| No signer unit / no socket | `runStart`, `cotal mint`, `remintDaemonCreds`: socket absent, named path, named unit |
| Socket up, seed still in the account record | `runStart` / `getSpaceAuth` for signer clients: non-empty `signingSeed` in this process |
| Socket up, seed file still `0600` as the old operator uid | isolation is not on; start refuses if that uid is the manager uid |
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
