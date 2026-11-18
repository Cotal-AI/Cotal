---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Self-updates refuse incompatible Node and npm versions before replacing the installed CLI.
The updater resolves the target CLI and installed first-party extensions in a disposable prefix with npm engine checks enforced, without running install scripts. Installation guidance requests the latest release explicitly and explains recovery from old releases selected on Node 20.
