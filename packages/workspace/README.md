# @cotal-ai/workspace

The machine-local workstation layer over `~/.cotal`: the mesh registry, target resolution,
preflight, on-disk auth-path I/O, and the command-copy renderer. It is operator tooling, kept
separate from the wire protocol in [`@cotal-ai/core`](../core).

It also ships prebuilt Windows binaries that read a process's creation identity; see
[native/README.md](native/README.md).

**Tier:** `packages/`. Depends on core; not part of the wire standard.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules.
