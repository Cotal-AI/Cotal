---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal meshes add --mode user --from <https url>` now fetches the `/.well-known/cotal-mesh` discovery document under the address it is given, as its help says. Passing the mesh's address, such as `https://auth.example`, previously fetched that URL as is, so a host serving its site there failed with the file-oriented "user-auth bundle is not JSON" refusal. A URL that already ends in `/.well-known/cotal-mesh` is fetched as given, and the consent prompt now shows the full URL it will fetch instead of only the origin. The derivation is shared with the manual-registration policy refresh through the new `discoveryDocumentUrl` export of `@cotal-ai/workspace`.
