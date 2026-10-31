# API reference

> **Reference** (informative) · **For:** developers integrating with Cotal · **Normative:** [SPEC](../SPEC.md)

Cotal exposes a wire protocol, TypeScript libraries, CLI commands and agent tools.
Use this page to choose an interface and find its existing reference. For a task-oriented
walkthrough, start with [Choose a workflow](using-cotal.md).

## Choose an interface

| You want to | Use | Start with |
|---|---|---|
| Automate an installed Cotal from a script | CLI structured output | [Output envelopes](cli.md#structured-output), [space selection](cli.md#selecting-a-space) |
| Discover or call a service on the mesh | Native endpoint commands | [Service discovery](control-surface.md#service-discovery), [endpoint control](cli.md#endpoint-control) |
| Build a TypeScript service | Published `@cotal-ai/*` packages | [Export surface](embedding.md#the-export-surface) |
| Control a manager from your own browser UI | Browser control library | [Browser control](embedding.md#browser-control) |
| Give an agent access to the mesh | Connector tools | [Connectors](connectors.md), [MCP tool catalog](mcp-tools.md) |
| Implement a client in another language | Wire protocol over NATS + JetStream | [Build a client](build-a-client.md), [SPEC](../SPEC.md) |
| Compose a hosted service | Daemon and authority exports | [Embedding Cotal](embedding.md#what-you-embed), [composition gaps](embedding.md#hosted-composition-gaps) |

## CLI automation

Start with [structured output](cli.md#structured-output) for JSON envelopes, error
outcomes, exit codes and streaming formats. Check each subcommand's help for the
output formats it accepts. Some commands write a stream rather than one document.

Choose the [space](cli.md#selecting-a-space) explicitly in scripts that can run
against more than one mesh. The [CLI reference](cli.md#commands) lists commands
and their flags. The [terminal console](watch-a-mesh.md#terminal-console) is the
interactive operator view; scripts can use the CLI's structured reports.

## Native endpoint commands

An endpoint publishes its command contracts on the mesh. Discovery gives a caller
the command names, input schemas, capability requirements and targeting shapes.
Invocation validates arguments against the discovered schema before publishing.
See [service discovery](control-surface.md#service-discovery) for that trust chain
and [endpoint control](cli.md#endpoint-control) for the CLI forms.

Use the target's discovered contract when building a caller. A command's presence
does not grant permission to invoke it: [identity and auth](identity-and-auth.md)
governs the caller's credentials, and [grants](control-surface.md#grants) govern
endpoint control. [Instance routing](control-surface.md#instance-routing) explains
how calls reach a particular manager.

The normative contract is [SPEC §13](../SPEC.md#13-endpoint-control-surface-v04).
It defines discovery, calls, actions and sessions over the mesh.

## TypeScript libraries

[Embedding Cotal](embedding.md#the-export-surface) lists the public exports and
what each package provides. Start there for the endpoint client and service
composition. The same guide covers [daemon startup](embedding.md#booting-the-daemons)
and the [limits of hosted composition](embedding.md#hosted-composition-gaps).

For a browser application, read [browser control](embedding.md#browser-control).
It covers build-time validators and the authority a host supplies to control a
selected manager. For a hosted agent integration, read the
[remote MCP gateway](embedding.md#remote-mcp-gateway) contract.

### Endpoint request diagnostics

`CotalEndpoint` enables the native NATS `noAsyncTraces` option to avoid capturing
extra request-origin error stacks on successful operations. Failed requests still
reject with native error classes and causes. Their stacks describe the failure
site but may omit the caller that began an asynchronous request. Authentication,
authorization and timeout deadlines are unchanged. Direct native dials and
standalone helpers retain their existing diagnostic defaults.

### Temporary KV scans

`liveKvEntries` uses native memory-backed state for its temporary ordered consumer. The backing
KV stream keeps its configured storage. Each call still reads fresh broker data and must prove
completion before returning; interrupted reads throw rather than return a partial view. Consumer
cleanup, inactivity expiry and recreated-consumer checks remain in place. The temporary cursor
is not persistent across server loss.

## Agent tools

The [MCP tool catalog](mcp-tools.md) lists tool arguments and side effects. A
[connector](connectors.md) exposes the tools available to that session; its
credentials and capabilities determine which operations the agent can call.
Use [authoring a connector](authoring-a-connector.md) when adding a harness.

## Wire protocol

[Build a client](build-a-client.md#build-order) gives an implementation order for
other languages. The [SPEC](../SPEC.md) defines subjects, envelopes, presence,
delivery and endpoint control. The [message schema](../spec/cotal.schema.json)
defines message shapes; endpoint-specific command schemas come from discovery.

The wire protocol and npm packages have separate versions. Follow the
[wire versioning rules](../SPEC.md#11-versioning-and-extensibility) and the
[package release policy](release.md) for the interface you use.

## HTTP interfaces

The [auth HTTP reference](auth-api.md) covers the public listener's token exchange,
authority and chat-session operations, including their proof requirements.
Public-listener access does not grant permission to perform an operation.

The [dashboard HTTP reference](dashboard-api.md) covers seven read operations,
session authentication, response schemas and live events. It is also available as
an [interactive reference](https://docs.cotal.ai/api/dashboard/) and a
[downloadable OpenAPI specification](https://docs.cotal.ai/dashboard.openapi.json).
See [Watch a mesh](watch-a-mesh.md#web-dashboard) for dashboard launch and access limits.
For your own browser client, use the [browser control](embedding.md#browser-control)
integration contract. For a hosted or Cloud composition, start with the
[embedding guide](embedding.md#what-you-embed); the deployment must supply its
connection and authority material.

The [cotal.ai API reference](https://cotal.ai/api) documents the website's HTTP
endpoints, including search, feedback and waitlist intake. Its
[OpenAPI specification](https://cotal.ai/openapi.json) describes those website
operations. Mesh command contracts are published through endpoint discovery.

### Trusted request observation

`epRequestObservationFilter(space, { route, endpoint, command, issued })` builds a trusted
host's read filter for one command on the `one` or any-instance `inst` route. `issued` must
explicitly select the issued or legacy rail. It shares the request head with
`epRequestSubject`; actual requests still require a concrete instance id. The filter spans
target/caller suffixes, grants no authority, and does not prove the origin of an observed
frame. Observers must still parse and authorize it.

### Presence writer validation

`CotalEndpoint.setActivity`, `setStatus`, `setCondition` and `setAttention` reject values
that the roster reader cannot accept, before changing endpoint state or publishing. The
`TypeError` names the field without printing the rejected value. `setCondition(null)`
still clears the condition. The publisher also checks the final wire row.

`assertPresenceRow(value, key)` uses the same shape rule as `isPresenceRow(value, key)`,
but throws instead of returning false. It does not coerce values or impose a new enum on
forward-compatible attention/condition strings. This is wire-shape validation, not an
authorization or lifecycle check.
