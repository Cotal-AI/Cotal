# Two-home upgrade matrix integration

`automatic-update-two-homes.mjs` exports `twoHomeUpgrade({oldDirectory,targetDirectory,root})`. It installs two hash-verified normal candidate closures into one shared POSIX prefix. Homes A and B have separate HOME/COTAL_HOME/XDG directories. No seed skip or inherited COTAL controls are used.

The full cell has three serial routes:

- `up`: A updates the CLI, read-only B version output remains stale, then B's ordinary up reconciles its selected built-ins.
- `launch`: B starts broker/delivery without a Manager. After A updates, B's first foreground fixture launch reconciles and joins the real broker.
- `old-manager`: B keeps an actual old Manager. Installing the exact target is setup, not self-update admission evidence. B's foreground launch must safely reconcile the newer selected graph and launch the old fixture through the explicitly pinned old Manager. Its served version, instance, PID and native birth must remain unchanged.

Use a modern source candidate, such as A 0.166.0 and target 0.166.1000, for the retained Manager launch. A legacy source with a membership barrier is not evidence for this route. A refusal is a failure here, not successful exclusion coverage.

The selector receipt is addressed by the actual installed bin's resolved logical entry and exact candidate version. Its private record and real private ancestors must match that identity. A missing old selection means canonical legacy state, not permission to exempt canonical mutation. The target selection is mandatory. Invalid records, unsafe directories and unsupported selection contexts cannot qualify safe isolated reconciliation.

Each route records sorted file hashes and literal symlink targets for the canonical seed/extensions graph and old selected graph before and after. The canonical graph may be empty when the source already selects an installed-release graph. Both snapshots must remain identical while the distinct newer selected graph reaches the target inventory. The fixture resolves its core from the old selected connector's peer graph before replacement, rather than importing the overwritten shared CLI core.

Raw command receipts include authenticated read-only managerStatus probes, read-only version inventories, selected records, graph rows and join receipts. The strict grader requires all three routes, the selected-root and old-graph checks, successful ordinary commands, both fixture joins, old Manager identity preservation, no recovery obligation and confirmed public down. A focused route returns acceptance:false. Source and target artifact bindings and harness file hashes remain available to the workflow grader.

## Qualification

This change updates test source and expectations only. It has not been executed as part of this editing task. Earlier receipts expecting LIFECYCLE_BLOCKED do not qualify the revised contract. Static tests and workflow wiring are source proof, not hosted qualification. Release qualification still requires full real candidate runs on disposable native Linux and macOS runners with artifact and harness hashes bound by the workflow.

The coordinator must verify the candidate's connector peer layout, stackManager status shape, authenticated managerStatus compatibility, native birth lookup and old fixture launch against the actual source release. All fail closed. The snapshot intentionally includes all seed/extensions entries, including any remaining lock records, so unexpected background writes fail rather than being hidden. No product guard, workflow, plan or release census is changed here. Canonical guard and invalid-selector security coverage remain separate required product checks.
