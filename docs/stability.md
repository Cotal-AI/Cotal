# Substrate stability

> **Project** (informative) · **For:** anyone building on the published packages · **See also:** [Embedding Cotal](embedding.md), [Release](release.md), [wire versioning](../SPEC.md#11-versioning-and-extensibility)

Cotal's packages are pre-1.0 and publish in lockstep. Pin the versions you embed and read
[Upgrading](UPGRADING.md) before changing them. A package version, a wire revision and a
service's discovered contract revision describe different compatibility boundaries.

## What you can build on

| Interface | Reference and boundary |
|---|---|
| Messaging, presence and channel access | [Spec](../SPEC.md) and [Build a client](build-a-client.md); sender identity and durable state include the documented lifecycle rules. |
| Service discovery and invocation | [Control surface](control-surface.md); use discovered schemas and issued grants, not a cached command name alone. |
| TypeScript embedding | [Embedding Cotal](embedding.md); use public exports and keep first-party package versions matched. |
| CLI automation | [Structured output](cli.md#structured-output); each command declares its output formats and failure outcomes. |
| Agent integrations | [Connectors](connectors.md); delivery, resume and event support vary by application. |
| Durable workflows | [Cotal Lang](../spec/cotal-lang.md) and [Workflow runs](workflows.md); replay compatibility depends on the recorded language version and step journal. |

These interfaces are implemented, but a deployed host may not enable every one. In
particular, user-auth service serving, personal-session approval and remote workflow
hosting require authority supplied by that deployment. The
[composition limits](embedding.md#hosted-composition-gaps) remain part of the embedding contract.

## Package versions

A `0.N.x` patch carries no intended breaking change. A minor bump from `0.N` to `0.N+1`
may break an API. Pin an exact `0.N.P` for an embedded deployment and upgrade its
first-party dependency set together. Inspect the changelog and migration instructions;
a successful install does not update modules already loaded by running processes.

`cotal version` reports the installed CLI and extension versions. Inside an agent,
`cotal_docs` reports the version of its documentation bundle. Neither observation proves
that every remote manager or service runs the same build.

## The wire compatibility signal

The normative [versioning rules](../SPEC.md#11-versioning-and-extensibility) distinguish
advertised compatibility from the revisions being implemented. The spec is Draft v0.5:
section 13 defines the v0.4 endpoint control surface, and section 14 adds workflow runs.
Its migration notes are not a declaration that every implementation path has completed
the corresponding conformance requirements.

`AgentCard.protocolVersion` is a compatibility signal, not capability negotiation.
Before the v0.4 marker boundary it was optional; v0.4 conformance requires the marker.
The reference card type still permits omission. Do not infer complete conformance from
a package number, an optional TypeScript field or the existence of an endpoint command.
Use the [conformance rules](../SPEC.md#12-conformance) and the endpoint's verified contract.

Additive wire changes and breaking changes follow the spec's change process. Workflow
programs also carry a language version, which is independent of npm and wire versions.

<a id="the-coming-v04-cut"></a>

## Endpoint migration

The endpoint surface is already used by the manager and other services. The migration
has broader compatibility consequences than renaming control commands:

- Typed endpoint/class/instance subjects replace earlier control subjects and grants.
- Lifecycle UIDs scope durable readers, membership and authority to an incarnation.
- Manager spawn is an action; attach uses a mesh session rather than a public loopback socket.
- The control surface requires NATS server 2.12 or newer; particular persisted stores can
  require a newer server, as the [Quickstart](getting-started.md) explains.

Keep the [spec's migration boundary](../SPEC.md#1311-the-hard-cut) separate from the package
upgrade you are performing. The current [upgrade guide](UPGRADING.md) records package-specific
contract changes and operator steps. A source merge alone is not proof that old clients,
credentials or persisted state have been migrated.

<a id="building-around-the-cut"></a>

## Building around changes

Keep control, lifecycle and storage calls behind a small integration boundary in your
application. Use public APIs rather than importing internal files. Test the actual
credential and host modes you deploy; a static-auth fixture does not establish user-auth
support. Preserve journals and credential state until the upgrade instructions say how
to handle them.

## Compatibility policy

The substrate remains pre-1.0. There is no 1.0 compatibility promise yet.

- Every intended breaking change ships with a changeset and changelog entry.
- Where practical, an API is deprecated for one minor line before removal. The documented
  v0.4 hard cut is an exception with no dual-serving guarantee.
- The latest minor is supported. The previous minor receives patch fixes until the next
  minor ships, a one-minor overlap.

These package rules do not replace wire conformance or a hosted service's deployment policy.
