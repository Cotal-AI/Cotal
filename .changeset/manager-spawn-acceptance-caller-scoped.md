---
"@cotal-ai/manager": patch
---

The manager now keys each spawn acceptance by its caller and goal id, the identity the goal plane stores the goal under. A second caller that submitted a `spawn` under a goal id another caller had already used was refused as "accepted under a different submission" although its own goal did not exist. Each caller's spawn under that id now gets its own acceptance, and a retry is served the acceptance of the caller that sent it.
