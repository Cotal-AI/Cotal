---
"@cotal-ai/cli": patch
---

A manifest whose `broker.idp` does not parse as a URL is refused without quoting the value. The refusal printed whatever was typed into that field, so a mistyped IdP URL that carried a token, such as `<token>@idp.example/api/auth`, printed the token. It now reads `broker.idp is not a valid URL (Better Auth: <origin>/api/auth)`, located at `broker.idp`, and applies to `cotal topology view -f`, `cotal up -f` and `cotal spawn -f`.
