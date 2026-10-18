---
"@cotal-ai/core": patch
---

`@cotal-ai/core/browser` follows a Manager goal in the browser. `BrowserManagerCaller.followGoal` runs the stock goal follow, the same code as the root's `submitAndFollowGoal`: it subscribes to the caller's own progress subject before the single submission and reconciles through `goal-result` on the same connection, under the caller's persisted envelope id. `verifyGoalResultFact` runs the root's goal-result checks with the outcome digest computed through Web Crypto. To share the follow, `submitAndFollowGoalWith` takes the host's fact verifier, the follow moved into a module without transport-node, and the fact shape checks moved out of `endpoint-action`. The package root's `submitAndFollowGoal`, `parseGoalResultFact`, `GOAL_TERMINAL_STATES` and `epGoalProgressGrantRow` are unchanged.
