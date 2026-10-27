---
"@cotal-ai/cli": patch
---

`cotal stop <name>`, `cotal attach <name>` and `cotal input <name>` no longer ask which manager to use on a user-auth mesh where several of your managers are live. They read each of those managers, as `ps` does, and run on the one that holds the name without asking. A name that no manager holds is refused `TARGET_NOT_FOUND`, naming the managers searched, when every manager answered. When some did not answer, a terminal is asked among those managers only, and the question says the name was not found on the ones that answered. A name held on more than one manager is asked about among those managers, on any mesh, where it used to go to the first one found. Without a terminal, or with `--json`, these cases refuse with the managers in the envelope and a Next that gives the command again with `--on` for each. `--on` still pins the manager and skips the search, and the spawn question is unchanged.
