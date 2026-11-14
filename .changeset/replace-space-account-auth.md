---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
---

A host can replace one space's account record without rewriting the broker record every space shares. `replaceSpaceAccountAuth(store, record)` in `@cotal-ai/workspace` puts that space's account record through a `SecretStore` and writes no other key, for persisting a data signing-key rotation or rolling one back. It replaces an existing record only: it refuses when the broker record or the account record is missing, blank or outside the broker's chain, and when the replacement is another account, was issued by another operator, or holds a signing seed its claim does not trust. A record equal to the stored one is not written again, and after a write the record is read back. It is not atomic across keys, so the host must keep other writers of the space's trust records out for the call. `validateSpaceAccountAuth(broker, record, space?)` in `@cotal-ai/core` is the check it uses: the account checks of `validateSpaceAuth` for any space on a broker, where `validateSpaceAuth` accepts only the space the operator is named for.
