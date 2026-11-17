# Two-home upgrade matrix integration

`automatic-update-two-homes.mjs` exports `twoHomeUpgrade({oldDirectory,targetDirectory,root})` and has a CLI taking two normal guarded 24-package closure directories plus a new private root. It installs the old closure through npm into one shared prefix and gives homes A/B separate HOME/COTAL_HOME/XDG directories. No seed skip or inherited COTAL controls are used. Both targets are hash-verified by the existing candidate registries.

The full cell has three serial routes with one prefix reused:

- `up`: A updates the installed CLI, B remains stale in read-only version output, then B's ordinary up reconciles all built-ins and serves a real Manager.
- `launch`: B starts broker/delivery only and registers a no-sign-in fixture connector. A updates, B's first foreground agent launch reconciles then joins the real broker and retires its credentials on exit.
- `old-manager`: an actual old Manager remains running in B. Exact target installation is explicit setup, not counted as successful self-update admission. Automatic B spawn must refuse LIFECYCLE_BLOCKED, preserve manifest bytes, start no seat and leave the old Manager answering. Explicit update admission is tested by the separately owned retained-reconciliation cell.

Each route ends with confirmed public down. The strict evidence grader `automatic-update-two-homes-evidence.mjs` rejects missing routes, nonzero ordinary commands, missing no-sign-in join, unsafe old-Manager migration, skipped assertions or missing cleanup. A focused route run deliberately has acceptance:false.

## Registration

Add this as a required configured POSIX candidate-to-next family for Linux and macOS in `upgrade-matrix-plan.mjs`, `.github/workflows/automatic-update-platforms.yml` and the baseline/candidate paired evidence dispatch. It is not a fresh-install cell or native-service-only cell. Required evidence is A/B exact installed versions, both home-specific built-in inventories, real up and seat join, old-Manager unchanged inventory/answering proof, and confirmed owned-stack cleanup. Include the new scripts in artifact source identity and strict summary verification.

PR7177 currently adds the foreign-install pair and changes the required census from40to42. Its author owns that pending integration, so this change adds the independent callable and grader without silently editing their branch/census. Register two new POSIX coordinates after7177 integration, or in an explicitly ordered combined tree, and update census tests together. A successful local callable run is not proof that CI invokes it. Release-matrix qualification and selected-retention compatibility are required before this update-path PR merges.

## Latest local observation

Exactfixed product b78abfacab normal24pack0.165.1004 vs unchangedmain e61f normal24pack0.165.1003: full callable completed64/64, strictgrader acceptance:true/routes3, resultSHA256aa2a8bcd4cdf55be552d82bef6210146f7fceca7ef55d61e63ec42d05e57e582. This is Linux actual public CLI/broker/Manager acceptance, not macOS hosted proof or workflow wiring acceptance. Before changing runtime behavior, authenticpublic162→currentmain showed normalBup/launchalreadyautoreconcile but wrongselfhint and unsafeoldManagerautowrite. Those distinctions are preserved.
