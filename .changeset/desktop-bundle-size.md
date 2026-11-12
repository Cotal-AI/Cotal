---
"cotal-ai": patch
---

Shrink the Cotal desktop app bundle by over 80 MB across macOS, Linux and Windows. Desktop runtime staging now prunes build-only source maps, TypeScript declarations, Windows PDB symbols, package test trees, duplicate non-runtime package outputs and the local `nats-server` binary before sealing `desktop-runtime.json`, strips debug and local symbols from the bundled Node and Tauri binaries, verifies every `@cotal-ai/*` package import, CLI command `--help`, `daemon status` and native `.node` addon in `check-runtime.mjs`, and enforces installed and installer size budgets in the desktop build workflow.
