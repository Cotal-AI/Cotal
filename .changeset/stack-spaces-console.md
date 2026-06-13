---
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/cmux": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/core": patch
---

Spaces model, operator console, cmux onboarding, personas, and faces (PRs #15–#20).

- **cli** — a lazygit-style Ink `console` over a shared `MeshView`, plus `setup`/`supervise`/`cmux`/`demo` onboarding.
- **manager** — registry-resolved runtimes (the manager no longer depends on cmux), graceful stop, and `definePersona`.
- **cmux** — a self-registering `cmux` `RuntimeProvider` with real teardown.
- **connector-core** — `cotal_persona` and `cotal_despawn` tools.
- **connector-opencode** — an optional animated face viewer (avatar id read from the agent file's `meta.face`).
- **core** — space discovery (`listSpaces`/`deleteSpace`), a pluggable `Runtime` extension contract, `DEFAULT_SPACE`, `saveAgentFile`, and a generic `meta` passthrough bag (kept a patch to avoid force-majoring the connectors that peer-depend on core).
