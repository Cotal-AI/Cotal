---
"@cotal-ai/auth": patch
---

Which manager-service operations are renewals is now one `isRenewal` guard in the manager authority. The request parser's account and process-epoch binding, the renewal authorization, the issuer's authorization requirement and its closed credential-set check all call it, where each used to spell the two operation names by hand. The auth service now re-checks the manager gate once for both renewals before it signs, where each renewal arm carried its own copy of that check. A renewal whose gate moved after authorization is still refused as `conflict`, and the message now names the operation (`manager-service renewStandingBundle gate moved before issuance`). Behavior is otherwise unchanged.
