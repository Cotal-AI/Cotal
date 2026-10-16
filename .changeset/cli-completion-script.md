---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal completion` reports which shells have the completion stub: for each shell, whether the stub is installed, whether it matches the script this version prints, the stub file, and where `completion install` wired it in (the startup file holding its install line, or fish's completions directory). `--json` writes the report as one document and `--plain` as plain text. A stub or startup file it cannot read is reported with a warning, and the run is `partial` and exits 4. `cotal completion script <shell>` prints the stub as raw shell code.

Breaking: `cotal completion <shell>` is replaced by `cotal completion script <shell>`. The old form exits 1 with nothing on stdout, so a hand-written `source <(cotal completion bash)` loads nothing, and names its replacement on stderr. Stubs installed by `cotal completion install` keep working unchanged. See the upgrade notes for the line to write instead.

A usage error now prints the command's help on stderr with the reason, so a refused command writes nothing on stdout. `completion install` reads an install line only when it is a line of its own, not one that ends in a carriage return, ignores a relative `XDG_CONFIG_HOME`, and refuses PowerShell and unknown shells as usage errors. It reads the startup file before writing anything, so an unreadable one, a missing directory for it or a relative `ZDOTDIR` is refused with nothing changed, and a line it cannot add after writing the stub fails with exit 5, naming the stub. `writeResult` in `@cotal-ai/workspace` can report a partial read.
