---
"@cotal-ai/cli": patch
---

Observe before writing: no seed store rewrite during parse, validation or a dry run

`runCli` ran the connector-seeding boot gate before command lookup, flag parsing and the command
body, so a newer staged binary invoked as `cotal down --preserve-state --dry-run` against a live
older deployment rewrote the operator-global seed store, manifest and npm prefix to the new version
and only then printed the usage refusal for the unsupported flag combination. No service stopped,
yet the operator's next command from the older CLI failed on version skew: the machine was migrated
by a run that refused to do anything. A `--dry-run` invocation now skips the auto-reconcile, so a
run that promises to plan and print writes nothing, whether it goes on to render a plan or to
reject the invocation.

`executeUpdate` had the same shape one level down. `reconcileCurrent` ran `runSeed({force: true})`
before `reportRunningManager`, so `cotal update --self` rewrote the store before it had read whether
a manager was running or which mesh was the target; on a machine whose mesh predates this release's
authority stores the run then failed its running-manager continuity check with the store already
rewritten. The continuity check is a pure read of the running manager and the selected target, and
now runs first: a failed or legacy verdict refuses with the seed store untouched.
