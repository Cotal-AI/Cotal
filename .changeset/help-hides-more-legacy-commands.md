---
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

`cotal help` no longer lists eight more legacy commands, and completion no longer offers them: `join` (`chat` replaces it), `endpoints` (`who --all`), `describe` and `invoke` (`endpoint describe` and `endpoint invoke`), `console` (`watch`), `topology` (`team check --graph`), `clean` (`reset`, `history clear` and `backup cleanup-fallback`) and `actor` (`auth grants`, `auth grant` and `auth revoke`). Each still runs and keeps its own help page. The `supervise` entry's one-line summary no longer repeats its flag list; `cotal help supervise` lists the flags.
