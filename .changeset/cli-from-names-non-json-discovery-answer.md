---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal meshes add --from` and the manual-registration policy refresh now refuse a fetched discovery document that is not JSON with the URL and the content type that answered, for example a catch-all route serving `/.well-known/cotal-mesh` as `200 text/html`. They used to print the `--user-auth-file` sentence, which named neither and told the operator to re-export a file. JSON served under any content type is still accepted, and `--user-auth-file` keeps its sentence.
