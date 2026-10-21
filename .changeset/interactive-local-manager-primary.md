---
"@cotal-ai/auth": minor
---

Add a typed trusted-host `interactiveManagerSelection: "local-primary"` runtime option to `runAuthService` and `openAuthAuthorityPlane`. It selects the genuine local Manager up front for unpinned human Manager control and refuses an unavailable local Manager without remote substitution. Explicit selectors, managed and issued instance bindings, command scopes and the absent-option default stay unchanged. The policy affects all interactive Manager control, not only ps; it adds no CLI flag or automatic up/recovery wiring.
