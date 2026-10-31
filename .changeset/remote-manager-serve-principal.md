---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Share remote-manager serve-principal serialization through the existing owner/actor token validator. Auth checks derive principals with the new remoteManagerServePrincipal helper; registration and retirement APIs preserve their supplied serve actor and serialize it with principalKey.
