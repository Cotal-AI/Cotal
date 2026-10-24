---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`space add`, `meshes add` and the `meshes add` prompt refuse a broker URL with a user name or password in it in the words every command uses for such a `--server`, with the same next step: name the broker URL without `user:password@`, and pass the credential with `--creds`, a login or the space's own trust. Before, a connection bundle's server and a typed address were refused with an older sentence and no next step. A value that does not parse as a broker URL is no longer echoed in part when it carries a user name.
