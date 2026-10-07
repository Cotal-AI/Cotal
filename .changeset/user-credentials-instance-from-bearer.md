---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/workspace": minor
---

`AuthProvider.userCredentials` no longer returns `managerInstanceId`. A `manager-caller` credential's instance is the signed `act.managerInstanceId` claim in its bearer, the one `userViewAuth` checks. The reference provider copied the exchange response's field beside it, and nothing compared the two, so a provider whose result named a different instance than its bearer satisfied the contract while the CLI used the bearer's. `userViewAuth` also decodes each minted bearer once, through one typed decoder, where the manager-caller check read a second untyped decode.
