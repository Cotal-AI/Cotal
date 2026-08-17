# Authoring a connector

> **Reference**: describes the TypeScript reference implementation, not the wire contract. · **For:** integrators adding a new agent harness · **Wire contract:** [SPEC](../SPEC.md)

A **connector** teaches Cotal how to launch one agent harness (Claude Code, OpenCode, your own) as a
mesh node. Connectors are ordinary [extensions](cli.md#ext): you publish an npm package, the operator
runs `cotal ext add <your-package>`, and it plugs in exactly like the first-party connectors,
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
  // optional: listModels, supportsModelVariant, supportsResume, transcriptChannel,
  //           eventChannel, pluginRoot
};

registry.register(myConnector);          // runs on import — that's what makes it "plug in"
```

`buildLaunch(opts)` is the whole job: given a `LaunchOpts` (space, name, role, creds, channels,
model, prompt…), return a `LaunchSpec` (the command, args, and environment) whose process connects to
the broker as that mesh node. Everything else on the interface is optional and default-deny: declare
`supportsModelVariant`/`supportsResume` only if you honor them (a request for one you don't declare
fails loud before any provisioning), list `requires` so a missing CLI fails with a clear message, and
implement `listModels` only if you want a selector catalog. Implement `eventChannel` only if your
session publishes a structured event plane: it names the channel the manager grants that session
publish rights on, so the grant and the subject the session publishes to come from one function
rather than two that can drift, and `--events` refuses a connector that does not implement it. See
the `Connector` interface in
[`packages/core/src/connector.ts`](../packages/core/src/connector.ts) and the OpenCode connector in
[`extensions/connector-opencode/`](../extensions/connector-opencode/) for a complete worked example.

## Packaging rules (enforced at `ext add`)

`cotal ext add` verifies these and fails loud otherwise, because they are what keep every extension
sharing the binary's single `@cotal-ai/core` registry instance:

- **`@cotal-ai/core` is a `peerDependency`, never a regular dependency.** A regular dep vendors a
  second copy of core, whose separate registry would swallow your `registry.register` call — the add
  would import your package cleanly but see zero contributions and refuse it. Any other `@cotal-ai/*`
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

## Install, use, remove

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
