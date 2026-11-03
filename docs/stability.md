# Interface stability

Cotal's packages are pre-1.0 and publish in lockstep. Pin the versions you embed, and read
[Upgrading](UPGRADING.md) before you change them. Three version numbers mark three separate
compatibility boundaries: the package version, the wire revision, and the contract revision that
a service advertises in discovery.

## What you can build on

| Interface | Reference | Boundary |
|---|---|---|
| Messaging, presence, and channel access | [Spec](../SPEC.md), [Build a client](build-a-client.mdx) | Sender identity and durable state follow the documented lifecycle rules. |
| Service discovery and invocation | [Control surface](control-surface.mdx) | Call through the discovered schema and an issued grant. A cached command name is not enough. |
| TypeScript embedding | [Embedding Cotal](embedding.mdx) | Use the public exports, and keep the first-party package versions matched. |
| CLI automation | [Structured output](cli.mdx#structured-output) | Each command declares its output formats and failure outcomes. |
| Agent integrations | [Connectors](connectors.mdx) | Support for delivery, resume, and events varies by application. |
| Durable workflows | [Cotal Lang](../spec/cotal-lang.md), [Workflow runs](workflows.mdx) | Replay compatibility depends on the recorded language version and the step journal. |

Every interface in the table is implemented, but a deployed host may not enable all of them.
User-auth service serving, personal-session approval, and remote workflow hosting each need
authority that the deployment supplies. The
[composition limits](embedding.mdx#hosted-composition-gaps) are part of the embedding contract.

## Package versions

A `0.N.x` patch carries no intended breaking change. A minor bump from `0.N` to `0.N+1` can break
an API.

For an embedded deployment, pin an exact `0.N.P`, and upgrade its first-party dependencies
together. Read the changelog and the migration instructions first. A successful install does not
update the modules that running processes already loaded.

`cotal version` reports the installed CLI and extension versions. Inside an agent, `cotal_docs`
reports the version of its documentation bundle. Neither one proves that every remote manager or
service runs the same build.

## The wire compatibility signal

The normative [versioning rules](../SPEC.md#11-versioning-and-extensibility) keep the advertised
compatibility apart from the revisions that an implementation is building toward. The spec is
Draft v0.5. Section 13 defines the v0.4 endpoint control surface, and section 14 adds workflow
runs. The spec's migration notes do not declare that every implementation path meets the matching
conformance requirements.

`AgentCard.protocolVersion` signals compatibility. It does not negotiate capabilities. Before the
v0.4 marker boundary the field was optional, and v0.4 conformance requires it. The reference card
type still lets you omit it.

Don't infer full conformance from a package number, from an optional TypeScript field, or from an
endpoint command that exists. Check the [conformance rules](../SPEC.md#12-conformance) and the
endpoint's verified contract instead.

Additive and breaking wire changes both follow the spec's change process. A workflow program also
carries a language version, which is independent of the npm version and the wire version.

## Endpoint migration

The manager and other services already use the endpoint surface. The migration changes more than
the names of the control commands:

- Typed endpoint, class, and instance subjects replace the earlier control subjects and grants.
- Lifecycle UIDs scope durable readers, membership, and authority to one incarnation.
- Manager spawn is an action. Attach runs over a mesh session instead of a public loopback socket.
- The control surface needs NATS server 2.12 or newer. Some persisted stores need a newer server,
  as the [Quickstart](getting-started.mdx) explains.

Keep the [spec's migration boundary](../SPEC.md#1311-the-hard-cut) apart from the package upgrade
you are doing. The current [upgrade guide](UPGRADING.md) records the contract changes and the
operator steps for each package. A source merge alone does not prove that old clients, credentials,
or persisted state have migrated.

## Build to absorb changes

- Put control, lifecycle, and storage calls behind a small integration boundary in your
  application.
- Use the public APIs. Don't import internal files.
- Test the credential mode and the host mode that you deploy. A static-auth fixture does not
  prove user-auth support.
- Keep journals and credential state until the upgrade instructions say how to handle them.

## Compatibility policy

Cotal is pre-1.0 and makes no 1.0 compatibility promise yet.

- Every intended breaking change ships with a changeset and a changelog entry.
- Where practical, an API stays deprecated for one minor line before it is removed. The documented
  v0.4 hard cut is an exception, with no guarantee that old and new forms are served together.
- The latest minor is supported. The previous minor also gets patch fixes, until the next minor
  ships.

These package rules do not replace wire conformance, and they do not replace a hosted service's
deployment policy.

## Earlier section links

These links lead to the current guidance for sections renamed in earlier versions.

### What is stable today [#what-is-stable-today]

See [What you can build on](#what-you-can-build-on).

### The npm semver caveat [#the-npm-semver-caveat]

See [Package versions](#package-versions).

### The coming v0.4 cut [#the-coming-v04-cut]

See [Endpoint migration](#endpoint-migration).

### Building around the cut [#building-around-the-cut]

See [Build to absorb changes](#build-to-absorb-changes).

### Building around changes [#building-around-changes]

See [Build to absorb changes](#build-to-absorb-changes).
