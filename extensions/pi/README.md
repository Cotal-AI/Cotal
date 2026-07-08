# @cotal-ai/pi

The Cotal mesh as a **pi extension**. One file, three ways onto the mesh:

- **Interactive**: `pi --extension <path-to>/dist/extension.js` (plus `COTAL_*` env) — the
  real pi TUI you're typing in becomes a mesh peer: peer messages land in the session as
  user turns per the shared attention policy; the model replies with the `cotal_*` send tools
  (`cotal_dm` / `cotal_send` / `cotal_anycast`), visible as tool calls in the TUI. Set
  `COTAL_ALLOW_PUBLISH=general` (the post ACL is default-deny) or the peer declines to
  reply on channels — DMs and anycasts always work.
- **Spawned worker**: the package also registers a `Connector` (agent type `pi`), so
  `cotal spawn --agent pi` launches the operator's installed `pi` with the extension
  loaded — the real TUI in a managed pty, watchable via `cotal attach`.
- **Agents built on pi's SDK**: pi's default resource loader discovers
  `~/.pi/agent/extensions/`, so a copy there (plus `COTAL_*` env) puts default SDK
  embedders on the mesh with no per-app work.

No pi runtime is bundled — the user's pi version, settings, auth, and other extensions all
apply. With no `COTAL_*` config in the env the extension stays inert, so a globally-installed
copy never touches normal pi sessions; `COTAL_*` config without a mesh identity
(`COTAL_NAME` / `COTAL_AGENT_FILE` / `COTAL_LINK`) fails loud rather than silently not joining.

Delivery is ack-on-surface via the package's `InboxTurn`: messages are acked only when
the turn that consumed them completes — a crash or kill redelivers. See
[docs/agent-frameworks.md](../../docs/agent-frameworks.md) for the design and the run
recipe (the `cotal` binary registers this connector, so `cotal spawn --agent pi` works
out of the box).
