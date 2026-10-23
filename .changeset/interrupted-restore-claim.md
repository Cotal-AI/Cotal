---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A `backup restore` (or `up --restore`) stopped by Ctrl-C no longer locks its root for 30 minutes without saying so. Interrupted inside its pre-commit window, it now exits 130 (143 for SIGTERM, 129 for SIGHUP) and prints its attempt id and `cotal backup recover <attempt> --yes`. The claim it leaves is stale as soon as its restore process and every broker it started are proven gone on this host, which takes seconds because each broker's watchdog stops it when the restore process exits. So that recovery, `clean restore-attempt`, or a rerun of the restore rolls it back at once. The 30-minute deadline still applies when a broker cannot be proven gone. While the claim is live, `up`, a repeated restore and `backup recover` refuse `LIFECYCLE_BLOCKED` (exit 2) and name the restore process and the deadline, rather than exiting 3 with an unknown outcome. A restore or recovery that finds the root's maintenance lock held names the pid holding it. The status and receipt hints now say `--yes`, which the apply needs, and `status` no longer offers `clean store --force` while a maintenance journal holds the store.
