---
"cotal-ai": patch
---
Keep daemon-hosted Manager status checks within the CLI connect rate limit during updates.

The daemon now retains one instance-pinned control session per live hosted Manager, coalesces concurrent status refreshes for the same space, and backs off for five seconds after a failed control exchange. If a status probe is still rate-limited, the daemon preserves any earlier observation of that child instead of resetting an answering Manager to starting.
