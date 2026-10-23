---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Lead a signed-in Cloud user to the spaces they can use. `cotal login` lists the spaces its catalog
discovered and names `cotal use <name>`. A space registered from elsewhere that refuses an ungranted
account now answers with those discovered spaces, or with `cotal sync` when there are none, instead
of the operator's `cotal actor grant` command, which only the space's operator can run. The root that
holds the space's grant ledger still prints that command. `credentialFailure` takes an optional
remedy, which a structured command reports as `error.remedy`.

A failing space catalog warns once when it starts failing and stays quiet while the outage lasts;
`cotal status` and `cotal sync` still report it, and a command aimed at one of its spaces still
refuses. A failed `AuthSpaceCatalogResult` carries `ongoing: true` when it continues an earlier
failure.

`cotal setup` no longer calls Cloud in development: `--destination cloud` and the terminal choice say
to sign in with `cotal login` and set the space up as self-hosted. A scripted run with missing flags
prints the error, the missing flags and the scripted form without the full command help.
