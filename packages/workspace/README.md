# @cotal-ai/workspace

The machine-local workstation layer over `~/.cotal`: the mesh registry, target resolution,
preflight, on-disk auth-path I/O, and the command-copy renderer. It is operator tooling, kept
separate from the wire protocol in [`@cotal-ai/core`](../core).

It also ships prebuilt Windows and macOS binaries that read a process's creation identity, and on
Windows run job-object process custody; see [native/README.md](native/README.md).

The shared flag module exports `parseCommaList`: absent input stays `undefined`, while supplied
input is split on commas, trimmed and stripped of empty tokens. An explicit empty value becomes
`[]`. Commands retain their own required-flag and channel validation; `none` is a literal entry.

**Tier:** `packages/`. Depends on core; not part of the wire standard.

See the [root AGENTS.md](../../AGENTS.md) for the tier rules.
