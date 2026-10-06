---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/auth": minor
---

`remoteManagerClient.remoteManagerAuthorityRequest` takes an operation's coordinates as one named object instead of trailing positional arguments, and `remoteManagerRegistrationProof(owner, registration, contractArtifacts?)` computes the registration proof from the manager's identity coordinates instead of a request built with a placeholder proof. The proof digest and the wire request are unchanged.
