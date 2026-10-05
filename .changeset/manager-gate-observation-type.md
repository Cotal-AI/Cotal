---
"@cotal-ai/auth": patch
---

The auth decisions that read a manager's gate now take `ObserveManagerGate` instead of restating its result, and `ObserveManagerGate` takes its fields from core's `EpGateState`. `authorizeRemoteManagerRenewal`, `admitRemoteRun`, `authorizeRemoteRunAttempt`, `authorizeRemoteManagerGoalIndexScan`, `authorizeRemoteManagerMaintenance`, `authorizeRemoteManagerAdmin` and `AuthorizeRemoteRetainedAgentValidationArgs` each wrote the gate's fields and state union out again, so a change to the exported type reached none of them and the typecheck stayed green. The retirement decision and the platform control view of a manager's gate also take their fields from `EpGateState`. Every decision accepts the same gates as before.
