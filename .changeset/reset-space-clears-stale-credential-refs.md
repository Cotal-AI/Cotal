---
"@cotal-ai/cli": patch
---

`cotal reset space` now clears the `credentialRef` of a saved service definition whose credential file this space's account issued, such as one `cotal auth mint` wrote. Before, the reference was kept, so the next `cotal service start` after `cotal up` ran the child with a credential the new identity rejects and reported it running. Reset reads the issuing account from each referenced file. The preview and the receipt name each service and file it clears, and the receipt says how to give the service a credential again. A file reset cannot read as a credential is left as it is.
