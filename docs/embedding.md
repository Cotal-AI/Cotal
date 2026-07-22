# Embedding Cotal: build a host on the published packages

> **Guide** (informative) · **For:** implementers building a service on top of Cotal · **Prereqs:** [Architecture](architecture.md), [Identity and auth](identity-and-auth.md), [Delivery daemon](delivery-daemon.md)

The `cotal` binary in this repo is one composition root: an operator CLI. A separate service
(for example a hosted, multi-tenant Cotal) does not fork this repo. It writes its **own**
composition root that depends on the published `@cotal-ai/*` packages and imports the surfaces it
wants, exactly as `bin/cotal.ts` does. This page is the contract for that: what is a real library
export you can build against, how to boot the server-side daemons from those exports, and where the
current export surface stops short of a fully hosted composition.

This is the "guarded substrate" boundary in practice. Nothing here reveals or assumes a specific
host; it documents the public seams any embedder composes.

## What you embed

The supported reference shape here is **one broker operator serving one space** (one tenant: a
dedicated data account, under an operator that also holds the system account and a quarantined
auth-callout account) plus three standalone processes. Running many spaces under one shared broker
operator is a different, not-yet-composable shape (see
[Known gaps](#known-gaps-not-hosted-composable-yet)). The three processes:

| daemon | package | what it is |
|---|---|---|
| auth-service | `@cotal-ai/auth` | the NATS auth callout, the IdP token exchange, and JWKS. Plane 1 to Plane 2. |
| delivery | `@cotal-ai/delivery` | the Plane-3 durable backstop: fan-out writer plus trusted reader, per space. |
| supervise | `@cotal-ai/manager` | the per-machine agent lifecycle (spawn/despawn/attach), per space. |

`mint`, `deliver`, and `auth-service` expose their behavior as direct library primitives, and the
supported one-space bootstrap below re-composes from exported low-level primitives. `supervise` and
the full `up` orchestration are **not** public runners: `up` also does broker bring-up, restore,
process and registry management, and lifecycle work, and `supervise`'s orchestration is private (see
[The supervisor is a signer, not a scoped daemon](#the-supervisor-is-a-signer-not-a-scoped-daemon)).

## The export surface

Everything below is a real export of a published package, reachable from the package root (each
package publishes only `.` via `dist/index.{js,d.ts}` and ships `files: ["dist"]`). Type-only names
are marked; import them with `import type`.

**Daemon runners and lifecycle**

| symbol | package | purpose |
|---|---|---|
| `runAuthService(args, store?)` | `@cotal-ai/auth` | boot the auth-service daemon; `store` injects the secret material. |
| `runDelivery(args, store?)` | `@cotal-ai/delivery` | boot the delivery daemon; `store` injects the scoped `delivery` cred. |
| `DELIVERY_CREDS_KEY`, `MEMBERSHIP_RW_CREDS_KEY` | `@cotal-ai/workspace` | the secret-store keys the delivery cred and the membership feed's rw cred are read/re-signed under. |
| `Manager`, `ManagerOptions` *(type)* | `@cotal-ai/manager` | construct and run a supervisor in-process; `ManagerOptions.secretStore` injects the one store it reads/writes every secret through. |
| `createRuntime`, `Runtime` *(type)* | `@cotal-ai/manager` | resolve the spawn backend (pty built in). |

**Provisioning and minting** (all `@cotal-ai/core`)

| symbol | purpose |
|---|---|
| `createSpaceAuth(space)` | mint a space's trust bundle (operator + system + data accounts). One space, one operator. |
| `setupSpaceStreams({ servers, space, creds })` | create the space's JetStream streams. |
| `ensureDefaultDeliveryClass({ servers, space, creds?, deliveryClass })` | write the space's default delivery class at creation so it is wire-discoverable (SPEC section 4). |
| `serverConfig(auth, { storeDir, extraAccounts?, port?, host? })` | render the broker config for one operator; `storeDir` is required and `extraAccounts` preloads the auth-callout account. |
| `mintCreds(auth, identity, profile, opts?)` | mint a scoped cred for any `Profile`. |
| `mintMembershipObserverCreds`, `mintConnectionEvictorCreds` | mint the membership/eviction scoped creds. |
| `provisionAgent`, `provisionAgentDurables` | create a principal's bind-only durables. |
| `newIdentity`, `stripSpaceAuth` | a fresh nkey identity; a stripped signer bundle (data signing seed only). |
| `Profile`, `CredentialKind`, `MintOpts`, `SpaceAuth` *(types)*, `CREDENTIAL_LIFETIMES` | the profile matrix and cred lifetime policy. |

**Auth building blocks** (all `@cotal-ai/auth`)

| symbol | purpose |
|---|---|
| `createCalloutAuth`, `startAuthCallout` | the NATS auth-callout responder. |
| `createUserTokenIssuer`, `pinnedJwksResolver` | mint and verify the Cotal user bearer. |
| `createIdpBridge` | exchange a verified IdP JWT for a Cotal bearer (see [the callout contract](identity-and-auth.md#the-idp-callout-contract)). |
| `deriveOwnerToken`, `validateUserToken` | owner derivation; strict bearer validation. |
| `cotalAuthProvider` | the self-registering `auth-provider` extension. |
| `ensureCalloutAuth`/`loadCalloutAuth`, `ensureIssuer`/`loadIssuer`, `ensureOwnerSecret`/`loadOwnerSecret` | read/write the auth secret kinds through a `SecretStore`. |

**Seams and the wire** (all `@cotal-ai/core` unless noted)

| symbol | purpose |
|---|---|
| `SecretStore` *(type)* | the durable hosted-secret seam (get/put/delete); `get()` returns raw seeds/keys into process memory, so it is a blob seam, not HSM/KMS signing. |
| `FsSecretStore`, `workspaceSecretStore(root)` | the filesystem default. **These live in `@cotal-ai/workspace`, not core.** |
| `AuthProvider` *(type)*, `Connector` *(type)*, `Runtime` *(type)*, `Command` *(type)* | the extension contracts; implementations self-register on import. |
| `registry` | the shared registry a composition root pulls surfaces into. |
| `CotalEndpoint`, subjects, message types | the wire client and shapes. |
| `ParsedArgs` *(type)* | the shape the daemon runners take (see below). |

The runners take a CLI-shaped `ParsedArgs`, not a typed options object, so a host fabricates one:

```ts
const args: ParsedArgs = { values: { space, server, port: "0" }, positionals: [], raw: [] };
```

## Booting the daemons

### auth-service

`runAuthService(args, store?)` reads its provisioned long-lived secret kinds (service keys, callout
account, issuer keys, owner secret) through the injected `SecretStore`; a host provisions those into
the store first. It is a **signer and identity authority**, not a scoped daemon: at runtime it holds
the data-account and callout-account signing seeds, the issuer's private JWKs, and the
owner-derivation secret in process memory (`SecretStore.get` exports raw values). The IdP pin and the
actor ledger are **not** store-injected: `runAuthService` resolves them under
`userAuthStateDir(findCotalRoot(), space)`, a path relative to the process working directory, so a
host provisions those into that exact directory (neither `store` nor `COTAL_HOME` selects it). It
also writes an ephemeral `auth-service.json` discovery file there that carries the live exchange
capability.

```ts
import { runAuthService } from "@cotal-ai/auth";
// store implements SecretStore over your secret backend; get() returns raw seeds into memory.
// Provision the auth secret kinds into the store, AND the IdP pin + actor ledger under
// userAuthStateDir(findCotalRoot(), space), before this call.
await runAuthService(
  { values: { space, server: brokerUrl, port: "8081" }, positionals: [], raw: [] },
  store,
);
```

### delivery

`runDelivery(args, store?)` runs from a **pre-minted scoped `delivery` cred** and never loads the
signer. Provide the cred either through the injected store (under `DELIVERY_CREDS_KEY`) or with a
`--creds` file; the two are mutually exclusive. The daemon re-fetches the cred from the store at 75%
of its JWT lifetime and fails loud rather than riding to expiry, so **something must re-sign a fresh
cred into that same store**.

```ts
import { runDelivery } from "@cotal-ai/delivery";
await runDelivery({ values: { space, server: brokerUrl }, positionals: [], raw: [] }, store);
```

That renewal is a **signer** operation, not the delivery daemon's: `remintDaemonCreds(root, store)`
(`@cotal-ai/workspace`) reads the full `SpaceAuth` signer **through the same resolved `store`**
(`getSpaceAuth(store ?? workspaceSecretStore(root))`, key `auth/auth.json`) and re-signs the daemon
creds (`delivery.creds` and the membership feed's `membership-rw.creds`) back into that store — so the
injected `store` is BOTH the signer source AND the cred destination, never a split. The reference
`Manager` runs it on a schedule against its **own** `secretStore` (see below), so passing the manager
and the delivery daemon the *same* store closes the renewal loop end-to-end on an injected backend:
the manager reads the signer from the store, re-signs into it, and the daemon adopts each generation
on a preflight-proven 75% timer. It never throws: it returns per-file results (`skipped: "no-auth"`
when the store holds no signer under `auth/auth.json`), so the caller must check them or the cred
still rides to expiry; a malformed stored bundle does still throw from that signer read. A composition
whose signer lives in KMS/Vault simply injects that store — no bespoke renewal needed — and a
`--creds` file path must be replaced atomically before the 75% read. The remaining hosted gap is no
longer signer custody (the signer IS injectable behind the store seam); it is signer **isolation** —
the seed is still decrypted in-process at the manager's uid (an OS-sandbox / remote-signer concern).

### The supervisor is a signer, not a scoped daemon

`@cotal-ai/manager` exports the `Manager` class; there is **no** `runSupervise(opts)` runner. The
private CLI `runManager` also does broker-reachability checks, space/default resolution,
roster/launch parsing and materialization, installed-extension resolution, signal handling, staged
pre-spawn, and the forever wait. A host composes that lifecycle itself around `Manager`:

```ts
import { Manager } from "@cotal-ai/manager";
const mgr = new Manager({ space, servers: brokerUrl, workspaceRoot });
await mgr.start();          // then wire your own SIGINT/SIGTERM -> mgr.stop()
```

Unlike delivery, the manager is **not** a pre-minted-scoped-cred daemon (auth-service is also a
signer: it holds fewer artifacts than the full trust bundle, but its data-account signing seed still
grants complete data-account mint authority on compromise, so this is not least-privilege). On `start()`
the manager reads the full space trust bundle **through its `secretStore`** (`getSpaceAuth(this.secrets,
this.space)`, key `auth/auth.json`) and **self-mints** its supervisor cred and renewals from the
data-account signing seed. In static mode it also mints every per-agent cred from that seed; in user
mode agents instead receive callout-minted bearers, but the manager still holds the signing seed for
its own creds and renewal. So a hosted supervisor is a **trusted per-tenant account-signer process**,
not a least-privilege connect client. It additionally requires a `~/.cotal/meshes/<space>.json`
registry record and the workspace user-auth marker to start in user mode. `ManagerOptions.secretStore`
injects the one `SecretStore` the manager reads/writes every secret through — **the signer itself
(`auth/auth.json`)**, its daemon-cred renewal (`remintDaemonCreds`), and its per-agent secret sites —
defaulting to the workspace filesystem store; pass the delivery daemon the *same* store for end-to-end
hosted renewal. The signer IS now injectable: a hosted composition injects a KMS/Vault store and no
signing seed lands on the hosted disk. What remains is signer **isolation** (the seed is decrypted
in-process at the manager's uid — an OS-sandbox / remote-signer problem, below), not custody. The other
knobs are `workspaceRoot` and the process-global `COTAL_HOME`.

> Scope note: the **static-auth** operator paths (`cotal spawn`/`join`/`status`/`web`, via
> `mesh-target` → `connect`/`preflight`) still read the signer from the local `auth.json` (sync
> `loadSpaceAuth`). That is the single-machine composition, where the signer is on local disk by the
> static-auth model; multi-tenant hosting runs **user mode**, which never mints from on-disk trust. The
> store-injectable signer path is the hosted-server set: the manager, `remintDaemonCreds`, and delivery.

**Isolating the signer is an OS-sandbox problem, not a file-permission one.** The default pty runtime
runs agent children under the *same* OS uid and the *same* `workspaceRoot`, so mode-0600 on
`auth.json` does not stop a hostile same-uid agent from reading its absolute path. The reference
[deploy](deploy.md) tree does not solve this: it mounts the signer into the agent's own container, so
its phase-1 boundary isolates agents from each other, not the signer from the agent. A hosted
composition must run the manager/minter that holds the signer in a different uid, container, or mount
namespace from the agent children, which mount no signer at all; that split is future
hosted-composition work, so until it (or a remote/injected minter) exists, do not run untrusted
agents under this manager.

## Provisioning a space (one-space reference shape)

```ts
import { createSpaceAuth, setupSpaceStreams, ensureDefaultDeliveryClass, mintCreds, newIdentity } from "@cotal-ai/core";
const auth = await createSpaceAuth(space);                       // trust bundle (in-memory seeds)
const provisionerCreds = await mintCreds(auth, newIdentity(), "provisioner");
await setupSpaceStreams({ servers: brokerUrl, space, creds: provisionerCreds });
// SPEC section 4: write the default delivery class at space creation so it is wire-discoverable,
// never inferred from the resolution fallback. A daemon-backed space is "durable".
await ensureDefaultDeliveryClass({ servers: brokerUrl, space, creds: provisionerCreds, deliveryClass: "durable" });
const deliveryCreds = await mintCreds(auth, newIdentity(), "delivery");
// put deliveryCreds into your SecretStore under DELIVERY_CREDS_KEY before booting delivery.
```

Rendering the broker config for a user-auth space is `serverConfig(auth, { storeDir, extraAccounts })`,
where `extraAccounts` must include the callout account from `createCalloutAuth` so the auth-service has
a broker account to answer on. That account never shares the data account.

`createSpaceAuth` mints one operator + system + data account **per call**, and `serverConfig`
renders **one** operator. That is the single-space reference shape. Running many spaces (tenants)
under one shared broker operator is a different provisioning shape that the current exports do not
yet cover; see [Known gaps](#known-gaps-not-hosted-composable-yet).

## Hazardous provisioning primitives

`mintCreds`, the full `Profile`/`CredentialKind` matrix, `createSpaceAuth`, and `stripSpaceAuth` are
low-level operator primitives. Handle them as account-authority material:

- A holder of a `SpaceAuth` (or a `stripSpaceAuth` bundle, which **keeps** the data signing seed) is
  a fully-trusted tenant-account authority: it can mint `admin`, `provisioner`, and destructive
  profiles, not merely `supervisor`, and mint a DM-reading identity. `createSpaceAuth`'s full result
  holds operator, system, and account seeds in memory.
- Choose `profile` and `MintOpts` from **server-side constants**, never from tenant input. `MintOpts`
  can widen the bounded TTL defaults; cap it at your boundary. `CREDENTIAL_LIFETIMES` is a policy
  record, not an authorization boundary.
- Never log signer material or export it into env. Do not co-locate signer access with an untrusted
  connector/runtime process at the same OS uid (file permissions do not contain a same-uid reader;
  see the manager's isolation note). Segregate per tenant; rotate on compromise
  (`rotateDataAccountSigningKey`).

## Known gaps: not hosted-composable yet

The primitives above are present as exports, but three capabilities are **not** cleanly composable
from the public contract today. Each is tied to work in flight; a host either waits for the seam or
scopes the capability out. None is a wire concern.

1. **Delivery immediate live eviction and a fully-hosted membership feed.** The renewable
   `membership-rw.creds` is now a `SecretStore` kind — `startMembership` reads it through the injected
   store and the manager re-signs it there, so the graph feed's writer renews end-to-end on a hosted
   backend (its data connection adopts each generation on a preflight-proven 75% timer). What still
   reads from a fixed on-disk path are the *static* `membership-observer.creds` and
   `connection-evictor.creds` ($SYS creds, mintable only at `up`) and `membership.json`
   (`{accountId}`, non-secret config); those, plus the private provisioning wrapper, keep immediate
   live eviction and a fully-hosted feed a partial gap. Missing files degrade membership to
   traffic-only and make live eviction refuse (loudly). The supported delivery contract here is the
   Plane-3 durable backstop.
2. **Supervisor signer isolation.** `ManagerOptions.secretStore` now injects the one `SecretStore` the
   manager reads/writes every secret through, including the `SpaceAuth` signer bundle
   (`auth/auth.json`), its daemon-cred renewal, and its per-agent kinds. What remains is process
   isolation: the manager still decrypts the signer in-process at its uid, so untrusted agent children
   must run under a different uid/container/mount namespace or behind a future remote signer.
3. **Many spaces per broker.** No published "add a tenant account under one shared operator" API;
   the exports compose the one-space reference shape. This is the multi-space operator layer.
4. **A non-Better-Auth production IdP.** The exchange core (`createIdpBridge`) is EdDSA-generic, but
   the stock provider and login client are Better-Auth-endpoint-shaped, `cotalAuthProvider`
   self-registers on import (colliding with a host-owned provider under `resolveAuthProvider`), and
   the login flow speaks Better Auth's device-code endpoints. A different IdP is a host-built auth
   composition on the low-level primitives, not a configuration change (see
   [the IdP callout contract](identity-and-auth.md#the-idp-callout-contract)).

## Durable state: the hosted boundary

Space-durable **coordination** state (chat/DM/task history, live presence, membership runtime, the
durable ACL registry, leases) lives in **JetStream**, written by the delivery daemon and the
endpoints. It is broker-resident and needs no host-side durable path.

What is **not** in JetStream, and is hosting-critical, is trust and authorization state a host must
place and keep:

| state | class | where today | hosted injection |
|---|---|---|---|
| full `SpaceAuth` bundle (`auth/auth.json`, `.cotal/auth/auth.json` under the FS store) | signing authority | `SecretStore` | `SecretStore` (manager + renewal) |
| auth kinds: callout account/creds/xkey, issuer private keys, owner-derivation secret, data-signer projection | signing/identity authority | four `SecretStore` kinds | `SecretStore` (auth-service) |
| `delivery.creds` | standing scoped cred | `SecretStore` or `--creds` | `SecretStore` (delivery) |
| actor ledger, IdP pin | authorization + trust config | ambient `userAuthStateDir(findCotalRoot(), space)` | none (root-relative; not `store`/`COTAL_HOME`) |
| `membership-rw.creds` | standing scoped cred | `SecretStore` | `SecretStore` (delivery + manager renewal) |
| membership-observer / connection-evictor creds + `membership.json` | scoped $SYS creds / config | workspace filesystem | none (see gap 1) |
| manager agent creds, actor tokens, sentinel creds | lifecycle authority | `SecretStore` | `SecretStore` (manager `secretStore`) |
| `~/.cotal/meshes/<space>.json` record (holds IdP trust pins/root pointers) | non-secret, integrity-critical | machine home | process-global `COTAL_HOME` only |
| auth-health, renewal records | non-secret diagnostics | workspace filesystem | `workspaceRoot` |

The `SpaceAuth` bundle and the auth-service store kinds are **separate** identities/projections, not
parts of one `auth.json`. `auth-service.json` (the live exchange capability) is ephemeral runtime
state, not durable, but is sensitive while the daemon runs. `@cotal-ai/workspace` is machine-local
operator tooling by design; personas, PID files, and the `current-mesh` pointer are truly local and
must **not** sit on a hosted durable path. Everything classed above as an authority is what a hosted
composition must provision and persist: signer-bearing server secrets now have `SecretStore` seams;
the remaining non-injectable rows are the explicit ambient `workspaceRoot`/cwd paths above.

## See also

- [Substrate stability](stability.md): what v0.3 and the 0.x packages guarantee, and the projected v0.4 break.
- [Identity and auth](identity-and-auth.md): the profile matrix, the signer, and the IdP callout contract.
- [Delivery daemon](delivery-daemon.md): the Plane-3 durable backstop.
- [Deploy](deploy.md): the reference container against an external broker.
