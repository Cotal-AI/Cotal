# Bubblewrap runtime

A Linux runtime for untrusted user-auth seats. Install with `cotal ext add @cotal-ai/bubblewrap`
and select `--runtime bubblewrap` on a participant manager. Set `COTAL_BUBBLEWRAP_ROOTFS` to a
credential-free root filesystem with `/usr/bin/cotal`, installed connectors, harnesses and their
libraries. The root must not be group- or world-writable and must contain the mountpoints `/proc`,
`/dev`, `/home`, `/run`, `/tmp`, `/scratch` and `/workspace`.

The adapter passes only a scoped lifecycle handoff and persona through pipes. It mounts the image
read-only and creates private memory-backed directories. It inherits no host environment and mounts
no manager files or host sockets. Unprivileged user namespaces and `/usr/bin/bwrap` are required.
Local static-auth launches, host working directories, carried sessions, shared local MCP servers
and terminal attachment are unsupported. Unsupported configurations fail without a same-user fallback.

The image and its configuration are trusted. Do not put operator authority in it. The adapter
shares the host network to reach the broker and model provider. Protect host network services
separately. It does not isolate model credentials from the seat using them, promise kernel exploit
resistance, or persist the workspace after exit.

`pnpm --filter @cotal-ai/bubblewrap test` checks the real native namespace and fail-closed inputs.
`pnpm smoke:bubblewrap-launch` exercises real manager enrollment and the shipped foreground CLI
with a model-free connector. Fixtures and logs are retained under the configured temporary root.
