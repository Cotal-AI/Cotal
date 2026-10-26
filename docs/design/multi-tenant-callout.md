# One callout process for every space on a host

Status: implemented by #4819 and included in published version 0.103.1. `openCalloutLane` is in
`implementations/auth/src/callout-lane.ts`, `runCalloutHost` and the manifest parser are in
`implementations/auth/src/callout-host.ts`, and `cotal auth-service --callout-only --spaces
<manifest>` is documented under [server daemons](../cli.md#server-daemons). SPEC §10 and Appendix B
were amended in the same change. `pnpm smoke:callout-multi-tenant:auth` drives two spaces through
one process on a live broker. The shipped code settles or extends the text below in three places:

- Reconcile also runs when a lane is lost and a fixed 5 seconds after a lane fails to open, and its
  backstop interval is 60 seconds. A manifest that cannot be read or parsed whole is reported and
  the live lanes are kept.
- Decision 1 is settled as one `--server` per host. A manifest entry that is not a space name string
  is refused with a message to run one host process per broker.
- The single-space journal line carries `space=<space>`, as decision 4 proposed.

The record below is the design as written before implementation.

A design record, not a description of shipped behavior. Every claim about current behavior names the
file and the function it was read from. Everything else is proposed. Once this record is approved the
surface below is frozen and the implementation follows it as written.

## 1. The problem, measured at this head

Production `cotal_cloud` runs one `cotal auth-service --callout-only` process per space. Sixteen
spaces on a 4 vCPU host cost 180 to 340 MB RSS each, so memory per space bounds spaces per host.

Most of that is the same code loaded sixteen times. Measured on this host at base
`43a3e79e4160d7e28423a01fd4ce4a34198760e8`, Node 24.22.0, GC settled, importing
`implementations/auth/dist/index.js` plus `@nats-io/transport-node`, `@nats-io/jetstream` and
`@nats-io/kv` and nothing else:

| | RSS |
| --- | --- |
| Node baseline, no imports | 44 MB |
| After the auth and NATS module graph | 136 MB |
| Sixteen such processes, before a single space is served | 2176 MB |

So about 136 MB of every per-space process is a duplicate module graph, and the marginal cost of a
space is the remainder, roughly 50 to 200 MB of connections, watchers, ledger reads and buckets. One
process holding sixteen lanes pays the 136 MB once. The measured table in the implementation step
reports RSS and CPU per space at 1, 4 and 16 lanes against 16 single-space processes.

## 2. What phase 1 already gives us

Read from `implementations/auth/src/callout-replica.ts` (`runAuthCalloutReplica`),
`implementations/auth/src/callout-authority.ts` (`calloutAuthority`, `serveCallout`) and
`implementations/auth/src/callout.ts` (`startAuthCallout`):

- `serveCallout` and `calloutAuthority` are already space-parameterized. Neither reads a global.
- `startAuthCallout` captures its signing material in its closure at call time: `xkp` from
  `opts.xkeySeed`, `responseSigner` from `opts.authAccount.signingSeed`, `userSigner` from
  `opts.dataAccount.signingSeed`. There is no key lookup anywhere in the request path.
- Every secret load is keyed by space: `loadServiceKeys(store, space)`, `loadCalloutAuth(store, space)`,
  `loadIssuer(store, space)` in `implementations/auth/src/store.ts`, over one
  `workspaceSecretStore(root)`. A root already holds many spaces, and
  `implementations/cli/src/commands/status.ts` already names that case a multi-space root.
- `runAuthCalloutReplica` is the only part that is single-space by construction. It installs SIGINT
  and SIGTERM handlers and ends in `process.exit`, so a second space cannot share the process, and
  one space losing a store connection would take every other space down with it.

Four NATS connections open per space: the held issuer session, the store authority client, the
connect-reader authority client, and the callout connection itself.

## 3. The lane

Split `runAuthCalloutReplica` along the line that already exists in it.

`openCalloutLane({ space, server, root, secrets, limits })` performs everything that function does
between loading key material and `serveCallout`, and returns a handle: the space it serves, a
`close()`, and a `lost` promise that settles with the reason its connections ended. It installs no
signal handler and never calls `process.exit`.

`runAuthCalloutReplica` becomes one lane plus the process shell it has today: the same two signal
handlers, the same non-zero exit on loss, the same startup refusals and the same ready line.

`runCalloutHost({ spaces, server, root, limits })` holds a `Map<string, Lane>` and the process shell
for many lanes. A lane that loses its connections closes itself and leaves the map. The other lanes
keep answering, because nothing is shared between them except the module graph and the event loop.

## 4. Key isolation

A response for space A must never be signed with space B's key. Two independent barriers give that,
and neither is a runtime check that could be miswritten.

**The broker decides which lane sees a request.** Each space has its own dedicated auth account,
minted by `createCalloutAuth` in `implementations/auth/src/callout.ts`, whose JWT carries
`authorization { auth_users, allowed_accounts, xkey }`. A lane's callout connection authenticates as
that account's sole `auth_users` entry. NATS accounts are disjoint subject namespaces, so a
subscription to `$SYS.REQ.USER.AUTH` on space A's connection receives space A's requests and cannot
receive space B's. One connection per auth account is therefore required, and the per-space
connection is what makes the isolation structural rather than asserted. The published NATS auth
callout page and ADR-26 document config mode and leave operator-mode multi-account behavior
unstated, so the smoke proves this on a live broker rather than citing it.

**The closure decides which key signs.** Each lane calls `startAuthCallout` once with its own
`opts`, so `xkp`, `responseSigner` and `userSigner` are bound to that lane's material for the life of
the service. The host holds no map from space to key, and no code on the request path selects a key.
Adding a lane adds a closure; it does not add a lookup that could return the wrong row.

The smoke proves the result rather than the mechanism: two spaces through one process, a connect on
each, and the minted JWT for space A verified against space B's data account signing key, which must
fail, and against its own, which must pass.

## 5. Adding and removing a space while the process runs

The hosted backend provisions spaces continuously, so the live set has to change without a restart.

The host owns a manifest file naming the spaces it serves. One reconcile function diffs the manifest
against the live map: it opens a lane for a space in the manifest with no lane, and closes the lane
of a space no longer in it. Closing is ordered as `closeAll` orders it today, callout connection
first, so the broker routes that space around this process before its authority connections go.

Reconcile runs on three triggers, and they are the same code path: the manifest changing on disk, a
`SIGHUP`, and a fixed interval. The interval is also what re-opens a lane that closed on a lost
connection, so recovery is not a second mechanism with its own backoff.

A lane that fails to open is reported and left out of the map; the next reconcile tries it again. At
startup the host is all or nothing: if any space in the manifest fails its checks the host refuses to
start and names the space, which matches the no-fallback rule and makes a bad manifest loud. After
startup one space failing to open leaves the other lanes running.

Every per-space refusal phase 1 performs stays per-lane: the missing-material error, the
`issuer.issuer !== spaceIssuer(space)` pin, the broker reachability probe, and the refusal to serve a
space whose auth service runs with `--service-endpoints`.

## 6. Connect limits and the latency log

`ConnectLimiter` in `implementations/auth/src/connect-limit.ts` keys buckets `actor:<owner>.<actor>`,
`owner:<owner>` and `host:<host>`. No key carries a space, so one limiter shared across lanes would
let a client host connecting to space A spend space B's allowance.

Each lane constructs its own `ConnectLimiter`. A space served by one lane of a multi-tenant host then
gets the same allowance it gets from a dedicated process today, and
`docs/identity-and-auth.md` keeps its claim that each process keeps its own buckets, restated per
lane.

The journal line in `startAuthCallout` carries no space today, so sixteen lanes writing to one stderr
would be unreadable. `startAuthCallout` already holds `opts.space`, so it gains one field,
`space=<s>`, after `outcome=`. Single-space mode emits it too, which keeps one format for every
deployment and costs a documentation update rather than a parser branch.

## 7. What the operator runs

`--spaces` extends the daemon entry beside `--callout-only`, where `--callout-only` already lives:

```bash
cotal auth-service --callout-only --spaces <manifest> --server <url> [--auth-timeout <seconds>]
```

The manifest is a JSON file, `{"version": 1, "spaces": ["<s>", "<s>"]}`. An empty list, a duplicate,
an unknown key or an unknown version refuses.

`--space` and `--spaces` are mutually exclusive and one is required. `--spaces` without
`--callout-only` refuses, as do the HTTP and service-endpoint flags that `--callout-only` already
refuses. There is no default manifest path and no single-space fallback when the manifest holds one
space; the operator names which mode they want.

The service preset is unchanged. `implementations/auth/src/daemon-flags.ts` records that only the
daemon entry takes the replica flag, because the preset runs the one primary that a space's
`auth-service.json` names. Multi-tenancy is a property of the replica, so it lands where the replica
already is.

## 8. What phase 1 keeps

`cotal auth-service --callout-only --space <s> --server <url>` keeps its behavior with one exception.
One lane, the same refusals, the same ready line, the same non-zero exit when it loses a store
connection or the broker. The exception is the new `space=` field on the journal line.

## 9. SPEC and docs paragraphs this touches

| Paragraph | Why |
| --- | --- |
| §10 Connection and onboarding, the auth-callout onboarding paragraph | The callout mechanism is normative. One process serving several auth accounts needs the per-account connection stated, because today the text reads as one callout per space. |
| §10 Connection and onboarding, the Connect limits paragraph | It says the service MAY limit per actor, owner and host. The per-space scope of a bucket becomes explicit so a multi-tenant host cannot read as shared. |
| §13.9 Authority boundary, the Issuance row | It already scopes the `issuer` session per account, space and authority plane. One process now holds one such session per lane; the row is read for conformance and expected to need no change. |
| Appendix B, the `issuer` bullet | It reads "An auth service, and each callout-only replica on its own, MAY hold one `issuer` session per account, space and authority-plane lifetime", and "private to its host and never shared across accounts". A replica becomes a per-space membership that a process may hold several of, one session each, still never shared. |
| §9 NATS and JetStream security and authorization | Read for any per-process claim about the callout. None found at this head; named here so review can confirm. |

Docs updated in the same change: `docs/cli.md` server-daemons entry for `--spaces`, and
`docs/identity-and-auth.md` for the `space=` journal field and the per-lane bucket wording.

## 10. Decisions for review

1. **One `--server` for every space in the manifest.** The manifest names spaces only, and every lane
   dials the one broker URL. This assumes the host's spaces are accounts on one broker. If a host
   must serve spaces across brokers, the manifest entry becomes an object with an optional `server`.
2. **All-or-nothing startup, best-effort reconcile.** Proposed in section 5. The alternative is
   best-effort at startup too, which starts faster during an incident and hides a typo in the
   manifest.
3. **Interval reconcile as the recovery path.** The alternative is no interval: a lane that closes on
   a lost connection stays closed until the manifest changes or the operator sends `SIGHUP`, which is
   closer to phase 1's "exit and let the supervisor decide" and leaves a space unserved by this host
   for longer.
4. **`space=` on every journal line, single-space mode included.** The alternative is a per-lane log
   prefix, which keeps phase 1's line byte-identical and gives operators two formats to parse.
