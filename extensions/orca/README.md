# @cotal-ai/orca

The Orca integration: a thin driver over the public `orca` CLI plus a self-registering
`orca` `Runtime` provider. Importing it registers the runtime with the core `Registry`, so
the manager can spawn agents into native Orca terminals.

**Tier:** `extensions/`. Depends on [`@cotal-ai/core`](../../packages/core); self-registers on
import.

## What it does

- Resolves the launch `cwd` to the enclosing Orca worktree with `orca worktree current --json`,
  then targets that stable worktree id for terminal creation.
- Runs the agent from the exact launch `cwd`, even though Orca terminals are attached to the
  worktree.
- Keeps Cotal launch env and credentials out of the Orca command line by writing a private Node
  launcher script, passing only `exec '<node>' '<script>'` to Orca, and deleting the launcher after it loads.
- Forces Orca CLI lifecycle calls to the local runtime by removing ambient remote-runtime selectors.
- Uses Orca terminal handles for status, interrupt, and close. Watching is native: switch to the
  Orca tab rather than `cotal attach`.
- Contributes a `Runtime` only, not a `TerminalLayout` provider for setup layouts.

Orca must open terminals with a POSIX-compatible shell that supports `exec` and single-quoted
arguments. Driver calls are synchronous because Cotal's `Runtime` lifecycle contract is synchronous;
short probe caches batch status checks and repeated launches from the same cwd.

## Usage

Install it into the published CLI:

```bash
cotal ext add @cotal-ai/orca
cotal supervise --runtime orca
```

Library composition roots can still import it explicitly:

```ts
import "@cotal-ai/orca"; // self-registers
```

The runtime can also be selected with `runtime: orca` in a mesh manifest.

## Testing

`pnpm smoke:orca:live` exercises the driver and runtime directly. `pnpm smoke:orca-e2e:live`
runs the complete operator journey against live Orca and Claude Code: install this package with
`cotal ext`, launch a `runtime: orca` manifest, observe the agent through `cotal ps`, then shut down
and remove the extension.
