# Authoring a connector

> **Reference**: describes the TypeScript reference implementation, not the wire contract. · **For:** integrators adding a new agent harness · **Wire contract:** [SPEC](../SPEC.md)

A **connector** teaches Cotal how to launch one agent harness (Claude Code, OpenCode, your own) as a
mesh node. Connectors are ordinary [extensions](cli.md#ext): you publish an npm package, the operator
runs `cotal ext add <your-package>`, and it plugs in the same way as the first-party connectors,
which are themselves just connectors seeded on first run. There is no special-casing for built-ins,
so anything the built-ins can do, yours can too.

## The contract

Implement `Connector` from `@cotal-ai/core` and self-register it on import:

```ts
import { registry, type Connector } from "@cotal-ai/core";

const myConnector: Connector = {
  kind: "connector",
  name: "myagent",                       // the --agent value; must be unique, never "cotal"
  requires: ["myagent"],                 // external CLIs the launch needs on PATH (preflighted)
  buildLaunch(opts) {                    // opts → the process + env that joins the mesh
    return {
      command: "myagent",
      args: ["--serve"],
      env: { /* COTAL_* wiring from opts */ },
    };
  },
  // optional: listModels, supportsModelVariant, supportsPrompt, supportsResume,
  // supportsSessionContinuation, supportsToolListAnnounce, eventChannel, pluginRoot
};

registry.register(myConnector);          // registration runs on import, making the connector available
```

`buildLaunch(opts)` is the whole job: given a `LaunchOpts` (space, name, role, creds, channels,
model, prompt…), return a `LaunchSpec` (the command, args, and environment) whose process connects to
the broker as that mesh node. Everything else on the interface is optional and default-deny: declare
`supportsModelVariant`/`supportsPrompt`/`supportsResume`/`supportsSessionContinuation`/`supportsToolListAnnounce` only if you honor them (a request for one you don't declare
fails loud before any provisioning), list `requires` so a missing CLI fails with a clear message, and
implement `listModels` only if you want a selector catalog. Implement `eventChannel` only if your
session publishes a structured event plane: it names the channel the manager grants that session
publish rights on, so the grant and the subject the session publishes to come from one function
rather than two that can drift. Event planes are on by default when this method exists. A connector
that omits it refuses a launch unless the caller explicitly opts out with `--no-events` or
`events: false`. See
the `Connector` interface in
[`packages/core/src/connector.ts`](../packages/core/src/connector.ts) and the OpenCode connector in
[`extensions/connector-opencode/`](../extensions/connector-opencode/) for a complete worked example.

### Private launch files

Text the child should not see in argv, such as a persona or an MCP config that names shared servers,
goes in a private file written with `writeLaunchArtifact` from `@cotal-ai/core`, with only its path
passed to the child. Pass the same `artifacts` array to every call and return it on the `LaunchSpec`.
The launcher owns those files: the manager and the foreground `cotal spawn` remove them once they
have proved the child gone, so the child may read them at any point in its life. On a pty seat the
seat's custodian removes them when it sees the child exit, so they go even when the manager was
killed, and a launch refused before any process started removes them at once. On a runtime that
cannot stream an exit (tmux, cmux, orca, herdr) the manager polls the seat's status and waits for
the runtime's exit proof. Any other spawn that throws is not proof, so its files stay for the OS
temp reaper. Run every check that can refuse the launch, and every conversion that can throw, before the
first write. The file
is 0600 in a 0700 directory, which is OS-user isolation: any process running as the same user can
read it while it exists.

### Local listeners

A connector that carries the `cotal_*` surface over any local listener, loopback TCP or a Unix
socket, authenticates every connection with a secret the child receives through the launch
material or an environment variable and never through argv. It compares the presented secret to
its own in constant time, bounds the request body and the pre-authentication frame, and drops an
unauthenticated connection before it can reach a tool. State the same-uid limit rather than
claiming it away: a bind address is not a boundary on a shared workstation, only the secret is.
Copy one of the two shipped shapes rather than inventing a third: the Codex loopback MCP endpoint
(`extensions/connector-codex/src/mcp.ts`) or connector-core's control server
(`extensions/connector-core/src/control.ts`, exported for reuse by a sibling listener in the same
process).

## Packaging rules (enforced at `ext add`)

`cotal ext add` verifies these and fails loud otherwise, because they are what keep every extension
sharing the binary's single `@cotal-ai/core` registry instance:

- **`@cotal-ai/core` is a `peerDependency`, never a regular dependency.** A regular dep vendors a
  second copy of core. Its separate registry would swallow your `registry.register` call. The add
  would import your package cleanly, see zero contributions, and refuse it. Any other `@cotal-ai/*`
  you use is a peer too. `ext add` junction-links each `@cotal-ai/*` peer to the binary's own copy;
  lazy materialization verifies and rebinds those links for the registry-facing entry's initial import,
  so global installs and source worktrees can share the machine extension prefix. Import every host peer
  in that initial graph; launcher/child artifacts that run later must bundle their dependencies rather
  than resolving a mutable host-peer link after another Cotal process may have rebound it.
- **Bundle core as external.** If you bundle (esbuild/rollup), mark `@cotal-ai/core` (and any other
  `@cotal-ai/*`) `--external` so the runtime `import` resolves the host's copy, not an inlined one.
- **Importing the package must self-register.** Your entry (`main`/`exports`) must run
  `registry.register(...)` as a side effect of import (e.g. `export * from "./extension.js"`), so the
  lazy materialize path can bring you online without a bespoke hook.
- **Name yourself.** The connector `name` is the `--agent` value; it must be unique across installed
  extensions and must not be the reserved name `cotal`.

A minimal `package.json`:

```jsonc
{
  "name": "@you/cotal-connector-myagent",
  "type": "module",
  "main": "./dist/index.js",
  "files": ["dist"],                     // whatever `ext add` needs to install + import
  "peerDependencies": { "@cotal-ai/core": ">=0.1.0" }
}
```

## Connector lifecycle

```bash
cotal ext add @you/cotal-connector-myagent   # installs + verifies + caches its contribution
cotal spawn --agent myagent                   # or `agent: myagent` in a manifest
cotal ext remove @you/cotal-connector-myagent # gone; nothing static-imported it
```

Set `COTAL_DEFAULT_AGENT=myagent` to make it the default for a bare `cotal spawn`. Your connector
resolves through the same lazy-materialize path as the built-ins (in the CLI's launch preflight and in
the manager), so a live `cotal up` will seed nothing extra: it imports your package, reads `requires`,
and launches. For runtimes (how a node is hosted: pty/tmux/…) rather than harnesses, the same
extension model applies via the `Runtime` contract; see [define a team](define-a-team.md) and
[the CLI reference](cli.md).
