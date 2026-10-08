---
"@cotal-ai/manager": patch
---

The manager's remote requests now take their `identities` record from one function, `publicIdentities`, instead of nine hand copies. Seven of the copies built the record from the identity state's own keys behind a type cast, so a change to the identity set still compiled there and sent a record the host refuses, and a state with its keys in another order sent identities that the manager's own result checks would not match against the host's echo. The function names the five identities in the order the host echoes them, so a change to the set now fails to compile at that one place.
