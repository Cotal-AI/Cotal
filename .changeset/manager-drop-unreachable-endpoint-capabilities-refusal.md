---
"@cotal-ai/manager": patch
---

The manager no longer carries a static-spawn refusal for `endpointCapabilities`. The check read the field through a cast because no spawn request type declares it: launch specs and roster files reject the key, the served `spawn` contract does not accept it, and the control-plane `start` op does not copy it, so no spawn could reach the refusal. A change that lets a spawn carry endpoint capabilities declares the field on the spawn options and adds the static refusal against it in the same change.
