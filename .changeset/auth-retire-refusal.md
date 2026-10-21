---
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Refuse `cotal actor grant` and `cotal actor revoke` plainly when the predecessor's lifecycle retirement did not run. When the auth service is not running, refuses the connection, or answers that the retirement did not run, the command now refuses (exit 2) with `DEPENDENCY_UNAVAILABLE`, `PERMISSION_DENIED`, `CONFLICT` or `UNSUPPORTED`, says the actor row was not changed, and names the recovery, usually `cotal up`. It used to report every such failure as `unknown` (exit 3). The auth service's `/interactive-lifecycle/retire` door now answers every refusal it makes before the retirement barrier, its token checks and authority head read included, with `outcome: "not-executed"`. A retirement request that may have reached the barrier, such as a timeout or an error answered without that outcome, stays `unknown`, now with its own reason.
