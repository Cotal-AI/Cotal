---
"@cotal-ai/manager": patch
---

The manager's turn relay now keys each turn by its caller and goal id, the identity the goal plane stores it under. A second caller that submitted a `turn` under a goal id another caller had already used was refused as "accepted under a different submission" although its own goal did not exist. Each caller's turn now gets its own acceptance and its own deadline hold. A seat still yields by goal id alone, so the manager refuses to hand one seat a second caller's turn under an id that seat already holds. A turn left pending across the upgrade restart is not adopted, because its deadline hold was minted under the old token; the run still ends it at its own deadline.
