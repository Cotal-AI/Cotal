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
auth-callout account) plus three standalone processes. The trust layer itself composes many spaces
under one broker operator today (`createBrokerAuth` + `createSpaceAccountAuth` + N-space
`serverConfig`); what does not exist yet is the per-space **lifecycle** on a shared broker (see
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
| `DELIVERY_CREDS_KEY` | `@cotal-ai/delivery` | the secret-store key the delivery cred is read under. |
| `Manager`, `ManagerOptions` *(type)* | `@cotal-ai/manager` | construct and run a supervisor in-process. |
| `createRuntime`, `Runtime` *(type)* | `@cotal-ai/manager` | resolve the spawn backend (pty built in). |

**Provisioning and minting** (all `@cotal-ai/core`)

| symbol | purpose |
|---|---|
| `createBrokerAuth(label)` | mint BROKER trust: the operator and system account one nats-server trusts. One per broker, shared by every space on it. |
| `createSpaceAccountAuth(broker, space)` | mint one space's own data account, signed by that broker's operator — the add-a-tenant primitive. |
| `createSpaceAuth(space)` | the one-space convenience: broker trust + one account in a single composed bundle. |
| `setupSpaceStreams({ servers, space, creds })` | create the space's JetStream streams. |
| `ensureDefaultDeliveryClass({ servers, space, creds?, deliveryClass })` | write the space's default delivery class at creation so it is wire-discoverable (SPEC section 4). |
| `serverConfig(broker, spaces, { storeDir, extraAccounts?, port?, host? })` | render the broker config: one operator, N space accounts. `storeDir` is required and `extraAccounts` preloads the auth-callout account. |
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
(`@cotal-ai/workspace`) loads the root's sole space trust (composed from the split
`auth/broker.json` + `auth/account.<key>.json`; the pre-split `auth.json` monolith is migration
input only) and re-signs the cred into `store` (the injected `store` is only the destination, not signer custody). So
a separate trusted renewal-owner process, under the same signer isolation as the manager, runs it on
a schedule; the reference manager does exactly this, but against its *workspace* store, not your
injected one. It never throws: it returns per-file results (`skipped: "no-auth"` when no filesystem
signer is present), so the caller must check them or the cred still rides to expiry; a malformed
trust record does still throw from that initial signer load. A composition whose signer is not
filesystem-resident builds its own renewal from `identityFromCreds` + `mintCreds` instead, and a
`--creds` file path must be replaced atomically before the 75% read. This is a hosted-composability
gap, not a solved seam.

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
grants complete data-account mint authority on compromise, so this is not least-privilege). On `start()` the manager loads its space's
full trust chain (composed from `auth/broker.json` + `auth/account.<key>.json`; a container may
instead mount a stripped signer bundle at `auth/auth.json`) from `workspaceRoot` and **self-mints**
its supervisor cred and renewals from the data-account signing seed. In static mode it also mints every per-agent
cred from that seed; in user mode agents instead receive callout-minted bearers, but the manager
still holds the signing seed for its own creds and renewal. So a hosted supervisor is a **trusted
per-tenant account-signer process**, not a least-privilege connect client. It additionally requires a
`~/.cotal/meshes/space.<key>.json` registry record and the workspace user-auth marker to start in
user mode. There is no `SecretStore`/minter injection on `ManagerOptions` yet; the only knobs are
`workspaceRoot` and the process-global `COTAL_HOME`.

**Isolating the signer is an OS-sandbox problem, not a file-permission one.** The default pty runtime
runs agent children under the *same* OS uid and the *same* `workspaceRoot`, so mode-0600 on
the trust records does not stop a hostile same-uid agent from reading their absolute paths. The reference
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

Rendering the broker config for a user-auth space is `serverConfig(broker, spaces, { storeDir,
extraAccounts })`, where `extraAccounts` must include the callout account from `createCalloutAuth` so
the auth-service has a broker account to answer on. That account never shares the data account.

Broker trust and space accounts are separate authorities: `createBrokerAuth` mints the one
operator + system account a broker trusts, `createSpaceAccountAuth(broker, space)` signs each
tenant's data account under it, and `serverConfig(broker, spaces, opts)` renders them all into one
config. A host composition can therefore provision several spaces on one broker today. The `cotal`
CLI itself still orchestrates one space per root (its `up`/`down` lifecycle refuses broker-wide
operations on a multi-space root rather than scoping them); the per-space lifecycle is the
remaining multi-space operator layer — see
[Known gaps](#known-gaps-not-hosted-composable-yet).

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

1. **Delivery broker-sourced membership graph and immediate live eviction.** The delivery daemon
   also reads `membership-observer.creds`, `membership-rw.creds`, `connection-evictor.creds`, and
   `membership.json` (`{accountId}`) from a fixed on-disk path. The creds are mintable from public
   primitives (`mintMembershipObserverCreds`, `mintConnectionEvictorCreds`, `mintCreds(..., "membership-rw")`,
   `accountId = auth.account.pub`), but there is no exported path contract and no store injection for
   them, and the provisioning wrapper is private. Missing files degrade membership to traffic-only
   and make live eviction refuse (loudly), so this is a real capability, not convenience. The
   supported delivery contract here is the Plane-3 durable backstop; broker-sourced membership and
   immediate live eviction wait for the membership-store seam.
2. **Supervisor secret threading.** As above, `Manager` has no `SecretStore`/minter injection; a
   hosted supervisor runs on a filesystem-resident signer bundle plus mesh-registry record. The
   store-threading seam is in flight.
3. **Per-space lifecycle on a shared broker.** The trust layer is multi-space
   (`createBrokerAuth` + `createSpaceAccountAuth` + N-space `serverConfig`, persisted as
   `broker.json` + `account.<key>.json`), but there is no per-space teardown/backup/restore:
   the CLI's broker-wide lifecycle verbs refuse on a multi-space root, naming the tenants.
   This is the remaining multi-space operator layer.
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
| full `SpaceAuth` trust chain (`auth/broker.json` + `auth/account.<key>.json`, composed; a stripped signer bundle may instead be mounted at `auth/auth.json`) | signing authority | workspace filesystem | none (the manager reads it raw; no SecretStore seam) |
| auth kinds: callout account/creds/xkey, issuer private keys, owner-derivation secret, data-signer projection | signing/identity authority | four `SecretStore` kinds | `SecretStore` (auth-service) |
| `delivery.creds` | standing scoped cred | `SecretStore` or `--creds` | `SecretStore` (delivery) |
| actor ledger, IdP pin | authorization + trust config | ambient `userAuthStateDir(findCotalRoot(), space)` | none (root-relative; not `store`/`COTAL_HOME`) |
| membership/eviction creds + `membership.json` | scoped creds/config | workspace filesystem | none (see gap 1) |
| manager agent creds, actor tokens, sentinel creds | lifecycle authority | workspace filesystem | none (no store seam yet) |
| `~/.cotal/meshes/space.<key>.json` record (holds IdP trust pins/root pointers) | non-secret, integrity-critical | machine home | process-global `COTAL_HOME` only |
| auth-health, renewal records | non-secret diagnostics | workspace filesystem | `workspaceRoot` |

The `SpaceAuth` trust chain and the auth-service store kinds are **separate** identities/projections,
never parts of one document. `auth-service.json` (the live exchange capability) is ephemeral runtime
state, not durable, but is sensitive while the daemon runs. `@cotal-ai/workspace` is machine-local
operator tooling by design; personas, PID files, and the `current-mesh` pointer are truly local and
must **not** sit on a hosted durable path. Everything classed above as an authority is what a hosted
composition must provision and persist, today only partly through the `SecretStore` seam and
otherwise through ambient `workspaceRoot`/cwd paths.

## See also

- [Substrate stability](stability.md): what v0.3 and the 0.x packages guarantee, and the projected v0.4 break.
- [Identity and auth](identity-and-auth.md): the profile matrix, the signer, and the IdP callout contract.
- [Delivery daemon](delivery-daemon.md): the Plane-3 durable backstop.
- [Deploy](deploy.md): the reference container against an external broker.
