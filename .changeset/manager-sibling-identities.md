---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

A manager on an authenticated mesh now keeps its goal-writer and session-ledger identities across restarts, as it already kept its serve identity. They were minted fresh on every start, so each restart added two holders to the manager's credential family, which never drops a row, and every later re-registration verify-evicted all of them again before the manager answered on its endpoint rails. The two identities are minted on the first start into a new secret file beside the instance identity (`.cotal/auth/manager-siblings.<space-hex>.json`), published by exclusive create so concurrent first starts adopt one pair, and read back on every later start. A malformed file fails the start rather than being replaced. A family that already grew keeps its rows and is still swept on each restart, but restarts no longer add to it. `@cotal-ai/workspace` exports the `claimManagerSiblingIdentities` helper that does this.
