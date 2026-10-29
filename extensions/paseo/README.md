# @cotal-ai/paseo

The [Paseo](https://paseo.sh) integration: a thin driver over the local Paseo daemon plus a
self-registering `paseo` `Runtime` provider. Importing it registers the runtime with the core
`Registry`, so the manager can spawn agents into Paseo workspace terminals, where you can watch and
steer them from the Paseo desktop and mobile apps.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); depends on the
published [`@getpaseo/client`](https://www.npmjs.com/package/@getpaseo/client) SDK; self-registers
on import.

Requires the `paseo` CLI (`npm i -g @getpaseo/cli`) and a running local daemon (`paseo daemon start`);
verified against Paseo 0.14.0. `PASEO_HOME` selects the daemon instance, `COTAL_PASEO_BIN` names the
CLI, and a password-protected daemon needs `PASEO_PASSWORD`, as for the Paseo CLI.

## What it does

- Finds the local daemon with `paseo daemon status --json`, then holds one SDK connection to it.
  `PASEO_HOST` is ignored: the launcher script lives on this host, so the terminal must too. A
  daemon that listens on a Unix socket is refused by name, because Node's WebSocket cannot reach it.
- Opens a terminal named `cotal-<name>` in the Paseo workspace for the launch `cwd`, opening that
  workspace when Paseo has none for it yet. The terminal's process is a private Node launcher
  (`0600`, in a `0700` directory) that holds the launch env and credentials and deletes itself as it
  loads, so nothing secret reaches the terminal or its scrollback.
- Paseo drops a terminal once its process exits, so a terminal listing taken after the terminal
  existed and lacking it is the exit evidence. `status()` reads a census the SDK refreshes in the
  background and never waits on the daemon; a census that cannot be taken never reports an exit.
- The startup confirm watch reads the terminal's screen through the same connection, so a harness's
  startup dialogs are answered within the startup bound even on a loaded host.
- Graceful stop types `/exit`, then kills the terminal after two seconds. Hard stop kills it at once.
  Interrupt sends `C-c`. A terminal that could not be created, or a seat the startup watch stopped,
  reports that reason as its exit diagnostic; Paseo reports no exit code.
- Contributes a `Runtime` only. Watching is native: open the terminal in the Paseo app rather than
  `cotal attach`.

## Usage

```bash
cotal ext add @cotal-ai/paseo
cotal supervise --runtime paseo
```

The runtime can also be selected with `runtime: paseo` in a mesh manifest.

## Testing

`pnpm smoke:paseo:live` exercises the driver and runtime against the local daemon.
`pnpm smoke:paseo-e2e:live` runs the complete operator journey against a live daemon and Claude
Code: install this package with `cotal ext`, launch a `runtime: paseo` manifest, observe the agent
through `cotal ps`, retire it with `cotal down --with-agents`, and remove the extension.
