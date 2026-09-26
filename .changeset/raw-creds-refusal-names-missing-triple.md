---
"@cotal-ai/workspace": patch
---

A raw `--creds` control call (`cotal ps`/`stop`/`attach` with a credential file) is refused for the reason that actually applies: the invocation carries no endpoint-caller triple and that route cannot mint one. The refusal names the missing triple (owner, actor, lifecycle uid), says minting the file again changes nothing, and points at the routes that mint the one-shot instrument (the mesh's project folder, or `--space` against the registry entry). It no longer claims the file predates the v0.4 control surface, which was inferred from the missing triple alone and never read from the credential.
