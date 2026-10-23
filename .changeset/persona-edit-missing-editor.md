---
"@cotal-ai/cli": patch
---

`cotal persona edit` with an editor the shell cannot find or run now refuses with `DEPENDENCY_UNAVAILABLE`, exit 2, as it does when no editor is set. It failed with `OPERATION_FAILED`, exit 5, and "editor exited with status 127", with no next step. The refusal names the editor and says to set `VISUAL` or `EDITOR` to an installed editor or run `cotal config set editor vim`. It also notes that the value runs as a shell command, so a path that holds spaces needs quotes. An editor that runs and exits non-zero still fails as before.
