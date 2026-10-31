---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Move the manager control calls from `@cotal-ai/cli` into `@cotal-ai/workspace`, exported as `@cotal-ai/workspace/control`: the requests to a space's manager and their typed replies (`askManager`, `scatterManager` and the registry reads beside them), the seat lookup that pins a targeted verb to the manager hosting the seat (`locateSeat`), and the console's control helpers (`control`, `controlPs`, `deleteChannel` and the managed-row poller). A caller passes a `ControlClient` that supplies its own version wording and roster read, so the library never imports CLI code. `staleStoreHint` and `nativeEndpointRefusal` move to the `@cotal-ai/workspace` root with it. Every command that calls the manager behaves as before.
