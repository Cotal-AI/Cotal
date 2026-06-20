# @cotal-ai/connector-hermes

## 0.4.0

### Patch Changes

- Updated dependencies [878f406]
  - @cotal-ai/connector-core@0.4.0

## 0.3.2

### Patch Changes

- @cotal-ai/connector-core@0.3.2

## 0.3.1

### Patch Changes

- c74007a: connector-hermes: Docker-aware install, and stop leaving duplicate sidecars.

  `npx @cotal-ai/connector-hermes install` now finds Hermes on its own: `hermes` on PATH (host),
  else a running Hermes container (copy the plugin into the bind-mounted `HERMES_HOME` or `docker
cp`, rewrite a loopback `COTAL_SERVERS` to `host.docker.internal`, and `plugins enable` inside the
  container), else `--target-home <path>` for a files-only placement. `uninstall` is symmetric and
  removes only the `COTAL_*` keys it manages.

  The standalone sidecar now watches the exact pid of the gateway that launched it
  (`COTAL_PARENT_PID`) instead of a racy parent-pid check, so the official image's transient boot
  gateway no longer leaves an orphan sidecar advertising a phantom peer. Also resolves Node from
  PATH or the bundled `<HERMES_HOME>/node`, and ignores the host's extra tool-call kwargs so the
  `cotal_*` tools stop erroring.

  - @cotal-ai/connector-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [df8e64c]
  - @cotal-ai/connector-core@0.3.0
