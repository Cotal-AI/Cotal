---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal setup` takes four inputs: the destination (`--destination local|self-hosted`), the application (`--harness`), the project folder (`--project`) and the space (`--space`). On a terminal it asks for each one no flag gave, shows the answers before it writes, and offers Save, Change and Cancel; Cloud is listed as in development and cannot be chosen. Without a terminal, or with `--yes`, `--no-input` or `--json`, every input is a flag and a missing one is `USAGE_INVALID` before anything is written; `--destination cloud` is `UNSUPPORTED`. A local space is prepared as `cotal space create` prepares it; a self-hosted space is one registered here whose root is the project, or one `--connection-file` registers. Setup seeds the default persona into the project's `.cotal/agents`, records the application as the space's `harness` preference, runs that application's own setup actions, and writes one envelope with `--json` listing every file it wrote. A rerun with the same answers is a no-op. An application whose executable is not on PATH leaves the rest saved and exits 4. `--configure-only` is accepted and is the default. `recordPreparedSpace` in `@cotal-ai/workspace` returns the file it wrote, and `meshFile` names a space's registry file.

Breaking: `cotal setup --yes` without the four inputs is refused, setup sets up one application rather than every detected connector, and a repeat setup no longer prints a status card (`cotal status` reports the same state). See the upgrade notes.
