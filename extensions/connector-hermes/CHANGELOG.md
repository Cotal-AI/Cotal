# @cotal-ai/connector-hermes

## 0.8.0

### Patch Changes

- @cotal-ai/connector-core@0.8.0

## 0.7.0

### Minor Changes

- a6a0a8d: feat: agent orientation, spawn-from-anywhere, live space graph, model-aware spawning

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays 0.2.

  **New**

  - **`cotal_orientation`** — a self/context card MCP tool: an agent's identity, the channels it can
    read and post to, its capabilities, available tools, and who's present. Claude Code, OpenCode, and
    Hermes connectors all point new agents at it on boot for the same first-turn orientation.
  - **Spawn from any directory** — `cotal spawn` resolves a running mesh from a registry, so agents can
    be spawned outside the project directory. The registry self-prunes space-mismatched and stale
    `current` entries; its dir is locked to `0700` so space names aren't world-readable.
  - **Model- and harness-aware spawning** — `cotal start --model` overrides the model, the harness CLI
    is preflighted before spawn, and the harness/model knobs are shared across both spawn doors (CLI
    `cotal spawn` and MCP `cotal_spawn`).
  - **Live space graph** — a force-directed graph view of a space in the web UI, backed by
    broker-sourced authoritative channel membership (offline agents drop from the graph immediately).

  **Fixes & hardening**

  - **Manager persona spawn is fail-loud and ACL-correct.** A spawn (`start` op / `cotal_spawn` /
    roster boot) now treats its argument as a persona ref (a filename in `.cotal/agents`), takes the
    mesh identity from the file's `name:` (auto-numbered on collision), fails loud on a missing persona,
    and always provisions read/post ACLs from the loaded persona. Previously a miss silently minted
    default creds (read `general` only, default-deny publish, no capabilities), so a persona spawned by
    display name, a typo, or a renamed file became a live agent with silently-wrong ACLs.
  - **Mesh-connect resolution unified** — `web`/`console`/`join` (and the transient commands) route
    through a shared `resolveMeshTarget` + preflight: the recorded server/mode is honored (open ≠ auth),
    the `--server`+`--space` raw escape works again for open remote meshes, the `channels` subcommand is
    validated, and a silent wrong-mesh fallback is refused rather than connecting to the wrong broker.
  - **`cotal web` no longer holds the account signing seed.** The dashboard used to keep the space
    `SpaceAuth` (which can mint _any_ identity/role) in scope for the whole session, re-minting on every
    channel delete — a compromise of the loopback process could mint anything for the account. It now
    pre-mints one scoped `manager` cred at startup for the lone write path (channel delete) and lets the
    seed fall out of scope, shrinking the blast radius from "mint anything" to "purge channels as one
    manager". Open / `--creds` modes are unaffected (no seed; they use the connection creds).

### Patch Changes

- Updated dependencies [a6a0a8d]
  - @cotal-ai/connector-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [ba5e622]
  - @cotal-ai/connector-core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [58f2d41]
  - @cotal-ai/connector-core@0.5.0

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
