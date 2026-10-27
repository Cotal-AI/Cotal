---
"@cotal-ai/cli": patch
---

`cotal down` with several names now resolves each preset name to the stack member built on it, as a single name does, so `cotal down manager delivery` on a controller stack stops `stack-manager` and `stack-delivery` instead of refusing `TARGET_NOT_FOUND` on the first preset name. The receipt's target names each member with the name you gave as `requested`. A name that matches no saved definition or preset still refuses the whole set before any stop, and its message now says that name matches no saved definition or preset in the space instead of claiming a saved member has no definition.
