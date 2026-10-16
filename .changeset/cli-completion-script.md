---
"cotal-ai": minor
"@cotal-ai/cli": minor
---

`cotal completion` reports which shells have the completion stub: for each shell, whether the stub is installed, whether it matches the script this version prints, the stub file and the startup file that loads it. `--json` writes the report as one document and `--plain` as plain text. `cotal completion script <shell>` prints the stub as raw shell code.

Breaking: `cotal completion <shell>` is replaced by `cotal completion script <shell>`. The old form exits 1 with nothing on stdout, so a hand-written `source <(cotal completion bash)` loads nothing, and names its replacement on stderr. Stubs installed by `cotal completion install` keep working unchanged. See the upgrade notes for the line to write instead.
