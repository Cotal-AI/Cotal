---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

Managed agents can now serve their private tool results on static and user-mode meshes. With `cotal supervise --tool-results`, the Manager registers each incarnation's `tool-results` instance and writes a 0600 serving file. The file holds a `endpoint-serve` credential of at most 10 minutes, its grant, and the consent anchors. The Manager renews the credential at three quarters of its life on the same registration and epoch. The Claude Code session re-reads the file on every connect and consent verification. A failed or unknown renewal removes the file, so serving stops and held results are discarded. Retirement removes the file and deregisters the instance.

On a user-mode mesh the Manager asks its host through the new `tool-result-serve-authority` request on `POST /manager-service-authority`, which the auth provider implements as `issueRemoteToolResultServe`. The request carries the Manager's registration envelope. At every issue, renew and resume the host checks the authorizing actor's `supervise` scope, the current manager registration proof and serve epoch, and the target's live managed row at that lifecycle. It answers with only its current public `consents` anchor. A resumed user-mode agent re-acquires serving through `resume`, which re-registers the same lifecycle's instance at the next epoch. It fences the predecessor with verified eviction and refuses an instance that never served. A static resume with serving on still refuses.
