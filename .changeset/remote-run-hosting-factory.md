---
"@cotal-ai/manager": patch
---

`remoteManagerClient.remoteRunHosting` builds the four signerless run callbacks (`admitRun`, `issueAttempt`, `issueOperator`, `renewRun`) from a manager's registration and a caller-supplied transport. `cotal supervise` and the remote continuity suites now both use it. The suites used to spell the four run requests a second time, so a change to the shipped requests could not fail them. Behavior is unchanged.
