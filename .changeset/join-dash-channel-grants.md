---
"@cotal-ai/cli": patch
---

`cotal join` refusals that suggest a mint command for a dash-prefixed channel now attach the channel to its grant option, so the printed command pastes and runs as issued. A space-separated `--allow-subscribe -general` reads the value as another option and `auth mint` refuses it, so the suggestion attaches it as `--allow-subscribe=-general`; plain channels keep the spaced spelling.
