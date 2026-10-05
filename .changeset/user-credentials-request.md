---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

`@cotal-ai/core` now exports `UserCredentialsRequest`, the one request type `AuthProvider.userCredentials` takes. The reference provider uses it for both the local and the remote client arm: the remote arm takes the request object instead of each coordinate as a positional parameter, and both arms send the `/exchange` body from one builder. A coordinate can no longer reach one arm's exchange body and miss the other's, and two coordinates of the same type can no longer be swapped at the remote call. The exchange body on the wire is unchanged.
