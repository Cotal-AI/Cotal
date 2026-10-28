# @cotal-ai/cli

## 0.116.0

### Minor Changes

- 50ee624: Cut what an idle seat costs its host, with stock build and runtime mechanisms.
  
  Every connector bundle that loads into a long-running process now ships as one-byte text. V8 holds a
  string at one byte per character only while every character is Latin-1, and a single character above
  U+00FF made each 5 MB bundle two-byte for the life of the process. The characters were em dashes and
  arrows in comments, so the bundles are built with esbuild's `--minify-whitespace`, which drops
  comments and the parentheses around a single arrow parameter, and keeps every identifier. Anything
  matching text in a built bundle sees the second part: `(e) => f(e)` now reads `e=>f(e)`. `pnpm smoke:connector-bundle-text` reads the 19 built bundles
  and fails on any character above U+00FF. Stack-trace frames keep their function names and their line
  and column numbers move, because the bundle is now fewer, longer lines.
  
  The Claude Code connector's seat is launched through a new entry, `dist/seat.cjs`, which enables
  Node's module compile cache in `~/.cotal/compile-cache` and then loads `dist/mcp.cjs`. Node's cache
  covers modules compiled after it is enabled, so the entry has to sit in front of the bundle. The
  directory is created 0700 like the rest of `~/.cotal`, whatever the launching umask was. A cache
  that cannot be opened prints one line and the seat serves without it,
  `NODE_DISABLE_COMPILE_CACHE=1` turns it off, and `NODE_COMPILE_CACHE` takes precedence and is left
  alone. `dist/mcp.cjs` remains the library entry (`@cotal-ai/connector-claude-code/mcp`) and still
  serves when run directly.
  
  The declared Node floor rises from 22 to 22.10, which is where `module.flushCompileCache()` lands,
  and every package's `engines.node` now says so. The `cotal` binary checks it at its front door and
  refuses an older runtime with the floor, the running version and the repair for how it was
  installed; the seat entry refuses before its first cache call, so an old Node gets one sentence
  rather than a `TypeError`; and the installer compares the minor version, so a host whose own Node is
  22.9 gets the pinned Node downloaded and verified instead. `node dist/mcp.cjs` still serves on an
  older runtime. Operators moving a host read
  [the upgrade note](https://github.com/Cotal-AI/Cotal/blob/main/docs/UPGRADING.md).
  
  Measured on one idle seat per arm, Node v22.23.2, paired and read at 160 s and 600 s: 41.9 MiB USS
  on the stock bundle, 35.2 with one-byte text, 26.3 with the seat entry's compile cache as well.

### Patch Changes

- 3c60b76: `cotal channel` lists a registry key whose value does not decode, with the decode error, and `readChannelRegistry` returns those keys in `undecodable`. A single-key read still resolves such a value as unset, as an endpoint's registry watch does. A later write does not replace those bytes: `cotal up`, including one whose channel seed would write the key, and `cotal channel set` or `channel defaults`, refuse with `CONFLICT` and leave the key as it is. `channel remove` removes it. A defaults value that decodes but names no delivery class is still filled.
- 352ee27: `watchMembership` delivers each membership-feed entry to its callback as a `MembershipChange` (the decoded member record or its deletion, the heartbeat's `asOf`, and one `replayed` marker closing every replay) instead of a bare tick. The web dashboard, `cotal view` and `cotal channel members --follow` copy a heartbeat into their last snapshot's `asOf` and read the feed back only on a member change; before, every heartbeat the delivery daemon wrote cost each observer a full ordered-consumer rescan of the bucket with nothing changed.
- 55f7dda: The console's Ctrl-P palette answers Enter on an action the session cannot take. A row marked `read-only` or `no control path` now hands the line to the command dispatcher, whose refusal on the status line names the missing permission (publishing, or manager control); before, the palette swallowed the key and nothing changed on screen. The action stays blocked: no picker, no spawn form, no send.
- 81a6062: A pinned fetch that the policy refuses, a target that is not https and not a loopback http literal, or an answer that is a redirect, now throws `PinnedFetchRefused` with an unmarked message. A transport failure still escapes as whatever `fetch` threw. `meshes add`, `meshes add --from` and `space add --from` tell the two apart with `instanceof` and add `✗` where they print, instead of sniffing the glyph in the message. The policy refresh no longer strips that glyph before rethrowing. A bundle whose agent-provisioning URL fails the same rule still carries `✗` on the check the front end prints, like every other bundle refusal.
- 0ff3688: A `down --preserve-state` that is refused after it stopped the delivery daemon (the manager refuses to prepare, an endpoint the manager does not manage is live, or a seat cannot be checkpointed) starts the daemon again, so the mesh it leaves can spawn, retire and join; before, the daemon stayed stopped until the next `cotal up` while the refusal read as a running, unfenced mesh. The live-unmanaged-endpoint refusal is classified (`LIFECYCLE_BLOCKED`, exit 2, with a next step) instead of an unknown outcome, and a daemon that cannot be started again is named in the refusal with `cotal up` as the remedy.
- a8a49b7: On a user-auth mesh, `cotal send`, `cotal endpoints`, `cotal personas list --running` and `cotal channels list` read the roster and the channel registry once on the user's bearer and leave no watch or scan consumer behind, as they already did on a static or open mesh. The agent profile, which the auth service mints for a user's connection, gains the batched Direct Get of the channel registry (it already carried the presence one), so an agent credential from `cotal auth mint` passed with `--creds` reads once too. A user connection an older auth service minted without that row is refused with `PERMISSION_DENIED` naming the update, never watched instead.
- Updated dependencies [3c60b76]
- Updated dependencies [2e7cdfd]
- Updated dependencies [5b85487]
- Updated dependencies [ff23d2d]
- Updated dependencies [c19eaf9]
- Updated dependencies [c8072d6]
- Updated dependencies [726cd81]
- Updated dependencies [352ee27]
- Updated dependencies [cf3218f]
- Updated dependencies [81a6062]
- Updated dependencies [ff12daa]
- Updated dependencies [fee5f39]
- Updated dependencies [a8a49b7]
  - @cotal-ai/core@0.116.0
  - @cotal-ai/workspace@0.116.0

## 0.115.4

### Patch Changes

- 445e3b6: `cotal update` and `cotal update --self` refused by a running manager's legacy custody ("this update is not a hot update") now print the next step: stop that mesh with `cotal down --space <space>`, then run the update again. Before, the verdict and the per-seat continuity classes were all the command said before exiting nonzero.
- Updated dependencies [352d94d]
  - @cotal-ai/workspace@0.115.4
  - @cotal-ai/core@0.115.4

## 0.115.3

### Patch Changes

- 4e84742: `identityUncertaintyRefusal` now accepts only a torn pin, a torn pairing, or an unpinned live pid. A match, a gone pid, a legacy record, a mismatch, or a pidfile with no pid is a compile error instead of a refusal that names the identity state as unsupported. The three refusing kinds keep their own sentences. A stop whose verification rereads the pidfile and finds no pid refuses before any signal and keeps the record.
- 7e8126b: `cotal invoke` and `cotal endpoint invoke` now say when their deadline ran out during the endpoint contract read. When the endpoint answered but the read did not finish in time, the call used to fail `OPERATION_FAILED` with "the endpoint contract read did not complete" and no Next. It now names the deadline, for example "the 100ms --timeout ran out during the endpoint contract read; no command was published", and its Next suggests a longer `--timeout`. The code, the exit status and the native `deadline-exceeded` cause in `--json` are unchanged. An endpoint nothing serves is still refused `TARGET_UNAVAILABLE`.
- Updated dependencies [4e84742]
  - @cotal-ai/workspace@0.115.3
  - @cotal-ai/core@0.115.3

## 0.115.2

### Patch Changes

- 33e6bf0: `cotal down --abandon-stop <id> --yes` run again after a successful abandon had stopped the stack refused "no member of this stack retains a stop request with that ID" and sent the operator to `cotal down --dry-run` to see what blocks the stop, or to a `cotal service status <definition> --instance <id>` command with placeholders, though nothing blocked and the stack was not running. When no member retains any stop request, the `TARGET_NOT_FOUND` refusal now says "no member of this stack retains a stop request; nothing was abandoned" and names `cotal up` as Next, or `cotal down` while the stack runs. A member that retains a different stop request still gets the refusal that names it.
- 33e6bf0: `cotal down --abandon-stop <id>` without `--yes`, given an ID that no stack member retains, such as the operation ID of the `down` that sent the stop, told the operator to rerun it with `--yes` "to give it up", and that rerun only refused `TARGET_NOT_FOUND`. The ID is now looked up first, with nothing written, so such an ID refuses `TARGET_NOT_FOUND`, naming the stop request a member retains and its `--abandon-stop` command, with or without `--yes`. An ID a member retains still asks for `--yes` as before.
- Updated dependencies [fe37cb4]
  - @cotal-ai/core@0.115.2
  - @cotal-ai/workspace@0.115.2

## 0.115.1

### Patch Changes

- f187ea2: `cotal invoke --timeout <ms>` now sets one deadline for the whole call. The contract read, a `--name` lookup and the reply all spend from it, and the default stays 10000. The contract read used to wait a fixed 10 seconds whatever the flag said, so `invoke` of an endpoint nothing serves took 10 seconds with `--timeout 1000`, and a slow contract read was cut off at 10 seconds with `--timeout 20000`. That refusal keeps its `TARGET_UNAVAILABLE` code, message and `--json` shape, and now comes when the flag's deadline runs out.
- @cotal-ai/core@0.115.1
  - @cotal-ai/workspace@0.115.1

## 0.115.0

### Patch Changes

- @cotal-ai/core@0.115.0
  - @cotal-ai/workspace@0.115.0

## 0.114.1

### Patch Changes

- 12f2b47: `cotal down --abandon-stop <id> --yes` given an ID that no stack member retains, such as the operation ID of the `down` that sent the stop, refused `TARGET_NOT_FOUND` with that ID in its fields as `Original request`, the label the `LIFECYCLE_BLOCKED` refusal over a retained stop gives the real stop request ID. The refusal now shows it as `Given ID`. Other refusals keep `Original request`, and the `--json` shape is unchanged: `target.requestId` still carries the given ID.
- Updated dependencies [12f2b47]
  - @cotal-ai/workspace@0.114.1
  - @cotal-ai/core@0.114.1

## 0.114.0

### Patch Changes

- 36cf00b: The manager and delivery process-record readers take the space and root they read first, and their test seams as one optional object last. A caller names the record it means and no longer spells both seams as undefined to reach it. A delivery cutover that names a root uses that same root for the manager's marker, its stop, and the cleanup.
- @cotal-ai/core@0.114.0
  - @cotal-ai/workspace@0.114.0

## 0.113.3

### Patch Changes

- 256f51b: After an interrupted whole-stack stop, `cotal status` named the earlier stop's operation ID in its `Stack blocked` line while its Next named the stop request ID that `cotal down --abandon-stop` takes, with neither labelled. A user who copied the ID from the sentence was refused `TARGET_NOT_FOUND` with no ID to use instead. The line now labels both, as `operation <id>` and `stop request <request-id>`, and the `up` and `down` refusals over a retained stop name its stop request ID. `cotal down --abandon-stop` given any other ID, the operation ID included, still refuses `TARGET_NOT_FOUND` and now names the stop request each member retains, with its `--abandon-stop` command as Next. The `--json` shapes are unchanged.
- Updated dependencies [d4a9361]
  - @cotal-ai/core@0.113.3
  - @cotal-ai/workspace@0.113.3

## 0.113.2

### Patch Changes

- Updated dependencies [09f2707]
  - @cotal-ai/workspace@0.113.2
  - @cotal-ai/core@0.113.2

## 0.113.1

### Patch Changes

- 51d8642: `cotal down` attributes a recorded pid through the component's own command check, and it does that at one point. A record whose identity pin names another process start is refused and kept, for the delivery daemon and the manager alike. A record with no pin whose live command is not that component's is removed without a signal, and the two stops print one line for it.
- Updated dependencies [14c4333]
- Updated dependencies [51d8642]
  - @cotal-ai/core@0.113.1
  - @cotal-ai/workspace@0.113.1

## 0.113.0

### Minor Changes

- a9cd2f5: `cotal up --recreate-issued-stores <backup-dir>` lets a mesh that ran 0.110.x or earlier start on 0.111.0 and later. Those releases refuse a space's `KV_cotal_issued_<space>` and `KV_cotal_accepted_<space>` created before bounded retention, and the remedy they named, `nats stream backup` and `nats stream rm`, needed authority no stock credential holds. On the broker that start launches, before any issuer of the space runs, the flag backs up each store created before bounded retention into a new private directory in the layout `nats stream backup` writes (0700 directories, 0600 files, readable by `nats stream restore`). It checks every backup against its stream's message count and last sequence, deletes those stores only after every check passes, and the start then creates both again in the current shape. It touches no other stream. It refuses `USAGE_INVALID` for a backup directory that exists or has no parent and with `-f` or `--restore`, `LIFECYCLE_BLOCKED` while the stack runs, and `CONFLICT` when neither store predates bounded retention. It works on static-auth, user-auth and open spaces, legacy and controller-owned stacks alike.
  
  The step is core's `removeIssuedStoresBeforeRetention(nc, { space, backupDir, inboxPrefix })`, on a connection that holds the new one-shot `issued-store-recreate` profile (`mintCreds`, 30 minutes): `STREAM.INFO`, `STREAM.SNAPSHOT` and `STREAM.DELETE` on those two streams, its own inbox, and a one-use response permission per snapshot chunk. An embedder whose spaces `cotal up` does not start runs it per space with the space's issuers stopped. `cotal auth mint` still exposes only agent, observer and admin, and `teardown` keeps its scope.
  
  `cotal up` on such a store now refuses `CONFLICT` (exit 2) instead of reporting `OPERATION_UNKNOWN` (exit 3); the broker it started is stopped again either way. The store check throws `IssuedStoreBeforeRetentionError`, and its remedy, shared by every binder, names the flag. `docs/UPGRADING.md` gains the operator sections for 0.111.0 (with what a rollback can and cannot do) and for the two 0.112.0 changes to multi-space hosts.
  
  The `deliver --spaces` ready line no longer prints an empty list as `0 space(s): ;`; it reads `0 space(s); retrying <s>`.

### Patch Changes

- 74f9058: A multi-name `cotal down` that names the broker as `broker` or `stack-broker` now gets the refusal `nats` gets: `TARGET_NOT_FOUND`, one message for each of the three names, and a bare `cotal down` as the next step, in a dry run, a stop and `--json`. On a controller stack those two names reached the saved `stack-broker` and refused `UNSUPPORTED` in stop-policy terms, with `<name>` and `<full-id>` placeholders. A saved service of your own named `nats` or `broker` still resolves as that service. A set that names another saved service running a broker still refuses `UNSUPPORTED`, now in plain words with that service's own stop filled in.
- 5c4a1f8: Wait for broker restore evidence before the up command gives up, and stage a new extension until its add is accepted.
- 29c67fe: A records-KV value that is not JSON is refused as `internal` and names its key from every reader of that bucket. `decodeRecordJson` is that decoder. The goal, checkpoint, service, lease, answer, notice, migration, lifecycle and issued-authority readers use it, and the private copies are gone, so a caller that classifies `EpEnvelopeError` no longer sees a bare `SyntaxError` for the same corruption.
  
  Presence readers share `isPresenceRow`. A row needs a non-empty `card.id` equal to its key, a string `card.name`, a known status, a finite `ts`, string display fields, and a condition that is either absent or an object with a string code. The core observer, the runtime and the CLI inventory call that guard.
- Updated dependencies [38fc031]
- Updated dependencies [c1ff7d8]
- Updated dependencies [29c67fe]
- Updated dependencies [a9cd2f5]
- Updated dependencies [41fb2de]
- Updated dependencies [f3460b3]
  - @cotal-ai/core@0.113.0
  - @cotal-ai/workspace@0.113.0

## 0.112.0

### Patch Changes

- 352c4d8: Update refuses an unsafe config ancestor before any repair, seed or binary replacement.
- fba2d23: `cotal update` no longer reinstalls a first-party operator extension that is already at the running CLI's version. When the extension is recorded at that version with the spec update installs, the extensions prefix lock records it at that version, and every package the lock records is on disk at its recorded version, the extension pass verifies it in the update process, rebinds its shared peers to this CLI's copies, and prints a verified line. Any other extension is still reinstalled in an isolated child, now after a line that says why. On a current machine each extension used to cost a full npm install on every run.
- Updated dependencies [1924ecd]
  - @cotal-ai/workspace@0.112.0
  - @cotal-ai/core@0.112.0

## 0.111.1

### Patch Changes

- 60cb0de: Bare `cotal down` refuses while a manager or delivery daemon has no pidfile and is still renewing its lease, instead of stopping the broker under it or reporting that nothing is running.
- 23ac8a6: Three help examples now run as written. The `persona create` example passes `--subscribe ""`, which a persona made from a prompt needs, and the usage marks `--subscribe` required with `--prompt` or `--from`. The `space add` examples pass `--root <dir>`, which they need outside a project. The `completion uninstall` example's note says it removes the completion file for your shell, the one `SHELL` names. A usage refusal now shows the help `--help` prints for the same words, so a refused `persona create` shows the `persona create` help instead of the `persona` help.
- 23ac8a6: `cotal manager <verb> --help` and `cotal help manager <verb>` now print one help: the verb's own summary, usage and examples, with the options the command takes. `--help` showed the service command's summary, and `help manager <verb>` listed only `--json` and `--plain` under Options while its usage named `--foreground` and `--name`. `cotal ext seed --help` prints the `ext seed` help instead of the `ext` help.
- @cotal-ai/core@0.111.1
  - @cotal-ai/workspace@0.111.1

## 0.111.0

### Patch Changes

- b5b0960: Two next steps now run as written. Bare `cotal`'s Start here row for a stack whose recorded store cap is below the floor names `cotal up --max-file-store 67108865`, with the label saying a store cap of 67108865 or more, instead of a command that ends in "or more" and fails on it; the folder note keeps its sentence. The width wrapper keeps a backticked command that starts with `cd` whole, as it already did for one that starts with `cotal`, so the manager-start refusal's `cd <folder> && cotal manager start` never breaks across lines.
- Updated dependencies [d367269]
- Updated dependencies [b5b0960]
  - @cotal-ai/core@0.111.0
  - @cotal-ai/workspace@0.111.0

## 0.110.0

### Patch Changes

- 8f00cfc: `cotal down` with several names now names a next step when one name matches no saved definition, the one a single named `down` gives: `cotal service` to list the saved definitions, or the web extension for `web`. For a broker name (`nats`, `broker` or `stack-broker`) it names a bare `cotal down`, which stops the broker with the whole stack, instead of `stack-broker`, which a set refuses. On a stack a plain `cotal up` started, `broker` among the names no longer says that no broker has been started.
  
  `cotal manager logs` after `cotal down` of a plain `cotal up`, with the manager log removed, now says the log at its path is no longer there and names only `cotal up`, when a pid record of the dead manager or the instance identity a manager keeps in the folder shows one ran. It still refuses `TARGET_NOT_FOUND`, and says no manager has been started, naming `cotal manager start` as well, only when no such record exists.
- Updated dependencies [927e512]
  - @cotal-ai/workspace@0.110.0
  - @cotal-ai/core@0.110.0

## 0.109.25

### Patch Changes

- dbfc90b: Every command's help now shows its most common uses. `cotal <command> --help` puts an Examples section right after Usage and Shorthands, before Commands and Options, and each example is a command that works as written with a short note on what it does, such as `cotal spawn -d` to launch an agent through a manager and return. Every command and subcommand `cotal help` lists has one to three. An example's command is never wrapped; its note sits beside it, or under it on a narrow terminal. A command's `examples` entry is now `{ command, note }`; a bare string is still accepted and shows with no note. `cotal manager <verb> --help` shows the manager's own examples.
- Updated dependencies [dbfc90b]
  - @cotal-ai/core@0.109.25
  - @cotal-ai/workspace@0.109.25

## 0.109.24

### Patch Changes

- 0bffcb0: In a folder that holds another space's stopped or prepared stack, bare `cotal` with a prepared or stopped selection labels the selection's `cotal up` as "Start this space" and offers no `cotal spawn`, as it does from any other folder, instead of calling it this folder's space.
  
  Bare `cotal` names `cotal up --max-file-store 67108865` or more, as `status` does, for a stopped stack whose recorded file store cap is below the floor, both in its line on what the folder holds and in Start here, instead of a bare `cotal up` that fails on that cap.
  
  A refusal in such a folder, as from `ps` or `send` while the selection is stopped, keeps the note under its heading whole, with the `cotal up` that restarts this folder's space, as `status` and the `FOLDER_SPACE_NOT_RUNNING` warning already do.
- Updated dependencies [0bffcb0]
  - @cotal-ai/workspace@0.109.24
  - @cotal-ai/core@0.109.24

## 0.109.23

### Patch Changes

- @cotal-ai/core@0.109.23
  - @cotal-ai/workspace@0.109.23

## 0.109.22

### Patch Changes

- @cotal-ai/core@0.109.22
  - @cotal-ai/workspace@0.109.22

## 0.109.21

### Patch Changes

- d9ec395: `cotal stop <name>`, `cotal attach <name>` and `cotal input <name>` no longer ask which manager to use on a user-auth mesh where several of your managers are live. They read each of those managers, as `ps` does, and run on the one that holds the name without asking. A name that no manager holds is refused `TARGET_NOT_FOUND`, naming the managers searched, when every manager answered. When some did not answer, a terminal is asked among those managers only, and the question says the name was not found on the ones that answered. A name held on more than one manager is asked about among those managers, on any mesh, where it used to go to the first one found. Without a terminal, or with `--json`, these cases refuse with the managers in the envelope and a Next that gives the command again with `--on` for each. `--on` still pins the manager and skips the search, and the spawn question is unchanged.
- @cotal-ai/core@0.109.21
  - @cotal-ai/workspace@0.109.21

## 0.109.20

### Patch Changes

- ffeaa32: `cotal manager start` on a user-auth space with no sign-in no longer launches a manager it cannot confirm. On a space the folder hosts, `manager start` and `manager restart` without a signed-in, granted login refuse `AUTH_REQUIRED` (exit 2) under a `Mesh: <space>` heading before anything is saved or launched, and Next names `cotal login`, then the command again. A manager left running without a sign-in stops: in the folder that hosts the space, `cotal manager stop` and `cotal down` read the manager's stop impact from its own local receipt, so the folder's owner needs no sign-in.
  
  `cotal supervise` refuses before it connects with exit 2, a `Mesh:` heading and a code, and writes nothing in the folder. A space whose own stack in this folder is stopped names `cotal up` there and, with `--server`, the folder whose `cotal up` started that broker. A user-auth space that another folder hosts names the folder that hosts it.
  
  The deprecation notice of `supervise` and the other deprecated daemon entries wraps at the terminal width with each command kept whole. The manager prints its boot inventory once it is up, so a refused start prints no boot line, and the line for no available connector is in plain words.
- Updated dependencies [ffeaa32]
  - @cotal-ai/workspace@0.109.20
  - @cotal-ai/core@0.109.20

## 0.109.19

### Patch Changes

- 29a824d: A foreground `cotal spawn --on <instance>` on a manager from before 0.104.2, which does not report whether its runtime streams a terminal, no longer ends `OPERATION_PARTIAL` on a runtime such as `orca` or `tmux` that has none. The CLI still finds out by attaching, and when the manager refuses that attach because the runtime streams no terminal, the launch ends with the receipt, one line naming the runtime, and exit 0. Such a manager does not mark that refusal, so the CLI accepts it only for a runtime whose provider, registered or installed with this CLI, declares no terminal. Any other attach failure after a successful launch is still partial, exit 4, and now prints the manager's reason as a `Native detail` row (`error.cause.detail` in an envelope). Its Next gives `cotal ps` and `cotal attach` with the real space and manager instance, or the runtime's own session where it streams no terminal, in place of a bare "reattach".
- @cotal-ai/core@0.109.19
  - @cotal-ai/workspace@0.109.19

## 0.109.18

### Patch Changes

- d7b0539: `cotal update` now removes group and other write from the folders and files you own in Cotal's config directory (`$XDG_CONFIG_HOME/cotal` or `~/.config/cotal`), as it already did for Cotal's install, and prints `✓ removed group and other write from <n> entries in Cotal's config at <path>`. An earlier seed run under a umask of 0002 left that directory and its extension tree group-writable. Where the private-group proof was unavailable, as under SSSD, the web seed refused them and the update failed after its install repair had run. A group-writable folder above the config directory, such as `~/.config`, is not Cotal's: `update` leaves it unchanged, the seed still refuses it with `chmod g-w <path>` as the next step, and the update still exits nonzero.
- @cotal-ai/core@0.109.18
  - @cotal-ai/workspace@0.109.18

## 0.109.17

### Patch Changes

- Updated dependencies [dc382c0]
  - @cotal-ai/core@0.109.17
  - @cotal-ai/workspace@0.109.17

## 0.109.16

### Patch Changes

- 01c21ab: `cotal team remove <id>` now removes what an incomplete `team deploy` created, such as a deployment whose agent exited on launch. Before, such an attempt stayed unsettled, and `team remove`, bare `cotal down` and every later `team deploy` refused with no way out. Removal works when the attempt's own journal records every effect: in manifest order, each channel and agent reached its accepted step or was never submitted. It then uses the guarded route of a returned deployment of the same shape. Each allocated agent is retired through the original manager by its identity and lifecycle UID, with no stop for one the manager already retired, and each card is deleted at its accepted create revision. A step submitted with no recorded acceptance, or an unreadable record, still refuses with `LIFECYCLE_BLOCKED`, now naming that step. Nothing is retried, and no attempt record is changed or deleted.
  
  An incomplete `team deploy` now names `cotal team remove <id> --dry-run` as a next step. Bare `cotal down` and a later `team deploy` that a retained deployment blocks now name the removal of each such deployment.
- @cotal-ai/core@0.109.16
  - @cotal-ai/workspace@0.109.16

## 0.109.15

### Patch Changes

- 3f8ed22: Allow update to reconcile connectors and operator extensions after a controller stack completes ordinary down, while refusing live or unresolved processes and broker listeners.
- @cotal-ai/core@0.109.15
  - @cotal-ai/workspace@0.109.15

## 0.109.14

### Patch Changes

- 60e6671: A managed Claude Code seat that stops on Claude's first-run text style picker, its login method choice or its Bypass Permissions warning now fails at the startup bound naming that screen and the step that clears it. It used to fail saying the development-channels prompt did not appear, which pointed at the wrong cause. Cotal still never answers any of these screens: the Bypass Permissions warning stays for the user to accept once, or the launch passes `--opt permission-mode=default` (`launchOptions: {permission-mode: default}` in a manifest). A launch recipe declares such screens in the new optional `LaunchSpec.confirmBlockers`. The pty, custody, tmux, cmux, Orca and Herdr runtimes send no key while one is on screen and name its reason when the bound ends there. A runtime that ignores the field fails as before, with the generic message.
  
  A foreground `cotal spawn` of Claude Code no longer passes `--permission-mode bypassPermissions`. It runs in your terminal, so Claude keeps its own permission mode and you answer its prompts there; before, it opened on the Bypass Permissions warning while the spawn's hint said to press Enter at the development-channels prompt, and Enter there exits Claude. A managed seat keeps bypass as its default, and a permission option you pass still wins in both.
  
  `cotal up -f` no longer prints a success mark for its agents. It says the stack is up and the agents' launch is pending, that it does not wait for them to join, and names `cotal ps --space <space>` and the manager's log, where a failed launch is recorded with its reason.
  
  The quickstart and the team guide now say to finish Claude's first run once before the manager launches Claude Code, and give both permission routes.
- Updated dependencies [60e6671]
  - @cotal-ai/core@0.109.14
  - @cotal-ai/workspace@0.109.14

## 0.109.13

### Patch Changes

- a8137ed: `cotal down` with several names now resolves each preset name to the stack member built on it, as a single name does, so `cotal down manager delivery` on a controller stack stops `stack-manager` and `stack-delivery` instead of refusing `TARGET_NOT_FOUND` on the first preset name. The receipt's target names each member with the name you gave as `requested`. A name that matches no saved definition or preset still refuses the whole set before any stop, and its message now says that name matches no saved definition or preset in the space instead of claiming a saved member has no definition.
  
  `cotal manager logs` after `cotal down` of a plain `cotal up` stack now reads the log that manager left, `<root>/.cotal/manager.<spaceKey>.log`, instead of refusing that no manager was started. The text says the manager is stopped, with its PID while its record still names one, and names `cotal up` under Next, and `--json` carries `recordedProcess` with `state: "stopped"` (`"running"` while it runs). `cotal service logs stack-manager` reads it the same way. With no such log the refusal names the file and `cotal up`. A plain `logs --follow`, of a service or of that manager, now ends with a sentence saying why, such as `manager is no longer running, so the follow ended.`, instead of a raw `end: {…}` JSON line; `--json` is unchanged. The `install` refusal for an adapter service now says `stack-manager runs through the manager-service adapter` instead of `is a manager-service service`, and the manager page states that `cotal manager install` gives the stack advice instead of the `ExecStart=` line only while a manager `cotal up` started with no saved service runs.
- @cotal-ai/core@0.109.13
  - @cotal-ai/workspace@0.109.13

## 0.109.12

### Patch Changes

- @cotal-ai/core@0.109.12
  - @cotal-ai/workspace@0.109.12

## 0.109.11

### Patch Changes

- e85774c: Bare `cotal service` marks a definition a forgotten space left in another folder as `inherited from <root>` in its State column, and its Next names the `cotal service remove` that forgets it rather than a start that refuses.
  
  The console palette's managed-seat suggestions name a working seat `mesh working · progress unknown`, as `:status` does, through one shared helper.
  
  With another space selected, the note in a folder whose stopped stack recorded a store cap below the floor names `cotal up --max-file-store 67108865` or more, the up that starts it, as `status --space` does, instead of a bare `cotal up` that fails on that cap.
- Updated dependencies [e85774c]
  - @cotal-ai/workspace@0.109.11
  - @cotal-ai/core@0.109.11

## 0.109.10

### Patch Changes

- e9f4793: The broker record and the user-auth pidfile template each have one name. `@cotal-ai/workspace` exports `NATS_PIDFILE`, and `cotal up`, the nats descriptor, `cotal status`, the broker service, the controller-stack checks and the `clean` sweep all take the broker record from it. The sweep takes the user-auth record from `AUTH_PIDFILE`. Renaming either constant moves every site that writes or reads that record.
- Updated dependencies [e9f4793]
  - @cotal-ai/workspace@0.109.10
  - @cotal-ai/core@0.109.10

## 0.109.9

### Patch Changes

- 841d980: A folder whose `cotal up` was interrupted before it registered the space, with its broker still running, is the target of the commands run there again when another space is selected. Since a folder's space captures those commands only while it runs, such a folder was taken for a stopped one: `cotal status` there headed with the selection and said to restart the folder's space with `cotal up`, which refuses `LIFECYCLE_BLOCKED` until `cotal down --yes` stops that broker, and `cotal ps` asked the selection. Now a folder whose own stack journal records an `up` or `down` with no outcome while a member it started still runs stays the target, as with nothing selected. `status` there reports it as `Half started` or `Half stopped` under `This folder's space`, with `cotal down --yes` and then `cotal up --root <root>` under Next for an `up` cut off before registration. `--json` names it in `target.space` and `meshes.folder` and carries no `FOLDER_SPACE_NOT_RUNNING` warning, and bare `cotal`, `ps` and the other commands there name it the same way. A folder whose stack is stopped, or whose interrupted operation left nothing running, still leaves the commands to the selection.
- Updated dependencies [841d980]
  - @cotal-ai/workspace@0.109.9
  - @cotal-ai/core@0.109.9

## 0.109.8

### Patch Changes

- 36b0c06: In a copy or a moved project folder, with another space selected, `cotal status` marked the selection in its Spaces list, then headed a `Selected space` section over the folder's records of another space, and printed no `Mesh:` line, while `ps` and `send` there refused under `Mesh: <space>`. It now reports the space the folder's records name, as those commands do: under its `Mesh:` heading and in `target.space`, marked in the Spaces list, in a `This folder` section that says what the folder holds, with the step those commands name under Next. `--json` also names the recorded folder as `selected.recordedRoot`. Bare `cotal` there named nothing the folder holds and went straight to Usage. It now says on one line what the folder holds, with that step: a copy of a controller stack, a legacy root's records and the folder that space is registered for, or records moved from their recorded folder. A refused `cotal up --server <url>` from a running legacy project's subfolder printed `Mesh: <space>` on stdout as the receipt heading and again on stderr with the refusal. The space is now checked before the receipt starts, so the heading prints once, with the refusal on stderr. `--json` is unchanged. `@cotal-ai/workspace` gains `recordsElsewhereText`.
- ac47a88: Share bounded list navigation across the console's space picker, command palette, roster, waiting rail and topology swimlane. Empty and shrinking lists keep a valid selection, and the swimlane retains its tail-following behavior.
- 51cb73b: Share pane sizing between the console roster and DM lens so their layout rules stay in sync.
- Updated dependencies [36b0c06]
- Updated dependencies [c592eb8]
  - @cotal-ai/workspace@0.109.8
  - @cotal-ai/core@0.109.8

## 0.109.7

### Patch Changes

- 18b73d2: The `down` section of the CLI reference now says what `cotal down manager` does on a controller stack. Like `cotal service stop`, a preset name reaches the stack member built on that preset, so `cotal down manager` stops `stack-manager` and `cotal down delivery` stops `stack-delivery`, and the receipt's target names the member and the name you gave as `requested`. The page used to say `cotal down manager` refuses `TARGET_NOT_FOUND` on a controller stack, which the `service` section and the command itself contradicted. A name that is no preset, such as `nats`, still refuses `TARGET_NOT_FOUND` and names the `stack-` member to use.
- @cotal-ai/core@0.109.7
  - @cotal-ai/workspace@0.109.7

## 0.109.6

### Patch Changes

- 2fb2c19: `cotal manager logs` now reads the log of the manager a plain `cotal up` started. That manager has
  no saved service, so `manager logs` and `service logs manager` refused it `UNSUPPORTED` and offered
  only stop advice, and `service logs stack-manager` refused `TARGET_NOT_FOUND`. All three now read
  `<root>/.cotal/manager.<spaceKey>.log`, the file `up` opened for it, with `--tail`, `--follow` and
  `--json` as for a service, and change nothing. A follow ends when that manager's process is gone.
  `manager stop`, `install` and the other verbs still refuse it and name `cotal down`.
- @cotal-ai/core@0.109.6
  - @cotal-ai/workspace@0.109.6

## 0.109.5

### Patch Changes

- a32425e: A copy, a moved project folder and the folder a later `up` took a space's name over from keep the store of a stack that runs from another folder, and that store can hold the space's only history. `cotal clean store` and `cotal clean all` there, dry runs included, now refuse `TARGET_UNAVAILABLE`, exit 2, naming that folder and the step the reads there name, and remove nothing. `cotal status` there no longer offers `clean store`. Before, in a folder the legacy launcher started, both removed `.cotal/nats` and exited 0. A bare `cotal up` in such a folder now refuses `CONFLICT`, as `cotal down` there does, instead of taking the name over. When the recorded folder is gone and the space's broker does not answer, it also names `cotal up --space <space>`, which takes the name over to run the stack from this folder. The refusals that commands such as `ps` and `send` give in a copy or a moved folder now head with `Mesh: <space>` and carry `target.space`, naming the space the folder's records name, as `up` and `down` there do. Bare `cotal` in a folder whose registered space is not the selection, and whose own records show its stack stopped, as after `cotal down`, now names the selected space and what the folder holds, as it does for a prepared folder. `@cotal-ai/workspace` gains `recordsElsewhereError`, `targetErrorSpace` and `folderSpaceStopped`.
- Updated dependencies [a32425e]
  - @cotal-ai/workspace@0.109.5
  - @cotal-ai/core@0.109.5

## 0.109.4

### Patch Changes

- 92ac24d: Usage telemetry follows the environment into the processes Cotal starts. `DO_NOT_TRACK`, `COTAL_TELEMETRY`, `COTAL_TELEMETRY_DISABLED`, `COTAL_TELEMETRY_URL` and `CI` now reach the agents a manager spawns and the services `cotal service start` launches. Before, both dropped them: a `cotal` command an agent or a service ran reported at the settings file's level to `https://cotal.ai`, even when the run that started it had opted out or pointed at a self-hosted intake, and it reported `ci: false` inside a CI job. The `ci` field is now `false` when `CI` is `0` or `false`, which is how a script says it is not a CI run. Before, any value counted as CI.
- @cotal-ai/core@0.109.4
  - @cotal-ai/workspace@0.109.4

## 0.109.3

### Patch Changes

- e098386: Ctrl-C on a bare `cotal down` of a stack a plain `cotal up -d` started, the retained launcher whose stop lines name each process and its pid, no longer ends it silently with the stack partly stopped. It now exits 130, 143 or 129 with a notice that names the members it stopped, those still running and `cotal down --yes` to finish the stop. A signal that lands while a member it already signalled is exiting waits for that exit, so the member's stop line prints first and `cotal status` no longer reads the stopped broker as a stale pidfile or an exited broker to restart. A second signal ends the stop at once and names the member whose stop is not confirmed.
- @cotal-ai/core@0.109.3
  - @cotal-ai/workspace@0.109.3

## 0.109.2

### Patch Changes

- 4f6f406: A manager imports an installed runtime extension on demand when a managed seat names it with `spawn --runtime <name>`, and when it resumes a retained seat that was launched on one, through the same installed-extension lookup `up --runtime` uses. A `pty` manager started after `cotal ext add @cotal-ai/tmux` used to refuse `spawn -d --runtime tmux` as an unknown runtime, because its process had imported only its own runtime. An additional runtime removed with `cotal ext remove`, one other than the manager's own, is refused for the next seat even while an earlier import keeps it registered; the manager's own runtime and seats already on the removed one keep their backend. The manager's refusal for an uninstalled runtime now names the official package, from the same table and wording the CLI uses, which moved from the CLI into `@cotal-ai/workspace`.
- Updated dependencies [4f6f406]
  - @cotal-ai/workspace@0.109.2
  - @cotal-ai/core@0.109.2

## 0.109.1

### Patch Changes

- 323609a: `cotal spawn -d --runtime <name>` refuses `auto` before anything is sent. When the launch goes to this root's own manager, pinned or the only one running, an unknown, uninstalled or unreachable runtime is refused `DEPENDENCY_UNAVAILABLE` before the launch is sent, through the lookup `up --runtime` uses, and a known runtime's remedy names its `cotal ext add` package. A launch that may reach a manager on another host still sends the name, and that manager checks its own extensions. `--dry-run` shows the requested runtime, carries it as `result.requested.runtime`, and reports in `result.runtimeCheck` which host it checked and whether that host can run it, with a `RUNTIME_UNAVAILABLE` warning when it cannot.
- @cotal-ai/core@0.109.1
  - @cotal-ai/workspace@0.109.1

## 0.109.0

### Minor Changes

- 82cb60d: A daemon entry now loads only the modules its own command needs, not every command of the CLI. The registry in `@cotal-ai/core` gains `provide`, `provides` and `load`. A composition root declares a module and the keys it registers before importing it, and `load` imports only the module behind the key a process asks for, once. A key whose module did not register it is refused, never stood in for. `cotal` declares its daemon entries this way: `supervise`, `deliver`, `feedback-intake`, `auth-service`, their `__daemon-*` and `__service-*` forms, and `__service-unit`. The entry's flags, usage, refusals and exit are unchanged. `@cotal-ai/cli` gains two exports: `./dispatch` (`commandWord` and `runCli`, without the command surface) and `./service-unit` (the unit entry alone). On a stack with no seats, 30 seconds and 5 minutes after `cotal up` (the mean of three runs each), the manager went from 148 MB to 106 MB of private memory in its first minutes and from 112 MB to 75 MB once settled. The delivery daemon went from 110 MB to 65 MB, then from 105 MB to 60 MB. The user-auth service went from 115 MB to 74 MB, then from 105 MB to 62 MB.

### Patch Changes

- Updated dependencies [82cb60d]
  - @cotal-ai/core@0.109.0
  - @cotal-ai/workspace@0.109.0

## 0.108.1

### Patch Changes

- c5d23cf: Daemons now run under the Node flag `--max-semi-space-size=1`, which caps V8's young generation at 2 MB. `cotal up` puts it on the manager, delivery daemon and user-auth service it starts. `cotal service start` puts it on every service it launches through the CLI, and the unit `cotal service install` writes carries it too, as does the container entry in `deploy/docker`. On a stack with no seats, 30 seconds and 5 minutes after `cotal up` (the mean of two runs each), the manager went from 268 MB to 147 MB of private memory in its first minutes and from 126 MB to 111 MB once settled. The delivery daemon went from 174 MB to 108 MB, then from 118 MB to 105 MB. The user-auth service went from 254 MB to 112 MB, then from 153 MB to 105 MB. Nothing else changes. A unit an earlier release wrote keeps its own command line.
- 25e980f: A copy, a moved folder and a taken-over folder refuse again with another space selected
  
  Since a folder's space became the target only while it runs, a copy of a project whose space runs
  elsewhere, a folder moved away from its recorded path and the folder a later `cotal up` took the
  name over from sent their reads to the selected space when one was selected, under a note to
  restart the folder's space with `cotal up`, which refuses there. They refuse `TARGET_UNAVAILABLE`
  again and name the folder or Cotal home the stack runs from, and bare `cotal` and `cotal space show`
  there no longer offer that `cotal up`.
  
  In a folder whose registered space is stopped, `cotal spawn -d --dry-run` now previews the space
  `cotal spawn -d` launches on, and `cotal space show` calls that space stopped. `cotal status --json`
  and `cotal space --json` give no folder space there and the listing marks none. Bare `cotal` and
  `cotal use`, which read no broker, say the folder's space applies while it runs. With nothing
  selected, bare `cotal` names the space the folder prepared again.
  
  `--json` in a folder holding a prepared or stopped space carries the note under the `Mesh:` heading
  as a `FOLDER_SPACE_NOT_RUNNING` warning, and `cotal chat` names the selection it joins with that
  note. A refusal there whose own next step names `cotal up` no longer names a second one under its
  heading.
- 91cc1d8: `cotal up` no longer prints its full help after a TLS address refusal whose remedy names the fix: a `nats://` `--server` in a root whose recorded broker policy serves TLS, a `nats://` `--server` with `--tls-cert`, and a `tls://` `--server` with no certificate. Each now prints the refusal and the address to pass. The `--help` page of each command hidden from `cotal help` as legacy (`clean`, `join`, `topology`, `endpoints`, `describe`, `invoke`, `console` and `actor`, as `meshes` and `personas` already did) now says it is legacy and names what replaces it in the words of its row in the CLI docs. `cotal status` in a stopped folder whose broker kept a store now names `cotal reset store <space>` for a stale store when that reset reaches the folder's store, in place of the legacy `cotal clean store --force`, which it still names where no registration lets a reset reach the folder.
- Updated dependencies [25e980f]
  - @cotal-ai/workspace@0.108.1
  - @cotal-ai/core@0.108.1

## 0.108.0

### Minor Changes

- 7657395: The manager and the built-in services start without being added first. `cotal manager start` starts the manager for this folder's or the selected space with the pty runtime and its registered broker, and `cotal manager stop`, `status`, `logs` and `restart` act on it; after `cotal up` it reports the manager `up` started and starts no second one. `cotal service` lists every built-in service, started or not, with the command that starts it, and `cotal service start <preset>` starts one from its defaults, refusing with the exact flags when it needs a file that has no default, such as the feedback form's tester keys and broker credential. A service preset can declare those defaults: a literal, the space's registered root or broker, or a private file the space already keeps. `cotal service add <name> --exec "<command>"` adds a program of your own without a definition file, splitting the command into words without a shell and refusing pipes, redirection, variables and globs.
  
  `cotal supervise` is deprecated again and is removed in 1.0.0 with the other daemon entries. It keeps its flags and behavior and prints one line on stderr naming `cotal manager start`, or, when it is given `--execution`, `--spawn`, `--seat-cap` or a resume flag that `manager start` does not take yet, saying to keep `supervise` for that run. `cotal manager start` and `restart` install first-party connectors on first run, as `supervise` does. `cotal manager install` refuses before any effect and names a unit of your own running `cotal manager start --foreground`. The `deliver`, `auth-service` and `feedback-intake` warnings now name `cotal service start <preset>`.

### Patch Changes

- Updated dependencies [7657395]
  - @cotal-ai/workspace@0.108.0
  - @cotal-ai/core@0.108.0

## 0.107.0

### Minor Changes

- 0ae11a6: One manager can host seats on different terminal runtimes at the same time.
  
  `cotal spawn --runtime <name>` with `-d` or `--on`, `cotal_spawn` with `runtime`, and a workflow `spawn(persona, { runtime })`, choose the runtime of that one seat. A seat that names none keeps the runtime the manager was started with. An unknown or unreachable runtime, and `auto`, refuses the launch and starts nothing. Stopping, attaching, and recovery follow the runtime recorded for that seat, so a later seat does not move one that is already running.

### Patch Changes

- c883f4a: `cotal linear serve` on a user-auth mesh now names the proposal it is waiting on. Its `PERMISSION_DENIED` refusal used to say only "approve the original proposal in the selected space", so the owner had no id to approve. The Next line now names the proposal and the exact command, `cotal service-endpoint approve <proposalId> --caller-ceiling linear.mcp --space <space>`; the `linear.mcp` ceiling lets callers be granted the five Linear commands, which an approval without it never allows.
  
  A flag a `cotal linear` operation does not take is refused naming that flag, the flags the operation does take and its usage, instead of "a supplied flag does not belong to this Linear operation". `linear serve --json` now says that serve is a foreground service with no `--json` or `--plain` output, and `linear account login --json` names `--plain` as its only output flag.
  
  `cotal help` shows a usage that declares several forms, one per line, with each form on its own lines. `cotal linear --help` used to print its nine forms joined by an escaped `\u000a`. Each `linear` operation's help now shows its own usage line too.
- @cotal-ai/core@0.107.0
  - @cotal-ai/workspace@0.107.0

## 0.106.1

### Patch Changes

- fb43711: `cotal update` verifies each installed built-in connector and the web dashboard against the payload the binary ships, byte for byte, and reinstalls only the ones that differ, instead of reinstalling all seven on every run. `cotal ext seed --force` still reinstalls unconditionally.
- @cotal-ai/core@0.106.1
  - @cotal-ai/workspace@0.106.1

## 0.106.0

### Minor Changes

- dd1f8d6: A folder's space is the target of the commands run there only while it runs
  
  A space `cotal space create` prepared in a folder, and one whose stack there is stopped, used to
  capture every command run in that folder, overriding the space `cotal use` selected. `cotal status`
  in a project whose space had never started reported that space instead of the working selection, and
  `cotal ps` in a checkout whose space is stopped asked about the stopped one.
  
  A folder's space now captures a command there only while it runs. A prepared or stopped folder space
  is the target of the commands about the folder itself: `cotal up`, `cotal down`, `cotal space show`
  and the folder part of `cotal status`. Every other command there targets the selection, and the line
  under its `Mesh:` heading says what this folder holds and the `cotal up` that starts it. A running
  folder space keeps its behaviour, including the note that the selection applies outside the folder.

### Patch Changes

- dd1f8d6: `cotal status` reports what is set up and what needs attention, not every known part
  
  This machine listed one row per known agent application whether or not it was set up, every
  extension with the same version spelled out on each, and the broker executable's bundled path on a
  healthy machine. Brokers grouped the spaces under their broker addresses and repeated `not checked`
  on every row that status does not dial.
  
  This machine is now the version line, one Agent applications line naming what is set up with a count
  of the others `cotal setup` adds, one Extensions line at the version they share, and the rows that
  need attention: an application's own pieces when they are stale or failed, the broker executable when
  it is missing or refused, the dashboard when its record cannot be read. Brokers becomes Spaces: the
  space being reported first with its connection state, then one line per space with how it signs in,
  one note that unselected spaces are not dialed, and one line per account whose space catalog could
  not be refreshed, named by the account. `status --all` and the new `status --wide` report every row
  in full. `--json` is unchanged apart from `meshes.catalogs[].account`, which the error line names.
- 54a2996: `cotal update` and `cotal update --self` no longer refuse the software update over registrations that hold no manager on this machine. A space prepared here that never started (`cotal setup --configure-only`, `space create`), whether it is this folder's space, selected or named, is named and skipped like a stopped one instead of answering "is prepared but not started - start it with cotal up". A folder that holds several registrations, such as two remote spaces registered there with `space add --from`, is read one registration at a time, each by name, instead of refusing with "multiple meshes running" and reading none; the resolver's per-folder ambiguity now carries the space names for that.
- Updated dependencies [dd1f8d6]
- Updated dependencies [ba25fb6]
- Updated dependencies [54a2996]
  - @cotal-ai/workspace@0.106.0
  - @cotal-ai/core@0.106.0

## 0.105.1

### Patch Changes

- 2d269dd: Let a native Claude conversation replace an unwanted pending name or permission request without approving it first. Stop the superseded approval watcher, recover and retire any identity issued during the change, and require a fresh approval before the replacement connects.
- @cotal-ai/core@0.105.1
  - @cotal-ai/workspace@0.105.1

## 0.105.0

### Minor Changes

- c49bced: Omit `path` from absent process records, including missing files and empty pidfile husks. Narrow `ProcessRecord` by `state` before reading its evidence fields. Non-absent records keep the path that was read, including pre-upgrade spellings.
- 7b6fa0b: `cotal watch` refuses a target it cannot open the way the other reads of that space do.
  
  In a stopped project it ended on one line with exit 1, no mesh heading and no next step, while `history`, `channel` and `chat` in the same folder refused the same target with the full report and exit 2. It now refuses under the refusal's own code with that report, and `--json` carries that code, message and next step in the stream's `error` record instead of a generic sentence under `OPERATION_FAILED`.

### Patch Changes

- 8958031: `cotal help` no longer lists eight more legacy commands, and completion no longer offers them: `join` (`chat` replaces it), `endpoints` (`who --all`), `describe` and `invoke` (`endpoint describe` and `endpoint invoke`), `console` (`watch`), `topology` (`team check --graph`), `clean` (`reset`, `history clear` and `backup cleanup-fallback`) and `actor` (`auth grants`, `auth grant` and `auth revoke`). Each still runs and keeps its own help page. The `supervise` entry's one-line summary no longer repeats its flag list; `cotal help supervise` lists the flags.
- 7b6fa0b: `cotal up` in a running project, its subfolders included, says that the space already runs there.
  
  A start naming another address with `--server` or `--host` refused as though the name belonged to another folder, and offered to start a separate space in the folder that is already that space's project. It now names the address the space runs at, the bare `cotal up` that reaches it, and the `cotal down` in its root. A refresh that finds the mesh already running reports it like any other start: the `Mesh:` heading first, then its line, and a Next that names the launch and the stop. It used to print one line with neither.
- 7b6fa0b: `cotal up` keeps the mode a stopped project last ran in, whatever address the restart names.
  
  `--server` and `--host` name where the broker listens, not whether it authenticates, but the mode was read off the same condition as the address. A project started with `--open`, stopped, and restarted with the address it already ran on came back with auth required and a delivery daemon, and the receipt said nothing about the change. The address still follows the flags, the recorded mode is inherited whenever the start names no mode of its own, and the receipt says the mode it started in. A `--open` or `--user-auth` flag still starts the mode it names.
  
  A `--server nats://` address on a root whose recorded policy serves TLS refuses `USAGE_INVALID` before anything starts, naming `.cotal/broker-policy.json` and the `tls://` address to pass. It used to start a TLS broker, register it under an address no client can dial, and print `TLS: serving <subject> at nats://<address>` over it.
- Updated dependencies [c49bced]
- Updated dependencies [6e16f06]
  - @cotal-ai/workspace@0.105.0
  - @cotal-ai/core@0.105.0

## 0.104.2

### Patch Changes

- @cotal-ai/core@0.104.2
  - @cotal-ai/workspace@0.104.2

## 0.104.1

### Patch Changes

- @cotal-ai/core@0.104.1
  - @cotal-ai/workspace@0.104.1

## 0.104.0

### Minor Changes

- b7d4f22: A foreground `cotal spawn` on a manager whose runtime streams no terminal now launches the agent
  and stops there, instead of launching it and then failing `OPERATION_PARTIAL` on an attach that
  runtime cannot open. Only the built-in `pty` runtime streams a terminal; `tmux`, `cmux`, `orca` and
  `herdr` start the agent in a surface the manager does not own. A launch on one of those exits 0
  with the agent running, and its receipt names the runtime, says the seat runs in the manager's own
  session, and gives `cotal watch` and `cotal send` as the way to reach it. `--json` carries the same
  answer as `result.streamsTerminal`. A `pty` manager still attaches.
  
  `cotal attach <name>` on such a seat is refused once as `UNSUPPORTED`, carrying that runtime's own
  guidance for watching the agent where it runs, and the reconnect loop no longer retries it. The
  manager question's rows name each manager's runtime and whether a terminal attaches to its seats,
  so the choice is informed before a launch.
  
  Breaking for anyone who implements the `Runtime` contract outside this repo: `streamsTerminal` is a
  required field, and a backend that streams no terminal must say so rather than leave a caller to
  find out by catching the throw from `attach()`. The manager reports it to its callers on the launch
  reply and in its presence card, and a manager that does not report it is attached to as before.

### Patch Changes

- e101048: `cotal help` no longer lists the legacy `meshes` and `personas` commands, and completion no longer offers them. Both still run, and `cotal help meshes` and `cotal help personas` still print their help, now marked `(legacy)` and naming the replacement: `cotal space`, `space add` and `space forget` for `meshes`, and `cotal persona` for `personas`. The redesigned commands have carried the same work since 0.91.0, so the listing showed two entries for every registry and persona task.
- a4bbb26: A personal Claude Code conversation whose `cotal_connect` is awaiting approval no longer depends on the person coming back to say "retry". The plugin's server follows the pending request, serialized with the conversation's own connect, until the authority records the decision, the request expires, or the session ends. An approval finishes the same request and holds the issued identity for that conversation's `cotal_connect` with its `approval_id`; the person's decision reaches only the native session that asked, through its wake reader, as one fixed approved, denied or expired line that the native module admits exactly. An approved identity nobody claimed is retired when its session ends. `cotal app-identity provision` now reports a recorded refusal as `refused: denied | expired | refused` beside its message, so a host never classifies a decision from prose.
- e0c4e6e: Correct the documentation page by page against the implementation, including CLI commands, connector delivery and activity sharing, authentication, observer surfaces, hosted composition, telemetry and historical design status. Refresh package guides and generated tool and HTTP references while preserving existing links and normative contracts.
- Updated dependencies [e0c4e6e]
- Updated dependencies [b7d4f22]
  - @cotal-ai/core@0.104.0
  - @cotal-ai/workspace@0.104.0

## 0.103.4

### Patch Changes

- e6af269: A bare `cotal down` in a folder with no stack now names the space the selected one is, the folder
  this machine started it in, and the same `down` to run from there, for every stack `cotal up`
  registered rather than only a controller one. It used to say only that this folder's root holds no
  stack and point at "the folder where `cotal up` started the stack" without naming it, so a script
  and an operator both had to find it. `--json` and `--plain` carry that refusal as structured output
  instead of refusing `UNSUPPORTED`, so a script reads the same code as the plain run.
- e6af269: A project the legacy launcher started writes no stack journal, so a copy of one, the folder a later
  `up` took its name over from, and one moved away from its recorded path all read as a folder whose
  own stack was merely stopped: `status`, `ps` and the other reads named this folder's last broker
  address and said to run `cotal up` here, which then refuses the name or takes it over. While this
  machine registers that space for another folder, they now name that folder and the step that
  reaches it, or the way back when it no longer exists, and a bare `cotal down` there says the folder
  holds the space's records and no stack of its own. A registration added by hand never redirects the
  folder. `cotal spawn --dry-run` carries the same sentence and next step in place of reporting only
  that a target could not be resolved, for a controller project's copy as well.
- c05e0e3: Let personal Claude Code conversations choose a registered mesh with `cotal_connect`'s optional `space` argument, without changing project configuration. Keep hosted grants space-bound, require disconnect before replacing a live connection, and retire a previous space's pending identity before requesting another.
- Updated dependencies [e6af269]
  - @cotal-ai/workspace@0.103.4
  - @cotal-ai/core@0.103.4

## 0.103.3

### Patch Changes

- eae18f8: Keep the command a spawn receipt offers whole on a narrow terminal. The folder
  question's receipt, the manager question's receipt and the refusal of a folder
  check that could not be made each named a command to copy as bare prose, so the
  report renderer broke it at its spaces: at 80 columns the folder receipt split
  between a flag and its value, and copying the first line ran a flag with no
  value. Each of those commands is now marked as a command, which the wrapper
  keeps whole. The refusal of a typed folder also wraps at spaces instead of
  running past the terminal.
- Updated dependencies [2b59b43]
  - @cotal-ai/core@0.103.3
  - @cotal-ai/workspace@0.103.3

## 0.103.2

### Patch Changes

- 462366f: Keep console detail rows intact on short terminals by clipping the bottom of the card instead of squeezing its contents together.
- 2f74981: A read whose recorded broker answers and refuses the connection now keeps its registration when
  another registered space names that same address, and refuses `CONFLICT`, exit 2, naming the space
  that holds the address, the `cotal space forget <space>` that frees it and the
  `cotal up --server <url>` that moves this one. `cotal status` reports that space as `address held`.
  The rejection used to count as a stale record and delete it, which left the folder naming no space,
  so nothing there said which space its commands meant.
- 2f74981: The bare `cotal down` that refuses `LIFECYCLE_BLOCKED` while another registered space names this
  stack's exact broker address now names what to run: `cotal space show <space>` for each of those
  spaces, the `cotal space forget <space>` that takes one off this address, and the `cotal down` to run
  again. Its next step used to name no command, so the running stack had no documented stop.
- 2f74981: `cotal up -f` now refuses `CONFLICT`, exit 2, when its manifest's `broker.servers` is the address a
  space registered for another folder keeps while stopped, naming that space and folder, the field to
  point elsewhere and `cotal space forget <space>`, and starts nothing. The flag path already refused
  this; the manifest path started a second stack on that address, after which one listener answered
  for both registrations, the running stack's own `down` refused, and a read in the other folder
  deleted that space's registration.
- Updated dependencies [2f74981]
  - @cotal-ai/workspace@0.103.2
  - @cotal-ai/core@0.103.2

## 0.103.1

### Patch Changes

- 68377b0: A manager can now bound how many live seats it holds for one owner, so a manager shared by several
  owners cannot be filled by the first one to ask. `cotal supervise --seat-cap <n>` and `cotal up
  --seat-cap <n>` set it, and the value is recorded in the root, so a repair, a resume or a bare `up`
  after `down` keeps it. The default is `unlimited`, which leaves the manager's own 50-slot ceiling as
  the only bound, so a mesh with one owner keeps every slot it had. The cap counts the seats that
  manager supervises for the owner a launch belongs to, plus its launches that have no process yet;
  it does not count cooling slots or another owner's seats.
  
  A launch over the cap is refused before a name is reserved or anything is minted, and the seats
  already running are untouched. The refusal is `resource-exhausted` carrying the owner, its count and
  the cap, so a caller reads the numbers rather than the sentence. `cotal spawn` exits 2 with
  `CONFLICT`, the manager's sentence and a remedy naming `cotal stop --name <name>` and `--seat-cap`;
  under `--json` those three numbers are in `error.cause.detail`. `cotal_spawn` shows an agent the same
  sentence. Stopping one of that owner's seats admits the next launch.
- 1608ae7: The folder question a managed launch asks in a terminal now works on a static mesh. An operator
  instrument carries `resolve-cwd` on the manager it pins, the read that question's check needs, so a
  typed folder is resolved by that manager instead of refused at the broker, and a folder it cannot
  use is shown with its reason and asked again. A check that could not be made at all keeps the
  responder's internals out of its sentence and names the `-C <dir>` that sends the folder with the
  launch.
  
  The question also reads the host the manager reports, the name `cotal ps` prints as its reported
  host, so a manager running on this host is no longer asked about and its receipt no longer says the
  host was not reported. The mesh and the pin are read before anything is asked, so a stopped mesh or
  an `--on` that names no running manager is refused first.
- Updated dependencies [68377b0]
- Updated dependencies [1608ae7]
  - @cotal-ai/core@0.103.1
  - @cotal-ai/workspace@0.103.1

## 0.103.0

### Patch Changes

- 187220f: Refuse delivery cutover when the judged manager's record changes or disappears before its pid-bound stop, including an empty replacement or an absent pidfile with leftover artifacts. Preserve a successor's records instead of silently continuing after cleanup that did not stop the judged process.
- @cotal-ai/core@0.103.0
  - @cotal-ai/workspace@0.103.0

## 0.102.0

### Patch Changes

- 30fb90c: `cotal up` on a root with no prepared record and no stack journal starts on the legacy launcher whatever it names, including a root whose space its `up` registered. Before, such a root took the controller route when the invocation named no legacy-only option. On a stopped legacy user-auth root that started a controller broker beside the root's retained auth-service record, failed its auth member (`OPERATION_PARTIAL`), and wrote a stack journal that tied the root to the controller from then on. Only a root prepared here, or one whose stack journal exists, takes the controller route.
- f149d6a: On a user-auth mesh, when some of your managers do not answer, `cotal ps` and `cotal who` name each of them by instance id in their Next, so a registration left by a manager that ended without a clean stop can be told apart from the managers that answer. The Next used to say only to retry or read one manager with `--on`.
- f149d6a: `cotal ps` on a user-auth mesh with several of your managers live no longer refuses or asks which one. It reads each manager the exchange counts live through its own one-instance view and lists each under its own `manager <id>` header with the host its presence reports. A manager that does not answer is listed as silent and makes the read partial, as on a static mesh. `status <agent>`, `who` and the `attach` picker read your managers the same way. When none of your managers answers, or none is live, `ps` lists your agents as presence shows them, read-only, and exits 0. Its next step starts a manager: bare `cotal up` on the root of the space's own stack, `cotal supervise` anywhere else. `--json` reports that read as `result.kind` `presence`.
- bc290bd: A refused `cotal up` no longer moves the operator-global connector seed store. `up` reconciled that store at the boot gate, before its own checks, so an `up` that then refused (a folder named after a space another folder holds, a `--channels` file that is not JSON) had already stamped the store with its generation while saying nothing was written, and an older `cotal` then refused the store as a downgrade. `up` now seeds when it first starts a process, or when `up -f` checks its agents' connectors, and a start that fails after the seed moved the store says so and names it. An older `cotal` still refuses a newer store before writing anything; its refusal now names the store and the extensions folder and says to restore both from a backup taken before the store moved, with the versions as context.
- Updated dependencies [9a75f1b]
- Updated dependencies [bf8978b]
- Updated dependencies [10ad6d3]
- Updated dependencies [d0d9e66]
  - @cotal-ai/core@0.102.0
  - @cotal-ai/workspace@0.102.0

## 0.101.7

### Patch Changes

- 0e7d42e: `cotal up` with an option only the legacy launcher takes, such as `--exchange-public-port`, starts a stopped root that launcher already started again on that launcher. This applies to a root with no stack journal whose `up` registered the space with no prepared record, or a user-auth root that holds its user-auth state. Before, such a root was refused `UNSUPPORTED` as if it were a fresh prepared root ("this root is prepared for a controller-owned stack"), so a hosted user-auth deployment that had run on 0.100 could not start. A fresh prepared root still refuses those options.
- acc1ce4: `cotal up` without `--user-auth` on a stopped root whose space has user-auth state, `--open` included, now refuses as `CONFLICT`, exit 2, before anything is written, and the Next line says to add `--user-auth`. Before, a plain `up` refused only after it had opened the store and claimed the space, and reported the refusal as "Outcome unconfirmed" (`OPERATION_UNKNOWN`, exit 3), as did `up --open`.
- Updated dependencies [668ef6a]
- Updated dependencies [ae43b58]
  - @cotal-ai/core@0.101.7
  - @cotal-ai/workspace@0.101.7

## 0.101.6

### Patch Changes

- 52832dc: `space create` and `up` no longer refuse a project folder that sits beside the records of a home `COTAL_HOME` redirects. 0.101.x treated every path under the Cotal home as its control directory, so the hosted layout, whose space root lives at `$COTAL_HOME/cotal`, could not start its broker and a cutover refused with `CONFLICT`. Under a redirected home only the home itself and its record entries (`meshes`, `prepared`, `services`, and the rest `homeRecordEntries` names) are control paths; the default `~/.cotal` still refuses every child, and a project's `.cotal` is unchanged.
- 49cf781: `cotal up --auth-timeout <seconds>` sets how long a user-auth space's broker waits for the auth callout, from 1 to 60 seconds. `up` renders it as `authorization { timeout: N }` in the broker config and starts the space's auth service with the same value as its callout deadline, so the two never differ. The value is recorded in `.cotal/broker-policy.json`, and a later `cotal up` on the root renders it again without the flag, after `cotal down` or a preserved resume included. A running broker refuses a different value. Before, the broker config had no `authorization` block and no flag set one, so a hand-applied timeout was lost the next time `up` wrote the config. `serverConfig` takes the timeout as `authTimeout`, and renders no block without it, so existing configs are unchanged. The auth-service daemon, a `--callout-only` replica included, takes `--auth-timeout <seconds>`.
- Updated dependencies [52832dc]
- Updated dependencies [49cf781]
  - @cotal-ai/workspace@0.101.6
  - @cotal-ai/core@0.101.6

## 0.101.5

### Patch Changes

- a9ece42: `cotal spawn` reports a managed launch the manager reports failed, such as an agent whose process
  exits at once, as `OPERATION_FAILED` (exit 5) with the manager's reason. It used to print "Outcome
  unconfirmed" with `OPERATION_UNKNOWN` (exit 3), though the manager had answered.
- Updated dependencies [e6f1f4d]
  - @cotal-ai/core@0.101.5
  - @cotal-ai/workspace@0.101.5

## 0.101.4

### Patch Changes

- 0642c8f: A managed launch that waits for you before it joins no longer ends as an unknown outcome. A
  connector can name the screen a launch waits at (`waitsForOperator`), and Claude does for
  `--opt resume=` with no session id, which opens its session picker. The manager reports such a
  launch ready once its process runs, and `cotal spawn` says the agent is waiting for you at that
  screen and attaches to it in a terminal, `-d` included, or prints the attach command, exiting 0.
  When the readiness window passes and the manager saw the agent's process still running, the
  `uncertain` result carries an `ai.cotal.goal.entity-running` detail, and `cotal spawn` says the
  agent has not joined yet and how to attach instead of reporting an unknown outcome.
- Updated dependencies [0642c8f]
  - @cotal-ai/core@0.101.4
  - @cotal-ai/workspace@0.101.4

## 0.101.3

### Patch Changes

- c54a604: `cotal help`, and `cotal --help` and `cotal -h` with it, now lists every command group under the entry screen, so no flag is needed to see what the CLI can do. Bare `cotal` keeps the compact entry screen and points to `cotal help` for the rest. `cotal help --all` is no longer needed; it still works and prints the same list. A hidden command, such as a deprecated daemon entry, is still left out of the list and still runs.
- 620d7ff: `cotal spawn -d` with no `--on` on a user-auth mesh now asks, in a terminal, which folder the agent
  works in when the manager the exchange picks is on another host, as a launch with `--on` does. The
  launch is pinned to that manager, so if it stops before you answer the launch is refused and goes
  to no other manager.
- a677726: `cotal spawn` handles a name that is already taken. When a live manager of yours runs that agent,
  or presence or the mesh reports it online, the spawn launches nothing, says where it runs and exits
  0; in a terminal it attaches to that agent, and otherwise it prints the `cotal attach` command. When
  the mesh answers that the name is held by a lifecycle that does not run, the spawn releases that one
  lifecycle by its UID with your login and asks again, waiting up to 2 minutes while the mesh says the
  name is still retiring. This applies to managed launches and to spawns in this terminal; an
  implicit name is numbered past an online holder only. The auth client keeps a host's typed HTTP 409
  answer (`AGENT_LIFECYCLE_HELD`) and passes it through the manager. The stock auth service answers
  409 for its own conflicts, which the CLI now reports as `CONFLICT`, and a manager's refusal of a
  hard-pinned name it holds carries `already-exists`. `cotal auth retire <uid>` releases a lifecycle
  on such a mesh. A failed agent provisioning now says its outcome is unknown instead of calling it
  refused.
- 330127a: `cotal supervise` is no longer deprecated. Help lists it under its own Run a manager group, it prints no deprecation warning, and it is not removed in `1.0.0`. Without `--space` it now supervises the space every other command targets: `COTAL_SPACE`, else the space this folder hosts or is registered for, else the one `cotal use` selected. A bare `cotal supervise` with a hosted space selected used to target the default space and refuse that it was neither hosted nor registered. A manager started for a selected space keeps its records in the folder that space is registered at, so a start from any folder is the same manager. The CLI docs gain a section on starting a manager for a hosted space.
- Updated dependencies [c54a604]
- Updated dependencies [a677726]
- Updated dependencies [330127a]
  - @cotal-ai/workspace@0.101.3
  - @cotal-ai/core@0.101.3

## 0.101.2

### Patch Changes

- 9acfc57: A manager command such as `cotal ps`, `cotal stop` or `cotal spawn --on`, and `cotal send` with the other commands that open a one-shot connection, now connects again when the broker refuses the connection or it does not open within 5 seconds: nothing was sent, so up to 4 attempts are made 1 second apart. A view the auth service refused for a moment, or an auth service that answered after the broker's callout timeout, now just works. These commands used to stop at the first refusal, or wait 20 seconds and end as `OPERATION_UNKNOWN` (exit 3) with a bare `timeout`. When every attempt fails, the command says nothing was sent and is refused, exit 2: `PERMISSION_DENIED` when the broker refused each attempt and `TARGET_UNAVAILABLE` when none opened in time. An endpoint takes a `transportConnectTimeoutMs` option for its first connect.
- 427f28b: `cotal up` now refuses `CONFLICT`, exit 2, when its address is one that a space registered for
  another folder keeps while stopped, naming that space and folder, and starts nothing. It used to start
  there, after which that stack's `down` refused and a read in the other folder deleted that space's
  registration. A takeover of that space's name is unchanged.
- e4c73d5: Keep self-update installation and reconciliation running safely after Ctrl-C, then exit with the interruption status once the package tree is usable.
- 427f28b: A second bare `cotal down` in a stopped project whose space is named after its folder now reports
  that the stack there is not running, names `cotal up`, and exits 0. Since that space keeps its
  registration after `down`, it exited 1 with only "Nothing running for the local stack (no recorded
  pidfiles)." and no next step.
- 427f28b: A command in a project folder whose stack is stopped with no registration, as after the `down` of a
  space not named after its folder or in a moved project, now refuses `TARGET_UNAVAILABLE` with another
  space selected too, naming the space its account names and `cotal up` there. It used to reach the
  selected space, so `send` stored the message there and `ps` listed that space's manager.
- Updated dependencies [9acfc57]
- Updated dependencies [d57e596]
- Updated dependencies [427f28b]
  - @cotal-ai/core@0.101.2
  - @cotal-ai/workspace@0.101.2

## 0.101.1

### Patch Changes

- 3252512: A manager command whose credential the broker refuses at connect, such as `cotal spawn --on` or `cotal ps --on` on a user-auth mesh whose auth service refuses the issued manager view, is now refused `PERMISSION_DENIED` (exit 2) and says nothing was sent to the manager. It used to end as `OPERATION_UNKNOWN` (exit 3) with only the broker's `Authorization Violation`, which read as a launch that might have happened. The message keeps the broker's reason, and on a user-auth mesh it says the space's auth service logs why. A failure after the request was sent is still reported as unknown.
- 91909b5: On a terminal, a bare `cotal spawn` on a user-auth mesh where several of your managers are live
  asks where the agent runs: this terminal, the default, or one of those managers, which launches it
  and attaches here as `--on` does. A managed launch on a manager that is not known to run on this
  host, picked or named with `--on`, then asks which folder the agent works in unless `-C` names one.
  Enter keeps the manager's workspace and sends no folder. A typed folder is sent as typed and checked
  by that manager with `resolve-cwd` before anything is launched; a folder it refuses is asked again.
  No manager credential is held while a question waits. `--json`, `--no-input`, `COTAL_NO_PROMPT=1`
  and a missing terminal never ask.
- 0379e03: Process services, and with them a prepared stack's `cotal up` and `cotal down`, run on Windows. Each
  background service runs under a detached custodian that creates the program inside a job object,
  which allows no breakaway and ends every member when the custodian exits. The instance records the
  machine, the account's SID and the custodian's pin in place of a UID and boot ID. The machine is the
  system ID Windows documents for a publisher's apps (`GetSystemIdForPublisher`), with the TPM, UEFI
  or registry source it came from; a service start refuses when Windows has none. Commands reach the
  custodian over a named pipe with a per-instance capability that both sides prove on every request. A
  stop terminates the whole job, and `service status` reports `members-running` when the program
  exited while its job still holds processes. A manager is woken for its native stop through its
  cooperative local stop request. A foreground start, and a manager stop that would keep agents in its
  job, refuse on Windows. `cotal down` refuses a member whose program exited while its job still runs,
  and names the stop that ends it.
- Updated dependencies [091498f]
- Updated dependencies [446fd91]
- Updated dependencies [bdafbf9]
- Updated dependencies [0379e03]
  - @cotal-ai/workspace@0.101.1
  - @cotal-ai/core@0.101.1

## 0.101.0

### Minor Changes

- fc17f8f: `cotal auth mint` now gives a fixed-profile credential a 24-hour lifetime by default. It used to issue one with no expiry claim, which `cotal doctor auth` then reported as a finding for good. `--expires-in` and `--expires-at` still set another lifetime. The new `--no-expiry` issues an unbounded credential and records that request beside the file, in `<file>.no-expiry.json`. `doctor auth` reports such a credential as a `CREDENTIAL_UNBOUNDED_BY_REQUEST` warning with its ways out and exits 0, while any other unbounded agent credential stays a finding. Endpoint callers (`auth mint --endpoint`) keep their behavior. A process that reads a newly minted file for more than a day, such as a dashboard given `--creds`, needs a longer lifetime or `--no-expiry`; see the upgrading guide.
- 4a5d53d: Bare `cotal down` on a legacy root now refuses `LIFECYCLE_BLOCKED`, before it stops anything, while
  a saved service in the space still runs or cannot be verified, as a controller stack's `down` does.
  The refusal names each one with the `cotal service stop` that stops it, then `cotal down` again, and
  a stopped service does not block. It used to stop those services itself first, under the one
  `down`, with no confirmation of their own. The dry run warns with that refusal, and its JSON lists
  the instances as `serviceChecks` in place of `serviceStops`. This is a behavior change; see the
  upgrading guide.
- 77c915a: A command run without `--space` inside a project folder whose root has one space now targets that space, even when another space is selected, and the note under its `Mesh:` heading says the selection applies outside the folder. Before, it targeted the selection with a `SELECTION_NOT_FOLDER_SPACE` warning, which is now given only in a folder with several spaces. `cotal up` also says when it selects the space it started.
- 2fef607: Under `--json`, a command that refuses or fails now writes its envelope alone and no text report on stderr. This changes every command's JSON refusal: until now each one also printed the human report on stderr beside the envelope, so a script reading both streams saw the refusal twice. The text report still goes to stderr when the envelope cannot be written to stdout, and exit codes are unchanged.
- eabc54d: `cotal service add` now saves a definition with the root of the space it is added in. A definition a
  forgotten space of the same name left in another folder refuses `service start`, `restart` and
  `install` there with `CONFLICT`, naming that root and `cotal service remove <name> --space <space>
  --yes`, instead of running in the forgotten project's folder. `cotal service` marks such a
  definition `inherited from <root>` in a new `Added in` column, `service show` lists `Added in`, and
  `--json` gives each definition its `root` and `rootMatch`. A definition file that sets `root` is
  refused `SCHEMA_INVALID`. Definitions saved before this release start as before and show `root not
  recorded`. An earlier release refuses a definition that records a root; see the upgrading guide.
- 2885924: A bare `cotal spawn [<persona>]` runs the application in this terminal again, on every kind of
  mesh, with no manager involved, as it did before 0.91.0. Since 0.91.0 it launched through a manager
  and attached, so several live managers refused it or asked which to use. A manager runs a launch
  only with `--detach` (`-d`) or `--on <instance>`, and `spawn -d` still asks which of several
  managers to use on a terminal.
  `--restarts`, `--creds`, `--json` and `--plain` without `-d` or `--on` are refused with a Next that
  adds `-d`. A missing persona names `--file <persona.md>`, and a remote user-auth mesh that advertises
  no agent-provisioning endpoint names `-d` among its remedies.
- b33c321: Replace the console's colon command prompt with a Ctrl-P modal palette. Selecting Spawn agent opens a guided form using the existing CLI launch path; searching for new agent finds the same action.
- bd52202: `MeshAgent` now arms the `turn-pending` poll and the turn-boundary re-poll only when `config.managerInstanceId` (`COTAL_MANAGER_INSTANCE`) is set, and `Manager` (`spawnDelegated`) / `delegatedSeatCommand` / `cotal spawn` (`applyHandoffManagerInstance`) now carry `COTAL_MANAGER_INSTANCE` alongside local spawn, restart, and resume so every manager-launched seat polls its launching manager while a directly connected session never polls a manager. `cotal spawn` with `COTAL_MANAGED_HANDOFF_FILE` now requires `COTAL_MANAGER_INSTANCE` before any broker or exchange plane is touched (`COTAL_MANAGED_HANDOFF_FILE requires COTAL_MANAGER_INSTANCE`; a newer CLI child under an older manager or runtime refuses every delegated launch). Because only manager-launched seats poll, `notePullTrouble` now reports `no responder answered` once per outage while keeping only the startup `still reconciling` window silent.
  
  `DelegatedSeatLaunch.managerInstanceId` is now required, and a CLI with this change refuses a managed handoff without `COTAL_MANAGER_INSTANCE`, so managers and the CLI must be upgraded together.
- a3e2776: A bare `cotal up` in a new project now names its space after the project folder. Two new folders,
  such as `~/Desktop/alpha` and `~/Desktop/beta`, start the spaces `alpha` and `beta`, where both used
  to start `main` and the second refused. A folder name that is not a valid space name, such as
  `My Project`, refuses `USAGE_INVALID`. A name another folder on this machine already registered or
  prepared refuses `CONFLICT` and is not taken over. Both refusals write nothing and name
  `cotal up --space <name>`. `--space` still names the space, and a folder whose records already name
  one, or a folder inside such a project, keeps its recorded space. The receipt says the space was
  named after the folder.
  
  This changes a default. A script that ran a bare `cotal up` in a new folder and then addressed
  `main`, such as `cotal spawn --space main`, now finds the folder's name there. Pass `--space main` to
  `up` to keep the old name.

### Patch Changes

- 2faaf50: `cotal history --creds` with an agent credential now reads the channels its grant names. It used to try the multi-channel read only observer and admin credentials may make, and refused with "may not read #general" although the credential's ACL named #general. An agent credential now reads one channel at a time under the lifecycle its own history grant names, as a user-auth identity does. A channel the grant leaves out is refused with the channels it does name, and DM history and `--since` by sequence are refused for it.
- 39e0c7a: `auth mint --identity` keeps the read channels, post channels and role of the agent credential it names, unless a flag replaces one, and the mint receipt and JSON list the grants. `auth mint --out` records the file it wrote, without the credential, and `doctor auth` lists each such file with its state and expiry, naming the mint that renews it or, for a revoked key, a mint with a new key.
- e7cb03f: `cotal auth mint <label> --replace` replaces the label's standing credential when it has expired or has no expiry claim, and removes the no-expiry record beside it. Before, an expired or unbounded label could be cleared only by removing its file inside `.cotal` by hand. A still-valid credential refuses `CONFLICT`, naming its expiry. `cotal doctor auth` names that command for an expired or unbounded label's file, and the refusal for an existing label says `--replace` replaces one that has expired.
- 0d1dfc3: `cotal auth revoke-credential <public-key | creds-file>` stops one credential that `auth mint` wrote and keeps the space's store and every other credential. Until now the only way to stop a leaked minted credential was to rotate the space identity with `reset space`, which also removes the store and its history. The command records the key in the space's account JWT `revocations`, so the broker refuses it from its next start. It works on a stopped space, and on a running one it refuses and names the route: `cotal down`, the revocation, then `cotal up`. `auth mint --identity` refuses a revoked key. `auth retire`'s next step and doctor's guidance for an unbounded credential now name the revocation first and the identity rotation as the wider step.
- d0c3cd7: On a terminal, a command whose quoted path holds a backtick now wraps as one word. The `team boot`
  refusal on a running stack and the `status` hint after `space forget` name such a command between
  double backticks, as Markdown writes code that holds a backtick, and the wrap keeps it whole to the
  matching pair. Before, at 80 columns in a folder named ``tick`q "dq" $(x)``, the path's own backtick
  ended the command and the line broke inside the quoted path. The command between the backticks is
  unchanged.
- fd3131e: `backup verify` now names the file and fault for every artifact it refuses, and `backup restore`
  refuses those artifacts instead of reporting an unconfirmed outcome. A snapshot replaced by a
  symbolic link, a FIFO or a link to a device, a manifest name with `../` or an absolute path, a
  manifest that is a link, larger than its limit or not a JSON object all gave verify one generic
  sentence with no file. Restore named some of them but exited 3 `OPERATION_UNKNOWN` although nothing
  was attempted. Both now refuse `SCHEMA_INVALID` with `file` and `fault` (`not-regular`,
  `invalid-name`, `manifest-not-regular`, `manifest-too-large` or `manifest-invalid`), never print a
  declared name that is not a plain file name, and restore leaves the preserved cut unchanged.
- e67c925: `backup verify` and `backup restore` now name a manifest whose file inventory is not valid. A
  manifest that declared a file twice, a file record with an invalid size, SHA-256 or kind, a
  checkpoints file over its limit, more or fewer than one checkpoints file, stream records that match
  no snapshot, or an invalid space gave verify one generic sentence with no file, and restore exited
  3 `OPERATION_UNKNOWN`. Both now refuse `SCHEMA_INVALID` with `file` `manifest.json` and fault
  `manifest-invalid`, and a reason that prints no manifest value.
- c74a853: `backup verify`, `backup restore` and `up --restore` refuse an artifact that another local account
  could write. A copy whose folder and files were group-writable verified and restored without a
  word, although its hashes cannot show a consistent rewrite. The artifact directory, each file in it
  and each directory above it now follow the protected-path rule `space create` applies to a project
  root: an unsafe one refuses `PERMISSION_DENIED` (exit 2) before a restore stages or changes
  anything, naming every such path and one remedy such as `chmod g-w <paths>`.
- afb8c3d: `backup create` with a process listening at the preserved cut's recorded address now refuses
  `CONFLICT` and says to stop the process that listens there, then run the same `backup create`
  again, as `backup restore` and a resuming `up` do. It used to refuse `LIFECYCLE_BLOCKED` saying it
  did not establish an eligible stopped preserved cut, with the cause only in its native detail.
- fff2909: A `backup create` that loses to another operation now says what holds the root. One that finds the
  maintenance lock held names the operation, such as another `backup create` or a restore, its process
  and since when it has held the lock, and asks to wait for it. One that runs during a restore names
  that restore attempt and its process and asks to wait, where it used to suggest rolling the restore
  back. These refusals name no attempt of their own, because they journaled none. A refusal that names
  a running restore or backup process now also says when it started.
- 900126a: A `backup create` that runs out of disk space now says so. It failed with only the raw
  `ENOSPC: no space left on device, write` as its detail, which names no file, and a Next that sent
  the user to inspect the maintenance state before a recovery that was not needed. The failure now
  names `ENOSPC` (or `EDQUOT`), the directory it was writing (the store copy under
  `.cotal/maintenance/attempts` or the backup destination), and that the attempt removed what it wrote,
  published nothing and left the preserved cut ready. Its Next frees space on that disk and runs the
  same create again.
- db055f9: `backup create` refuses a destination in a folder another local account could write, with the same
  `PERMISSION_DENIED` refusal and `chmod` remedy that `backup verify` and `backup restore` give for
  the artifact there. It used to publish the artifact, which its own verify then refused.
- c354f1d: A `backup create` that failed after removing what it wrote now names the retry. Its Next said to
  inspect the preserved-cut maintenance state and original attempt before a recovery, though the cut
  was still ready and nothing needed recovering. It now says the cut is still ready and names the same
  `backup create` to run once the cause in the native detail is fixed.
- 3453959: `backup create` now refuses `USAGE_INVALID` (exit 1) a destination inside a path `cotal clean all`
  removes, such as `.cotal/auth` or the space's `.cotal/space.<hex>` folder, and writes nothing.
  Before, it published the backup there, and the next `clean all --force` removed it with the space's
  identity.
- 99096c5: `backup create` now refuses a destination inside the preserved store with `USAGE_INVALID`, and one in
  a folder this account cannot write with `PERMISSION_DENIED` naming that folder and `chmod u+w`,
  both before it claims the cut. They were reported as an ineligible cut and as an `OPERATION_FAILED`
  attempt, with the cause only in the native detail.
- 8084ce9: `backup create` now refuses `USAGE_INVALID` (exit 1) when checking its destination encounters a
  non-directory parent (`ENOTDIR`) or a symbolic-link loop (`ELOOP`). It names the destination and
  parent and suggests choosing a directory parent. Previously it blamed the preserved cut. The
  refusal occurs before an attempt is started and leaves the preservation journal unchanged.
- 3699f69: `backup create` into a folder that does not exist, and `backup restore` or `up --restore` of a path
  that names nothing, now refuse `TARGET_NOT_FOUND` (exit 2) before they take any lock, naming the
  path and whether the folder or the artifact is missing. Create refused `LIFECYCLE_BLOCKED`, saying
  no eligible preserved cut was established, with a raw `ENOENT` as detail and a Next about
  maintenance state. Restore exited 3 `OPERATION_UNKNOWN` with the raw `ENOENT`.
- 46206aa: `backup verify` and `backup inspect` now read an artifact named through a linked folder at its real
  path, as `backup create` and `backup restore` do. They refused it as missing, unreadable or changed,
  though the same artifact matched by its real path.
- 5658367: `backup verify` and `backup inspect` of a path that names nothing now refuse `TARGET_NOT_FOUND`
  (exit 2), naming the path and whether its folder or the artifact is missing, as `backup restore`
  does. They refused `SCHEMA_INVALID` (exit 1) with one generic sentence that named neither.
- 4031785: `backup inspect` and `backup verify` of a file, or of a folder that holds neither a manifest nor any
  file a backup create writes, now refuse `TARGET_NOT_FOUND` and say it is not a backup artifact. Such
  a folder was called an interrupted backup and pointed to an attempt and a recovery that did not
  exist. The empty folder of a create in this root that was interrupted before it wrote a file is still
  named as its incomplete artifact.
- d75adb5: `backup recover` now ends its receipt with the next steps. After a stale restore is rolled back it
  names `cotal up` and `cotal backup restore <directory>`. After an interrupted backup is released it
  names `cotal backup create <directory>` and `cotal up`.
- 7dbfedb: `backup restore` now refuses a manifest that names an invalid space as an invalid manifest. A
  space longer than 200 characters passed restore's manifest checks and reached the same-space check,
  which refused `CONFLICT` and printed the whole space in its message, remedy and JSON target. Restore
  now refuses it `SCHEMA_INVALID` with `file` `manifest.json` and fault `manifest-invalid` before it
  stages anything, as `backup verify` does, and prints no space.
- 50e2f37: `backup create --store-dir` naming a folder that is not the cut's preserved store, such as an empty
  one, now refuses `CONFLICT` and names both stores, with the way out. It was reported as an
  ineligible cut with a maintenance next step.
- b0257f2: A full backup of a static-auth or open mesh now holds the workflow runs: the WFJ step journal, the
  records store and the run admission store. A run that waited at a checkpoint or a timer is back after
  a full restore, and the manager takes it over. Before, a full restore recreated those stores empty,
  so every run was gone. The records store's endpoint authority rows roll back to the cut with the
  runs. A user-mode full backup still holds no run store, because the records store's lifecycle heads
  name credential rows in the auth store, which a backup does not carry. Artifacts use the manifest
  format `cotal-space-backup/v2`; a `v1` artifact still restores and holds no workflow run. Each
  restore now lists what it restored and what it recreated empty, and says why when it holds no run.
  Backup also accepts the stopped goal-index watcher of an open mesh's manager.
- 0c9e498: A refusal that repeats an over-long argument, such as an unknown command or subcommand, a space name given to `use` or `--space`, or a run id, now shows its first 128 characters and its length. A 100000-character value used to print a line as long as itself. The command still checks and uses the whole value.
- 9e2159f: A `nats-server` that `cotal up` started on the retained launcher and that exits before it answers
  now fails the start as `OPERATION_FAILED`, exit 5, instead of an unconfirmed outcome. The message
  names the file, its exit code or signal, and its log, and the next step is to read that log, then fix
  the file or take it off PATH and run `cotal up` again. A broker that is still running when the wait
  ends is still reported as unconfirmed.
- 9599a4f: `cotal service add <name> --preset broker` saved a `--server` that was no broker address, such as `"hallo welt"` or a port with a letter in it, while it checked `--config` and `--binary`. `service start` then refused `UNSUPPORTED` naming neither the option nor the value, and recorded a failed instance. `add` now refuses that address before it saves anything, from the preset, a `--file` definition or the guided prompts, quoting it unless it holds an `@`. A definition saved earlier names its `server` option and the address on start, with the steps to add it again.
- da20082: `cotal up` no longer stops at a `nats-server` on PATH that a broker start would refuse as
  unprotected, such as one in a group-writable Homebrew folder on macOS, when the bundled
  `nats-server` passes that check. It runs the bundled one and never runs the one on PATH, and
  `cotal status` names the one it passed over and why. A protected `nats-server` on PATH is still
  the one used. A `nats-server` that fails the check is never run, not even for its version. When the
  bundled one is missing or fails it too, `cotal status` shows why, and the broker start refuses
  before anything runs, naming each folder and its fix.
- 68703fa: `status` and `send` now name a broker store that cannot be written. When nats-server could no longer
  write its JetStream store, as on a full disk, `status` stayed all green and each `send` reported only
  that the message may have been stored; the cause was only in the broker's log. For a broker whose
  log is on this machine, `status` now shows a `Store` row with the time, cause and file the running
  broker logged, and its first Next stops the stack so space can be freed before `cotal up`. A `send`
  whose storage acknowledgement times out after such a failure names it and says the message was
  probably not stored; it stays `OPERATION_UNKNOWN`. JSON `status` carries the observation as
  `result.store`.
- 1e75421: `space add`, `meshes add` and the `meshes add` prompt refuse a broker URL with a user name or password in it in the words every command uses for such a `--server`, with the same next step: name the broker URL without `user:password@`, and pass the credential with `--creds`, a login or the space's own trust. Before, a connection bundle's server and a typed address were refused with an older sentence and no next step. A value that does not parse as a broker URL is no longer echoed in part when it carries a user name.
- 7a55775: Clarify that channel names retain their case and auth mint reads the persona for the requested label. A missing persona does not inherit the default persona's grants.
- 2889928: `cotal channel members` refuses a name the space does not have with `TARGET_NOT_FOUND`, as `channel remove` does, when the feed observes no member for it, so a typo or a name in another case no longer reads as an empty channel. `--follow` shows the census again only when it changes, and its view no longer offers the follow it is running.
- 425a420: `cotal channel set` and `channel defaults` receipts say `Replay: on` or `off` and label the delivery class `Delivery`, as `channel show` does, instead of printing `Replay: true` and `DeliveryClass`.
- 4e37dcf: `cotal channel remove` now refuses a name with no saved entry and no retained messages with `TARGET_NOT_FOUND` (exit 2), before the confirmation and before any purge, and lists the registered channels. A name that differs from a registered channel only in case names the registered spelling. Before, `channel remove nosuch --purge --yes` or `channel remove General --purge --yes` for a space holding `#general` reported `Nothing removed` with 0 messages purged and exit 0, so a typo read as done. A channel with retained messages and no saved entry is still a `no-op`, and `--purge` still deletes its messages.
- 30e470b: `cotal channel set <name> --replay off` and `channel defaults --replay on` say that `--replay` takes no value and name the flag to use, rather than refusing a second channel name.
- 53d6bc5: `cotal channel set`, `channel defaults` and `channel remove` warn `CHANNEL_SEED_REAPPLIES`, naming the file, when the root's default `.cotal/channels.json` sets a field they changed or names the channel they removed, because the next start of the stack writes the file's values back. The edit used to succeed with no word about the seed, and the next start undid it silently.
- 0af0377: `cotal channel set` and `channel defaults` write nothing when the entry already holds every value given, and report a `no-op` receipt, `Channel unchanged` or `Channel defaults unchanged`, instead of rewriting the entry and saying it was saved. `seedChannelRegistry`, `writeChannelConfig` and `writeChannelDefaults` resolve whether they wrote.
- b8dab7e: A channel name holding `*` or `>`, such as `gen*`, now gets `name one concrete channel, without wildcards` from `cotal send -c`, `cotal chat <channel>` and every `cotal chat --stdio` request that names a channel. Before, a `*` inside a segment got the channel grammar's rule, which lists `'*'` and `'>'` as allowed segments, and a stdio request gave a third wording. A stdio channel refusal now carries the same sentence as `cotal send -c`, without a field prefix.
- cc550f9: A default `.cotal/channels.json` that is not JSON makes `cotal up` refuse `SCHEMA_INVALID`, as the docs say and as invalid content in it does, with the classified report and the same remedy. It used to refuse `USAGE_INVALID` and print the whole `up` help.
- 431273b: `cotal up --channels` reads its seed file once. A seed given as a pipe or a FIFO, such as `--channels <(…)`, was opened three times, so the second read found it empty and refused valid JSON, or waited forever on a FIFO fed once.
- b8cac74: A `chat` direct message to the session's own name, when no other participant carries it, refuses with `USAGE_INVALID` saying it is the session's own name. It used to say no peer had that name.
- 11b6fca: `chat` reports a full inbox as one `inbox` gap with the number of messages it dropped, instead of
  one gap per dropped message. A channel replay past the 500-message inbox now prints one line.
- e899508: `chat` on a static mesh with no manager running now refuses `TARGET_UNAVAILABLE` (exit 2) at once
  and names bare `cotal up`, as the run verbs do. It waited out the 10-second describe deadline and
  exited 3 `OPERATION_UNKNOWN`, saying the outcome of `chat-session-open` was unconfirmed and
  describing the ep.v1 rail, although no session had been asked for.
- 7dab105: The `cotal chat` recipient picker (`:to #<channel>` in `--plain`, and typed text in the terminal view) now refuses a channel name holding `*` or `>` with `name one concrete channel, without wildcards`, the sentence `cotal send -c` gives. Before, `#team.*` got a picker-only wording and `#gen*` got the channel grammar's rule, which lists `'*'` and `'>'` as allowed segments.
- 4bccc29: `cotal chat --plain` runs a slash command typed at the send question and asks the question again, says when a new draft replaces a kept one, reports an unfinished `:multi` message at the end of input, and names `:to` rather than the Tab key when no recipient is set.
- 2b45f3b: The CLI docs and the `cotal channel show` card now state the bound on a chat session's replay. A
  session holds at most 500 unread messages in its inbox, so a channel that holds more replays only
  its newest 500. The card said only `Window: retained history`, and the docs named no bound. The card
  adds a `Chat replay` row when replay is on, taken from the same constant the session uses.
- eddbfb2: A `chat` reply by a name that only senders no longer present carry, such as several one-shot `cotal send` commands from one login and host, now says they are no longer present and names how to answer one message: `/reply`, or over `--stdio` a `dm` to the message's `from.id` with `replyTo` set to its id.
- adbc4d0: A `chat` session whose `--name` another live participant already carries now warns at join, naming that participant. A `send` to a name several participants share lists each full identity with its kind and the local time its process started, so the remedy says which is which.
- 39817ec: `cotal chat` slash commands that take a channel (`/join`, `/leave`, `/info`, `/quiet`, `/mute`, `/normal`) read it with or without its `#`. A `#` no longer doubles in their answers, and a refused `/join` suggests `cotal chat <channel>` without a `#` a shell would read as a comment.
- eca0324: A chat session opened on no channel that tries to post to or read one now names `cotal chat <channel>` with the flags it was started with, such as `--stdio` and `--space`, so a program on the NDJSON protocol is not sent to the interactive view.
- f170317: `cotal chat` now refuses a typed `@<name>` that names no present peer and no sender the session heard from when it is chosen, with the reason a send to it would get, and opens the recipient list. Before, `:to @niemand` in `--plain`, or `@niemand` in the terminal view's picker, became the recipient, and every confirmed message then came back `denied: no peer "niemand" in this space`.
- e549fa3: `chat` on a static mesh whose manager is registered but does not answer, such as one that crashed,
  now refuses `TARGET_UNAVAILABLE` (exit 2) once the describe deadline passes, with `cotal status` as
  the next step, as the run verbs do. It exited 3 `OPERATION_UNKNOWN` saying the outcome of
  `chat-session-open` was unconfirmed, although an unanswered describe means the request was never
  sent.
- 57ee1ec: `clean all` now says when it removes a space's trust that the full backups taken before it no longer
  restore into the root, in its dry run and in its receipt. A full backup is bound to the trust it was
  taken under, and nothing said so before the clean; only `up --rotate-sys` was documented. The docs
  now say so for `clean all`, say that `backup inspect` and `backup verify` do not check an artifact's
  trust against the root, and say that a registry restore, `--only registry` included, does not check
  the trust state.
- d27276f: `clean all` now says in its dry run and its receipt that a full backup it leaves unrestorable still
  restores its registry with `backup restore <dir> --only registry`, and that chat and DM history then
  start empty. The docs say the same beside the backup restore rules and beside the identity rotation
  that `auth mint` and `auth retire` recommend, which also leaves earlier full backups restoring only
  their registry.
- b670a73: `clean store` and `clean all` now refuse an existing linked store path with `CONFLICT` (exit 2),
  naming the link, its target and a repair step. Previously they returned a generic real-directory
  error with no next step. Neither the link nor its target is removed, including in dry runs.
- 5b41e13: `clean store` and `clean all` on a root that holds maintenance state now name the step that moves
  it on. After a plain `down --preserve-state` they refused with exit 1, no Next and "use the recorded
  restore recovery or fallback-cleanup command", but `backup recover` and `backup cleanup-fallback`
  take no `preserve-` id. They now refuse `LIFECYCLE_BLOCKED` (exit 2), name the attempt and its
  state, and give as Next the step `cotal status` shows for that attempt, such as resuming a
  preserved cut with bare `cotal up`, followed by stopping the mesh and running the clean again.
- fd4afc3: A `clean store`, `clean all`, `reset store` or `reset space` whose removal stops inside the
  `.cotal-clean-<id>` folder the store was moved to now ends `OPERATION_PARTIAL`, naming that folder,
  what is left in it and the step that removes it. It used to end with the raw error, or as an unknown
  outcome that named only the original store path, which no longer existed.
- 46886e9: `cotal clean store` and `cotal clean all` without `--store-dir` now read the store the root's last
  broker served, as `cotal up` does. After `backup restore --store-dir` or an `up --store-dir` and a
  plain `down`, they removed nothing and said "nothing to clean - no local state found" while that
  store held the data and `up` refused and named it. While `.cotal/nats` holds no JetStream data and
  that store does, they now remove it, and the dry run names it.
- dedb739: Separate liveness reporting from mismatch pruning. `pruneMesh(space)` now serves only
  mismatches, without a reason argument or `PruneReason` type. `pruneStaleMeshes()` keeps
  registrations and returns only `offline`, removing the always-empty `MeshSweep.pruned`
  field and redundant registry reads. Callers handling an unreachable target must report
  it offline without calling `pruneMesh`.
- b99a8b7: `clean store`, `clean all` and the other `clean` targets that remove files, their dry runs, and both
  `reset` routes with their previews now refuse in a folder whose `.cotal` is a link. The refusal is
  `CONFLICT` (exit 2), or `TARGET_NOT_FOUND` for a link that leads nowhere, and nothing is read or
  removed through the link. A dry run used to list removals through the link, a reset reported an
  unknown outcome, and `clean` in a folder whose `.cotal` led nowhere removed the store of the project
  folder above it.
- d09c93e: `clean restore-attempt` refusals, and `clean restore-fallback` without `--attempt`, are now refusals with a code and a Next naming the attempt the root records and its step. An option given with no value, such as a bare `--attempt`, is refused naming the option and its placeholder instead of the parser's "argument missing".
- fec0c77: `cotal clean restore-fallback` refused without `--discard-history` now prints its refusal and the
  command to run without the whole `cotal clean` help under it, as `backup cleanup-fallback` does.
- b480f1d: `clean restore-attempt` and `clean restore-fallback` without `--force` now name the command to run with its `--attempt`, and a repeated `clean restore-fallback` refuses with `TARGET_NOT_FOUND`, saying the restore has settled and naming `cotal status`, instead of a bare "maintenance journal does not exist".
- 69f06b0: `cotal clean store`, `clean all` and the restore targets refuse `--space`, `--server` and `--creds`
  `USAGE_INVALID` before local cleanup inspects or removes root state. They act on the root of the folder they run in
  and used to ignore those flags, so `clean store --space <other> --force` removed this folder's store.
  `clean history` keeps them.
- 764f39a: `clean store`, `clean all` and `reset store` no longer delete files that sit beside the JetStream
  store. With `--store-dir` naming a folder that also held other files, `clean store --force` removed
  the whole folder, and a folder holding only a planted `jetstream/` beside a note passed the store
  check and went too. A store directory that holds anything besides its `jetstream` directory and
  `.cotal-store-id` marker now refuses `CONFLICT` (exit 2), names those entries and removes nothing,
  and a cleanup removes those two entries by name before the empty directory. `clean store` and
  `clean all` take `--dry-run`, which lists what they would remove and removes nothing. `up` warns
  when `--store-dir` names a folder that holds other files.
- 8d6bc93: Reject extra positional arguments before any cleanup runs. Previously `clean history <channel>`
  ignored the channel name and purged all channel history, and extra words did not prevent local
  store deletion. Quote an explicit store directory in the dry-run force command so paths with
  spaces or shell characters remain one argument. Valid cleanup scope and missing-directory no-ops
  are unchanged.
- 0700ea1: Every `✗` failure line the CLI writes now shows a control character in the text it quotes as an
  escape such as `\u001b`, as the usage refusal line already did. That covers `topology`, `meshes`,
  `down -f`, `spawn`, `up`, `join`, `clean`, `attach` and the managed handoff. A path or argument
  holding a terminal escape can no longer move the cursor or change the screen.
- ea76a77: Shell completion no longer writes a warning, such as the one for a prepared space record it skips,
  unless `COTAL_COMPLETE_DEBUG` is on. Unset, empty, `0`, `false` and `off` keep it quiet, as they do
  for a completion's errors. The docs now say the shell stubs discard stderr, so a completion's
  diagnostics show only when `cotal __complete <words>` runs by hand.
- 968d99e: Shell completion no longer offers a candidate that holds a control character, such as a persona
  file named with an escape sequence or a newline. Before, the stub put that escape into the shell's
  candidate list, where a listing wrote it to the terminal, and a newline in the name added candidate
  lines of its own, including a forged directive. `cotal persona` still lists the file with the
  characters escaped.
- a2fbb5e: `cotal completion uninstall` now removes a `.bashrc` or `.zshrc` that `install` created when nothing else is left in it, instead of leaving an empty file. A startup file that was there before install stays, even empty.
- 9736397: Shell completion now lets the shell complete a file name for every `--creds`, including on `status`, `history`, `watch` and `who`, which offered none.
- 011734b: File arguments tab-complete in bash and zsh. A completer that answers with the `default` directive,
  as `team check <file>`, `up -f` and `--channels` do, now gets the shell's own file names. The stubs
  used to drop that directive, and bash registered the completion without `-o default`. A value with
  a fixed set of choices still offers no files. Reinstall the stub with `cotal completion install`.
- 16b0100: Shell completion now offers file names for `space add --root` and `--file`, and no longer offers them for `channel set --window`, `--desc` and `--instructions`, which take a duration or text.
- 0282994: `run start --file`, `run simulate --handler`, `auth mint --out` and `--identity`, and `--creds` on a
  command with no completer of its own complete from the shell's file names. A flag declares that with
  the new optional `FlagSpec.completion: "files"`. `spawn` completes the personas of a prepared space
  that is not started, as `persona show` does.
- 351d213: `cotal completion install` and `uninstall` now name the way out when they refuse an owned stub or startup block you edited. The new `--force` rewrites (install) or removes (uninstall) the recorded stub and each block from `# >>> cotal completion >>>` to `# <<< cotal completion <<<`, keeping startup content outside the markers. A block whose end marker is gone is still refused, naming the file to edit by hand. The stub refusal names the stub, and for an integration you modified bare `cotal completion` offers `install` and `uninstall` only with `--force`.
- dbbd7f5: Shell completion now offers the values the CLI knows without contacting the mesh. Every `--space` offers the spaces registered or prepared on this machine, as `cotal use` does. `config get`, `set` and `unset` offer the keys, and `config set color` and `config set harness` offer the values a write accepts. `docs` offers its pages, `watch --view` its views and `space add --mode` its modes. `history` and `channel show`, `members`, `set` and `remove` offer the channels the target space's personas declare, as `send -c` does.
- 7d489d2: Shell completion offers values the CLI already knows offline. `config get`, `set` and `unset`
  complete the preference keys, and `config set color` and `config set harness` their values.
  `docs` completes page names. `watch --view` and `space add --mode` complete their values, and a
  `--space` value completes from the registered and prepared spaces on every command.
- cfeaddd: `cotal completion` receipts now say what happened. A repeated install says nothing needed changing, rather than that owned material was changed. An uninstall blocked by a hand-added line that sources the stub names the startup file and the line. A failure whose confirmed changes are file paths lists them, rather than a receipt count with advice to choose structured output.
- 472af1c: The bash and zsh completion stubs now complete file names where a value takes a path, such as `cotal team check <TAB>` or `--creds <TAB>`. They dropped that hint before, so a path never tab-completed. Run `cotal completion install <shell>` to refresh an installed stub.
- 07c9bbf: Bare `cotal completion` names a group-writable or otherwise unsafe config folder once, with the `chmod go-w` that fixes it, instead of two unnamed lines per shell. Files that do not exist under it are reported missing, so a machine with nothing installed is a complete report (exit 0), and Next offers the `chmod` first, never an `install` or `uninstall` that would refuse, and `uninstall` only when something is installed.
- ac717a2: `cotal completion install` and `uninstall` now name a shell that `SHELL` points at but completion does not support, such as tcsh, and refuse it with `UNSUPPORTED` (exit 2), instead of calling the shell unknown and printing the whole help.
- eb524ed: Name the folder when `ZDOTDIR` points `cotal completion install` at a missing one, with the `mkdir` that creates it, and name the startup file and `ZDOTDIR` a completion ownership record was installed under when bare `completion` runs without that `ZDOTDIR`, instead of saying only that the record could not be read safely.
- 4a6b4d9: `cotal status --components` now prints `static reconciliation not reported by this manager build` only when a manager answered without that field. A manager row refused over an unattributable or unreadable pidfile, a missing login, or a probe that reached no manager no longer carries the line, so the row points at the pidfile, credential or rail it names instead of at the manager's build.
- afec9b6: A file where the Cotal config folder belongs no longer breaks every command with a misleading
  "corrupt extensions manifest" error. Help, version and docs run, and every other command is refused
  with `SCHEMA_INVALID` naming the file and how to move it aside, with the envelope under `--json`.
- 5b85d02: With nothing selected, `cotal config` and `cotal config get` now read through the space `spawn` uses from this folder, its prepared or registered space or the only running one, so they show the per-space value a launch here takes. They used to show your defaults while `spawn` used the folder's value. A `config set persona` there warns with `PERSONA_NOT_FOUND` when that space's catalog does not hold the persona. The report names the space with "(this folder's)" or "(the only running space)", and `--json` gives `scope.from` as `folder` or `running`.
- a0dbd6d: `cotal config --space <name>`, `config get <key> --space <name>` and `config unset <key> --space <name>` now refuse a space that is not registered, not prepared and holds no saved value with `TARGET_NOT_FOUND` (exit 2), naming the known spaces, as the docs say. Before, they exited 0 for any name. A space that still holds a saved value can still be read and unset, so a value left for a removed space can be cleared.
- 4ce35fe: The `cotal config set --user` and `unset --user` receipt now gives the effective value a command here uses, through the selected space or the folder's, as `spawn` resolves it. It used to give your defaults' value, such as "Effective value: pi" while `spawn` used the space's `opencode`. When that space's value outranks the one you wrote, the receipt warns with `PREFERENCE_SHADOWED`, and a `persona` that space's catalog does not hold warns with `PERSONA_NOT_FOUND`, as a write without `--user` does.
- 53071c0: `cotal config set <key> <value> --space <name>` now refuses a space that is neither registered nor prepared on this machine with `TARGET_NOT_FOUND`, naming the known spaces, instead of saving a value that no command would ever read. `config unset --space` still takes any name, so a value left for a removed space can be cleared.
- 670bfa4: A question that defaults to No, such as the one before `history clear`, `down`, `channel remove`,
  `persona remove` or a reset, now confirms only on a typed `y` or `yes` and Enter. Enter alone or
  any other text keeps No. The Yes and No toggle it replaced took stray text as Yes: `h`, `j`, `k`
  and `l` moved its selection and a `y` inside a word submitted it, so typing "ok" and Enter cleared
  history. Its title now breaks at spaces with each continuation line under the text, where the
  toggle's wrap could move the break space onto the next line.
- 7c8564e: A missing `--yes` outside an interactive terminal now refuses in two lines, the refusal and a
  remedy that names `--yes`, as `down` does. `history clear`, `persona remove`, `channel remove`,
  `space delete`, `reset store`, `reset space`, the service and team removals, and the other
  confirmed commands printed the whole command help after the refusal, and several gave no remedy.
- 79b59a7: Ctrl-C, SIGINT and SIGTERM end `cotal console` at any time again. Once its connection was closed for good, after `down`, a credential's expiry or `reset space`, the line stream ignored all three until SIGKILL, and Ctrl-C did nothing in the full-screen view. `console --plain` now also ends on its own when its credential can no longer connect, with the refusal a one-shot command with that credential gets, and a lost connection is one line while it is re-established.
- 5cc55a7: A project folder whose path contained a control character, such as a tab, a newline or an escape character, could be prepared with `space create` but never started: `up` wrote its stack journal and then refused it as an unsupported shape, and every next step led back to `up`. `space create` and `up` now refuse such a path, and a path with a bidirectional formatting mark, with `USAGE_INVALID`, exit 1, before anything is written, naming the character and saying to rename the folder. A folder renamed from such a path is told to adopt its journal with `space create <space> --adopt` and is no longer told to move back.
- 3a12438: `space create` and `up` refuse a folder that is, or is in, a control directory, such as a running project's `.cotal`, judged by the path given and by the path its links lead to. They used to prepare and start a second stack there, writing a `.cotal` among that project's credentials and records. The refusal names the project folder to run from.
- a856d97: A controller stack, the default from `cotal space create` plus `cotal up`, can now renew its `$SYS` credentials. After `cotal down --yes`, `cotal up --rotate-sys` rotates the system account, starts the stack on the rotated configuration, and reports the new generation and expiry in its receipt (`result.rotatedSystemAccount` in JSON). While any member runs, the rotation is refused `LIFECYCLE_BLOCKED` with `cotal down --yes` as the next step, and an open stack refuses it `UNSUPPORTED`. Before, every controller stack refused `--rotate-sys` with "no controller-owned route", so its creds could not be renewed before they expired.
- 60cb005: A relative `COTAL_HOME` is refused with `USAGE_INVALID` before any command runs, since each folder
  would otherwise have its own home. Cotal no longer writes a space, a registry entry, the current
  selection or a service record into a home that another account could replace or write, or under a
  folder another account could write: the write is refused, naming each path and the `chmod` that
  fixes it. A home others can only read is made private on the write, and `cotal setup --skills` no
  longer creates the home readable by others. Reading service records from a home that is not private
  now names the path and the fix.
- 54f044f: A `COTAL_HOME` that names a file, or a path under one, now stops every command except help and shell completion with `SCHEMA_INVALID`, naming the variable and the fix: point it at a directory or unset it. `space create` used to report an unconfirmed outcome with the raw `ENOTDIR` error, and `status` printed that error several times.
- f0d97cd: A project folder whose `.cotal` was a regular file, such as a notes file, was never named as the cause: `status` reported "multiple meshes running:" with an empty list and a path inside the file, `space create` failed with a raw `EEXIST`, `up` blamed permissions, and `send` and `ps` refused as ambiguous. Every command except `help`, `version` and `completion` now refuses with `CONFLICT`, exit 2, before it does anything, naming that file and saying to rename or move it.
- b8fa243: The manager refuses a `COTAL_SERVER` with a user name or password in it `USAGE_INVALID`, exit 1, before it reads, writes or dials anything, as every command refuses such a `--server`, and does not repeat the value. Before, `cotal supervise` and the manager entry printed the value, password included, in a line that blamed `--server`, or dialed it with those credentials dropped.
- 286bccd: A credential file that does not exist now refuses `TARGET_NOT_FOUND` and names the file, in the
  message and the JSON target, wherever a command checks a credential file it is given, such as
  `auth revoke-credential <file>` and `auth mint --identity <file>`. A path that cannot be checked
  refuses `DEPENDENCY_UNAVAILABLE` and names the file and the cause. Before, both gave one pathless
  "missing or unreadable" refusal. A credential file another account can read now has `chmod 600` on
  it as its Next, or a private copy when another account owns it. `auth revoke-credential` given a
  word that is not a user public key and names no file says both.
- 855e595: A credential for another space used with `--server` at the wrong broker now points at a step that works. The refusal's next step says to use `--space <owner>` without `--server`, naming the broker that space is registered at. Keeping `--server` with `--space <owner>` used to end on the generic "credentials rejected … check your creds", and now says the space is registered at another address and to drop `--server` or point it there.
- 403027c: `cotal send` and `cotal channel` with `--creds` now choose how to read presence and the channel registry from the credential's own grant. An agent credential from `cotal auth mint` holds no batched Direct Get row, so it watches the buckets instead, and its send is stored. It used to refuse with `PERMISSION_DENIED` on the presence read, and `channel --creds` failed on the registry read. An operator credential still reads once and leaves no consumer on the broker.
- f0d3143: A command given `--creds` without `--space` or `--server` now uses the selected space, or else the space of the project it runs in, as it does without `--creds`. It used to send the credential toward `main` and refuse with "the default space "main" is not registered here" from the space's own folder and with that space selected. `join --creds` and `join --token` take the selected space the same way. When that space is not registered here, the refusal names it as the selected space or this folder's space, and puts it under `target`.
- 5703dfb: A command about a space whose prepared record cannot be read now names `cotal space forget <space>` as its remedy, without repeating what the file holds, and `status` names a skipped prepared record once instead of twice.
- a62d32d: A prepared space record that cannot be read no longer stops every command. Commands about other spaces skip it with a `PREPARED_RECORD_SKIPPED` warning naming the file, a command about its own space still refuses, `cotal space forget <space>` removes it, and `status` lists it as unreadable.
- 700695c: Process services, and with them a prepared stack's `cotal up` and `cotal down`, run on macOS. The
  direct-process driver pins the machine's hardware UUID, the boot session UUID, the OS user and each
  process's start in microseconds, read through the bundled binding, where Linux pins its machine ID,
  boot ID and start ticks. A background start leads its own process group, and a stop signals and
  waits for that whole group, as on Linux. The manager's native child, its stop reservation and the
  native service identity records accept the same pins. Before, each of these refused with
  `UNSUPPORTED` on macOS. Windows still refuses.
- 1b0b5ca: `COTAL_DEBUG` and `COTAL_COMPLETE_DEBUG` now read `0`, `false` and `off`, in any case, as off, as an
  empty value already was. Before, any of those turned stack traces and completion errors on.
- 04112e9: `cotal service start` of a `delivery` preset beside a running `stack-delivery` no longer calls the
  stack's own delivery a legacy record with a Next that names nothing. Its refusal names the stack
  member that runs the record, with its pid and instance, and its Next is that member's stop with
  `cotal down`. After such a service takes over the delivery, `cotal status` no longer offers
  `cotal up --root` first, which refused while the service ran. It first names that service's
  `svc stop` with its instance, as `up`'s refusal does, then `up --root`. `status --json` carries the
  services under `folder.heldServices`.
- 55f6d70: `cotal status` now says in plain words when the delivery daemon died and its lease has not expired:
  how long the lease lasts, that spawn, retirement and the durable backstop wait until a new daemon
  binds, that joins, DMs and live posts can still work, and that `cotal up` restarts it. It said that a
  dead daemon's ready record still held the lease.
- 30f0900: With the delivery daemon stopped or dead, `cotal status` said the mesh took no join until it bound, while `cotal join`, DMs and live posts went on working. The delivery responder line, the `--components` facts, the `up` warning and core's liveness line now say that spawn, retirement and the durable backstop wait for the daemon, and that joins, DMs and live posts can still work.
- 9f86cca: A `cotal channel set`, `channel defaults`, `channel remove` (with or without `--purge`) or `history clear` that the broker refuses for the credential's grant now refuses with `PERMISSION_DENIED` (exit 2), naming the credential's profile, the write it lacks and the subject the broker refused, and with `--creds` a Next to run it without `--creds` on the operator credential this machine records. Before, an observer, agent or admin `--creds` got `OPERATION_UNKNOWN` (exit 3) saying the change may have been applied, although the broker had applied nothing. A `channel remove` whose credential may not read the channel registry skips the unknown-name check and lets the broker's answer to the remove decide.
- b15b6d7: `cotal despawn` now suggests `stop`, the command the MCP tool and the docs call a despawn, instead of
  `spawn`.
- 4319f8d: `reset space --dry-run` and `space delete --dry-run` now open with a verdict, as `reset store --dry-run` does: the apply is offered with its `--yes` command, or it would refuse with its reason and remedy. `space delete --dry-run` no longer repeats that refusal as a warning after its text report; `--json` still carries it as a warning and as `applyBlockedBy`.
- 85e1f8e: The detached manager and delivery starters read the child's pid once and use that value for the guard, the pid record and the return. They no longer fall back to pid 0 after the guard, a value a caller would have probed or signalled as its own process group.
- e572615: A mistyped command, leading flag, subcommand or option now names the nearest one: `cotal stauts`
  suggests `status`, `cotal --jsno` suggests `--json`, `cotal persona shwo` suggests `show` and
  `cotal status --jsno` suggests `--json`. A word near nothing keeps the plain line.
- 64f6c42: A `cotal spawn` in this terminal now checks its persona and connector before it prints that it is starting the application. A missing persona is refused with `TARGET_NOT_FOUND` and a missing connector with `DEPENDENCY_UNAVAILABLE`, each with its code, Next and exit 2. Before, the banner came first and the refusal was one line with exit 1.
- 4140c10: When the broker's log shows that it disabled JetStream after its store refused a write, as nats-server does for a permission or space error, `cotal down`, `cotal service stop stack-manager` and `cotal up` now refuse `DEPENDENCY_UNAVAILABLE` before any stop or start and name the logged failure, where they ended `OPERATION_UNKNOWN` "timeout" with no next step. Their next step, and `cotal status`, name the way out: end the manager on the stack's host with `kill -TERM <pid>`, run `cotal down`, fix the cause, then `cotal up`. `cotal down --dry-run` names the refusal. The next step of `send` and `status` for a store write failure now names the fix for the logged cause, such as write access for a permission error, instead of always freeing disk space, and `status --json` reports `store.jetStreamDisabled`.
- 6dab23e: `doctor auth` no longer heads a run "No local credential findings" while it prints a warning. With no findings, the heading starts "No findings;" and names what still needs attention: how many exported credential files are expired, near expiry, revoked, issued by an earlier space identity or unreadable, and how many credentials have no expiry by request. The exit code is unchanged.
- 2f76fd7: `cotal doctor auth` in the root of a space registered as open no longer reports a partial result that sends you to "run `cotal doctor auth` in a space's root folder", where it already ran. It now says the space is open and issues no credentials, so there are none to check, and exits 0 as a no-op. The open mode comes from the space's registration; missing signing trust alone is still not read as an open space.
- 2e35fda: `cotal doctor auth --space <space>` run outside that space's root still refuses `AUTH_REQUIRED`
  and reads no other root, and now names the folder the space is registered at, where the same
  command runs. The `NOTHING_REPLACED` warning of `cotal auth mint --replace` names that root too.
  Before, the warning sent users to `doctor auth --space <space>` from any folder, and the refusal
  that came named no next step.
- 906c5ba: `cotal doctor auth` now names a label file's grants in the `auth mint <label> --replace` it gives
  for an unbounded or expired file: its read and post channels as `--allow-subscribe` and
  `--allow-publish`, and its role as `--role`. The replacement is a new key, which holds only the
  grants its mint names, so following the old hint as written minted a credential that could read and
  post to no channel. The revoked-file hint already named them.
- 63cfad9: `cotal doctor auth` names the read and post channels and the role of a revoked or other-account agent file in the mint it gives for a new key, such as `cotal auth mint wer --allow-subscribe general --allow-publish general --role rev --out <new file>`. Before, the mint named the label alone, so the new key it wrote could read and post nothing.
- 49d81ba: `cotal doctor auth` now says how to end an unbounded agent credential, such as one `auth mint` wrote without an expiry: rotate the space identity (`cotal down`, `cotal reset space <space>`, `cotal up`) to retire it with every other credential the space issued, or remove the named file and mint a replacement with `--expires-in` or `--expires-at` to bound it. The finding now says a copy stays valid until the space identity rotates.
- 35ec68e: `cotal doctor auth --fix` mints a delivery or membership-rw credential the NATS client cannot parse again under a new identity when no broker answers, and says so in its result row. Every row that is not a plain re-sign has a `reason`. A refusal because the manager holds the renewal lease names `cotal down`, then `cotal doctor auth --fix`, and `cotal up` warns when it starts with such a membership-rw credential. A missing `membership-observer` or `connection-evictor` credential is a finding, with `cotal down` then `cotal up --rotate-sys` as its repair.
- bb6e1f6: `cotal down --yes` on a root another whole-stack operation holds now refuses with the `Mesh: <space>` heading and `Space:` row that the same refusal from `up` has.
- 813ce6d: `down --space <space>` from any folder now stops a controller stack whose folder was deleted. It
  signals each running member's recorded process, manager first and broker last, records each stop,
  and removes the stack's saved definitions and registration so the space can start in another folder.
  Before, every stop route refused because the broker configuration was gone, and the space name could
  not start anywhere on that machine. `status` now marks such a project folder as gone and names that
  `down`, and so does `space forget` when it keeps the definitions of such a stack.
- 0ee4172: `cotal down` reads the delivery lease after the delivery daemon stops and keeps the daemon's credential while the lease still names it. A daemon whose release a full JetStream store refused left that row as a killed one does, and the next `up` then started no delivery member, because the credential it needs to wait the row out had been removed. When the lease cannot be read, the credential stays and a `DELIVERY_LEASE_UNREAD` warning says so.
- c0cefb6: A `cotal down` that had to kill a stack's delivery member keeps the delivery credential, as it does for a delivery daemon that was already gone. The killed daemon never released its lease, so the next `cotal up` now recognises the row and waits it out. It used to mint a new credential, meet the dead daemon's live lease and fail `OPERATION_PARTIAL`.
- 840a1d5: `cotal down -f <folder>` no longer prints a raw `EISDIR` error. It refuses with exit 1, naming the
  path, that it is a directory, and the manifest file to give instead, as `topology view -f` and
  `up -f` do.
- cdd9b8a: `cotal down` now says when a stack member stopped by signal did not exit within 15 seconds of SIGTERM and was killed. Its row reads `stopped with SIGKILL`, and a `STOP_ESCALATED` warning names the member and its pid in the receipt and in `--json`. The receipt used to say only `stopped`, and only `service status` showed the recorded SIGKILL.
- 75be9e9: `cotal down` and `cotal down --dry-run` in a folder with no stack, on a machine that has no stack started or registered at all, now say so and name `cotal up` in a project as their next step, as `cotal status` does. They used to send you to the folder where `cotal up` started the stack, when no such folder exists.
- dfe79bd: `cotal down --dry-run` in the machine home now reads a stack an earlier release started there and names `cotal down --preserve-state`, its stop, or says that none of it is running. With no stack there it says there is nothing to preview, as it does in any other folder.
- 0914206: `cotal down --space <space>` run from another controller stack's folder now names the space it was given, labels the refusal with it, names that space's root when this machine started it elsewhere, and gives a next step that runs the same `down` from there. It used to call the given space "the selected space", label the refusal with the folder's own space and give no next step.
- 8ceb4ae: `cotal down --space <space>` from a folder whose `.cotal` holds no stack, such as one a failed start left, now refuses with `TARGET_NOT_FOUND`, names that space's root when another folder holds its controller stack, and gives a next step that runs the same `down` from there, as it does from a folder with no `.cotal`. It used to refuse with a usage error that ignored `--space`.
- 0344990: `cotal down` now stops a controller stack whose registration an older `meshes rm --force` dropped, or an older `meshes add --force` replaced with one added by hand at the stack's own root and broker. It rebuilds the registration `cotal up` writes from the stack journal, only while the stack's broker is the launch that journal records, and refuses before any member stops otherwise. A hand-added registration of another address refuses and names `cotal space forget`. Such a stack used to refuse with nothing to stop it by, or stop its manager and delivery and then refuse at the broker.
- e493c0d: A bare `cotal down` whose broker process runs but does not answer, as a suspended one does, now
  refuses `TARGET_UNAVAILABLE`, exit 2, naming the broker's pid and how to resume or end it. It used
  to report an unknown outcome that named no member. Nothing is stopped.
- f99dca8: `cotal down` on a controller stack now refuses `PERMISSION_DENIED` before the stop plan when this account cannot write the root's `.cotal`, naming the folder and the `chmod u+w` that fixes it, and stops nothing. `--dry-run` names it as a refusal the real stop would hit. It used to print the plan and then exit 3 with a raw `EACCES` on the stack journal's lock file.
- 1330641: An editor that exits non-zero during `persona edit`, as vim's `:cq` does, now cancels the edit: it
  exits 0 with a `USER_CANCELLED` warning, saves nothing, and keeps and names a draft it changed. It
  used to fail with `OPERATION_FAILED`, exit 5. A draft left as it was now saves nothing and says the
  persona is unchanged instead of "Persona saved".
- e4028e4: A `persona edit` interrupted while the editor is open now says so. The CLI passes the SIGINT,
  SIGTERM or SIGHUP to the editor and waits for it, so the editor no longer keeps running after the
  CLI exits. SIGTERM and SIGHUP, or a Ctrl-C that ends the editor, save nothing, remove an unchanged
  draft, keep and name a changed one, and exit 130, 143 or 129 with a notice. It used to exit with no
  message and leave the draft in the temporary directory. An editor that takes Ctrl-C as a key, as vim
  does, keeps the edit going.
- cacb5cf: `persona edit` and `personas edit` run an editor setting that is the path of an existing file as
  that program, so a path that holds spaces opens the editor. It used to run through the shell, which
  split the path and refused it as not found after a raw `/bin/sh` line.
- b866287: Every command that takes `--space` refuses an empty value with `USAGE_INVALID`, exit 1, naming the flag, before anything is read or written. An empty `--space`, as from `--space "$S"` with `S` unset, used to fall back to the selected space, so `history clear --space "" --yes` purged it.
- 8253aef: `endpoints --json` now carries each participant's presence values: the condition, and the `statusSince`, `activitySince` and `activeAt` times. It used to carry the report's rendered fragments, such as `" · unchanged for 5s"`, in `facts` and `activityAge`, and a display `label`. The report still prints the same text, worked out from those values.
- e5ea994: Bare `cotal` and `cotal help` in a started space's project folder, with nothing selected, now lead with that space, as the commands there target it. `cotal setup` leads only on a machine with no space; with spaces elsewhere and none selected, the screen names `cotal use <name>` and `cotal space`.
- 2c5ce3f: An exec-endpoint service whose host process died without removing its registration still refuses
  to launch that instance again, and the refusal now says so. It names the earlier host's pid and its
  native registration, and its Next gives the `cotal endpoint deregister` and
  `cotal service start <name> --new-instance` commands. `service restart` of that instance gives the
  same commands.
- 8ce5ca8: Clarify the explicit `--server` refusal documentation: the request is not retried at a recorded broker, and target resolution probes only records at the explicit address. The paragraph distinguishes refusal wording from the separate `status` infrastructure report, records the case where no registration was retained, and names the broader checks explicitly requested by `status --all`.
- 67ee2d0: The CLI reference now documents what a feedback intake expects: a `--key-file` holds one opaque bearer token with at most one final newline, a Cotal intake accepts reports only at `POST /v1/feedback` so `--url` names that path, and the `feedback-intake` service preset's `--keys` file is JSON in the form `{"keys":[{"key":"<token>","tester":"<tester-id>","name":"<display-name>"}]}`, with `name` optional.
- bdc9f7b: `cotal feedback` now names the cause of an intake refusal and gives a next step. HTTP 401 says the key was refused, and points at `--key-file` or `COTAL_FEEDBACK_KEY`, or says the intake requires a key when none was sent. HTTP 404 says the URL has no feedback endpoint and names `<origin>/v1/feedback`. HTTP 429 says the intake is rate limiting submissions, with the retry time when its `Retry-After` header gives one. Before, all three printed the same sentence with no next step. The response body is still never echoed.
- 7b0fd05: `cotal feedback` now reports a connection that never opened as not sent. A refused connection, a failed DNS lookup or a failed TLS handshake refuses `TARGET_UNAVAILABLE` (exit 2) with the native error code, such as `ECONNREFUSED`, and a next step that names the intake origin. Before, each was reported as `OPERATION_UNKNOWN` "the request may have reached the intake", which sent the user to check an intake that never received anything. A timeout or a connection that breaks after the request was written still reports that the report may have arrived.
- 817f353: A FIFO or another file that is not regular, where a state file belongs, no longer makes a command
  wait forever. A `preferences.json` like that is refused with `PERMISSION_DENIED`, naming it, by
  every command that reads preferences. A `.cotal/channels.json` like that refuses `up` with
  `USAGE_INVALID`, and `persona` lists such a catalog file as unreadable and names it, as `persona
  show` already refused it.
- f77bfd0: A first `cotal up` refused because another program held its port, such as a web server, still pinned the folder's stack to that address: `up --server` with a free port refused `CONFLICT` "a recorded stack is not moved to another address", and `down --yes` did not clear it. The refusal now comes before any broker instance is recorded, a broker start refused before its process launched no longer counts as a stack that ran, and the refusal's next step on a first start names another `--server`. The docs no longer say both that such a stack pins nothing and that it keeps its address.
- 7ddb2e7: After a first `cotal up` that launched no member, such as one refused because another program holds its broker address, the next `up` may ask for `--open` at another address, as the docs say. It used to refuse "pinned to static auth" and name a bare `cotal up`, which reused the held address.
- e124c5a: A new project's space, which a bare `cotal up` names after its folder, now keeps that name after
  `cotal down`. Its registration stays while it is stopped. Another folder of the same name is refused
  `CONFLICT`, naming the stopped project, where it used to take the name over. The stopped project's
  `ps` and `spawn` no longer reach that other folder's stack. `cotal up` in the project starts it again
  on the same launcher, as its last start ran, and `cotal space forget <name>` frees the name. An
  explicit `up --space` still takes over a stopped holder, and the `down` of any other legacy folder
  still drops its registration.
  `status` names the `cotal up` that starts again a stopped stack this machine started, where it used to
  say its saved registration needed attention.
- 957b8d8: Inside a project whose root has one space other than the selected one, commands target that space, but `space`, `space show` and `use` described only the selection. `space` now marks that space as this folder's, `space show` with no name shows it, and `use` says that commands in the folder target it. Their `--json` gives it as `folder`.
- fde8a58: In another space's project folder, `status`, bare `cotal` and `help` now lead with that folder's space, the one every command there targets, while it is prepared, running or stopped. `status` names it under `Mesh:` and in a `This folder's space` section, says the selected space applies outside the folder, and carries it in `--json` as `target.space` and `meshes.folder`, where a stopped or prepared folder space used to leave both null. The entry screen points to that folder's own `cotal up`. `history clear` says it clears the space it targets, not the selected space.
- 2dcc119: `cotal history --follow` now ends on its own when its credential can no longer connect, because it expired or because the broker rejects it, as after `reset space`. It ends with the refusal a one-shot command with that credential gets, `AUTH_REQUIRED` or `PERMISSION_DENIED` with its Next, and with `--json` it writes that `error` record and then its `end` record. Before, it printed the raw broker text and "re-establishing" and then waited forever. A lost connection is now one line, or one `TARGET_UNAVAILABLE` error record, while the follow re-establishes it, so a follow still outlives a broker restart. A credential past its own expiry is refused before any dial, since a broker still takes it during its last second.
- 8727696: `service logs --follow` on a log this account cannot read now ends with a `PERMISSION_DENIED` error
  record that names the log, the cause and a `chmod u+rw` step, and exits 2. It used to end
  `OPERATION_FAILED` with exit 5 and no path, cause or step.
- 2721ee3: When the broker rejects the credential a `cotal history --follow` or `cotal console` minted from the space's trust, as after `reset space`, the refusal it ends with now says to run the command again, which connects with the space's current trust. Before, it said to check your creds, which named a credential you never gave.
- b198527: A foreground `cotal up` whose broker exits on its own now exits 5 instead of passing on the broker's
  exit code, which read as a usage error, or 1 for a broker ended by a signal. A broker that exited 0,
  as after an external `down`, still exits 0. Its line says the mesh stays recorded only when the
  registry holds that broker's record, so a broker that exits before the mesh was recorded no longer
  claims a record `cotal meshes` does not list.
- 0eb60a1: `up --foreground` on a stack that was already running took over its lifetime without saying so, and a second foreground `up` on a stack another terminal held did the same, so Ctrl-C in either stopped the whole stack. A second foreground `up` now refuses `CONFLICT` while another foreground `up` holds the stack, naming that process. Over a running stack that no terminal holds, it says before it blocks that the stack is already running and that Ctrl-C there stops the whole stack.
- f997587: `cotal space forget` now names the services it keeps under the space's name, such as ones
  `cotal service add` saved, which a later space with the same name inherits. Its `--json` result
  carries them as `keptServices`, and the receipt names the `cotal service remove` that forgets one in
  that later space. `cotal up` names each saved service of the space that it does not start, and
  `--json` carries them as `result.savedServices`.
- 7594451: `cotal space forget` of a running stack no longer says `cotal down` drops the space's record. A
  stack's `down` keeps it as a prepared space at its root, so the refusal now names `cotal down` and
  then `space forget` again. A legacy root, whose `down` drops the record, keeps the old wording.
- bd4f7e4: `space forget` of a prepared space whose record cannot be read lists the services still saved under its name, as the other forget routes do.
- 0d3af83: `cotal up` in a new folder under your home folder, such as `~/Desktop/test`, now starts there. Once
  `~/.cotal` existed, such a folder inherited the home's `.cotal` and `up` refused, asking for
  `cotal space create <space> --root .` and then `cotal up --root .`. A bare `up` now makes the folder's
  own `.cotal` and starts the stack as it does in a folder with no `.cotal` above it, and removes that
  `.cotal` again when it refuses before writing anything there. When the home holds a stack an earlier
  release started, that stack keeps running and keeps its records, and it still starts from the home.
  `up -f` and `up --restore` there still refuse and name `space create` and an `up` from the folder.
  `status --verbose` says that `up` makes the folder its own project root, and the
  `--root` help says plainly that it starts the project in another folder that already has a `.cotal`.
- 58144d0: An `up` that creates a space now writes the space's trust record after its system-account creds. An
  `up` interrupted between the two used to leave a space whose next `up` kept the record, never minted
  the creds, and started the delivery daemon into a refusal over its missing observer creds. The space
  is now left new, and the next `up` writes all of it again.
- 9f2eba1: `cotal down` on a controller stack whose JetStream store holds more than its cap now refuses `DEPENDENCY_UNAVAILABLE` (exit 2) before any stop, naming the store and the cap. The manager's stop needs a credential whose issuance record the broker stores first, and the full store refuses it. It used to exit 3 with only "insufficient resources" and leave every member running. Its Next is `cotal history clear --yes`, then `cotal down`. `down --dry-run` reads how much the space holds when the manager runs and names the same refusal as a warning.
- 931810c: On a full JetStream store, the refusals of `cotal down` and `cotal service stop` now say that `cotal history clear` purges all of the space's channel history, and name the route that keeps it: end the manager on the stack's host with `kill -TERM <pid>`, which stops its agents by its default policy, then run `cotal down` and `cotal up --max-file-store <bytes>` with a larger cap. The controller-root refusals of `backup create`, `backup restore`, `up --restore` and `down --preserve-state` no longer say plain `down` and `up` always keep the history; they say a full store makes `down` refuse first.
- cf4ed0f: A delivery daemon whose lease lapsed on a store over its `--max-file-store` cap no longer says another daemon took its shard. It quotes the broker's refusal of the new lease and exits, as a daemon without its lease does. `cotal up` then names the full store and the line the daemon logged, with `history clear` or a larger cap as the way out, and `status` says the full store refuses the lease. An owned service that exits before readiness now has its error quote the last line it logged during that launch.
- 75476c5: `cotal send` on a broker whose JetStream store holds more than its `--max-file-store` cap now refuses `DEPENDENCY_UNAVAILABLE` (exit 2), naming the store and the cap, and says nothing was stored. It used to exit 3 saying the message may have been stored, although the broker had refused it. Its Next is `cotal history clear --yes`, which makes room. `cotal status` shows that store as `full` with the bytes stored and the cap, and leads its Next with the same clear. The endpoint gains `storedBytes()`, the bytes its account holds in JetStream file storage.
- 5dbe713: `--no-color` and `--no-input` given twice, before or after the command word, are refused as the usage error any repeated flag gets, `Option '--no-color' cannot be repeated`, exit 1. They used to be accepted.
- 267aad5: `cotal <command> <word> --help`, where `<word>` names none of the command's subcommands, now refuses
  as `cotal help <command> <word>` does, naming the nearest subcommand, instead of printing the
  command's help with exit 0.
- 81bcf31: At `--limit 1000`, `cotal history` no longer tells you to raise `--limit` to read further back; it
  says history reads at most the newest 1000. With older retained messages behind the window,
  `--from` and `--grep` say they searched only the messages read.
- 0d09b6d: `cotal history --dms` names a DM's recipient from the roster when no message in the window came from it, so a DM to a participant that has sent nothing reads `DM to <name>`. It used to show the principal.
- d78a199: A live `event` record of `history --follow --json` no longer carries `"seq": null`. The live feed
  carries no stream sequence, so the field is left out; the snapshot's items keep their sequence, and
  `--since` with the last event's `ts` reads on from a follow.
- afe6f33: `cotal history --follow` prints its window and each new message in the line form `watch --plain` uses, `[<space>] <time>  <sender>  <destination>  <text>`, so the two feeds read alike. The docs say a purge is not announced to either feed.
- d4afe89: `cotal history` accepts `#general` as a channel name, refuses a wildcard with the sentence `cotal send -c` gives, and warns `CHANNEL_NOT_FOUND` with no replay policy for a channel that has no messages and no saved entry. A flag value that starts with a dash and a digit, such as `--limit -1`, is read as that flag's value, so the command's own check answers it rather than the parser calling it ambiguous. `--since` takes an ISO 8601 date and time, and no longer reads forms such as `-5` as dates. `channelReplayPolicy` also returns whether the channel has its own registry entry.
- 5ad384d: `cotal history` with a `--creds` credential that may read no channel, such as an agent credential from `cotal auth mint` with no `--allow-subscribe`, refuses before it reads with "its history grant is no channel" and the mint step that grants one, instead of the broker's raw permission subject.
- 8e549a7: `cotal history` shows at most the first 500 characters of a message in its text and `--plain` rows,
  including under `--follow`, and marks a cut row with the message's size. `--limit` bounds how many
  messages are read, but a row printed the whole text, so three large messages printed megabytes.
  `--json` still carries the whole text.
- 062eb54: `history --since` refuses a value that is not an ISO 8601 date or date and time, an age or a
  sequence, naming the forms it takes. `--since=-5` and `--since 10/23/2026` were read as dates, and
  `2026-02-30` rolled over into March, so the read went back further than asked.
- 58e879b: `cotal history --since` reads a bare date as local midnight, as a date and time without an offset already were, and refuses a date that is not on the calendar. The report names the local time and the ISO instant a time `--since` resolved to.
- b6cfff1: `cotal history --since <n>` refuses a bare number past the chat stream's newest sequence, which names no message, with that sequence and how to write a date, so `--since 2026` no longer reads as an empty window. `chatRetention` also returns the stream's newest sequence.
- 79ccdbe: `cotal history` names a `--since` read as a chat stream sequence in its report. A year such as `2026` reads as a sequence, and the report says to write a date in full.
- 0e43782: A `service start` whose HTTP readiness check never succeeded said only that the process did not establish its declared readiness, with no address, no hint of what the check saw, and a generic Next. It now names the loopback address (not the URL's path), the expected status, the deadline and the last observation, such as a refused connection or another status, says the process was left running, and its Next names the `service logs` and `service stop` commands for that exact instance.
- 50e13e5: `ps` and the hosted `run` verbs now say what to do when the space's manager runs but does not
  answer. `ps` waited out its deadline and refused "no manager reachable" with no Next, although this
  root's stack manager was running. It now names that manager's pid and gives as Next ending that
  process, so bare `cotal up` starts the manager again. `run start`, `run ps` and the other hosted
  verbs exited 1, the usage code, with only the rail paragraph. They now refuse `TARGET_UNAVAILABLE`
  (exit 2) with the same sentence, and their Next is `cotal status`, which names a stack manager that
  runs but does not answer, with its pid.
- 82d32cd: A hung stack manager no longer reads as healthy and no longer leaves the stop commands without a
  way out. `status` read a controller stack's manager only from its instance record, which stays
  `running · endpoint serving` while the process lives, so a stopped or hung manager showed green.
  A running `stack-manager` now gets one probe of its manager endpoint: the selected space's `Manager`
  row reads `answering`, `not answering · stack-manager pid <pid>` or `endpoint not checked`, and the
  JSON result carries it as `stackManager`. A manager that does not answer puts `kill -KILL <pid>`
  first in Next. `down --yes`, `service stop` and `service restart` gave exit 3 with no Next and no
  pid when the manager did not answer its describe. They now refuse `LIFECYCLE_BLOCKED` (exit 2),
  name the manager's pid and say no stop was submitted, and their Next ends that process so the same
  command finds it gone and goes on.
- 43ea28a: `input`, `stop` and `attach` refuse `TARGET_UNAVAILABLE` at once when no manager is running for the
  space, as `ps` does, instead of waiting out the manager's answer deadline and reporting an
  unconfirmed outcome for a request that was never sent.
- b7c1cef: A command interrupted by SIGINT, SIGTERM or SIGHUP while the CLI is still loading now says it did
  nothing and exits 130, 143 or 129. It used to exit with no output, even for a `down` whose members
  kept running. A detached `up` and a bare `down` now install their own notice before they take the
  stack's lock, so an interrupt right after the lock is taken is reported too.
- a33e13a: A detached `up`, a bare `down` and a confirmed `history clear` interrupted by SIGINT, SIGTERM or
  SIGHUP now say what they left before they exit 130, 143 or 129: the stack members still running and
  the command that finishes or stops them, or which history purges were acknowledged or submitted.
  They used to exit with no line about the state.
- 332d20e: Ctrl-C or `SIGTERM` during `space delete`, `reset store`, `reset space`, `clean store` or `clean all`
  now reports what the command left and exits 130 or 143, instead of exiting with no output. The
  reset and clean routes release the maintenance lock first. A command that takes over a maintenance
  lock left by a process that is no longer running now says so with a `MAINTENANCE_LOCK_TAKEN_OVER`
  warning.
- b2ba679: A bare `down` interrupted after it signalled a member that had not exited yet now names that stop's
  request in its notice: `cotal down --yes` stops the member again while it runs, and once it has
  exited, `cotal down --abandon-stop <request-id> --yes` finishes the stop. The notice used to name
  only `cotal down --yes`, which refuses once that member is gone.
- fddf777: Quote the recorded root in `status` recovery commands for an interrupted startup, preserving spaces
  and apostrophes when copied into a shell. The existing `--no-manager` choice is preserved. Startup
  state, recovery actions and their order are unchanged; no command is run automatically.
- b12e55c: `cotal join` refusals are classified. An unknown space, a rejected credential, a missing creds file, an unreachable broker, an unprovisioned lifecycle and the flag misuses each print their code on stderr and exit by the outcome table: 1 for a usage refusal, 2 for any other. Before, every one was a plain line with exit 1. `join` still has no `--json`, as `chat` has none.
- 8ae4d3b: A running `cotal join` whose credential the broker rejects for good, as after `reset space`, now ends
  with that credential's refusal and its Next, as `history --follow` does. It used to print
  "Authorization Violation" and re-establish for as long as it ran.
- 6c2513c: `cotal join --creds` with a credential minted without `--provision` now says the space has no inbox for that credential's lifecycle, and that the owner mints it with `cotal auth mint <name> --provision`. It used to say to run `cotal up`, which cannot make that inbox.
- b8c3d16: A running `cotal join` that re-establishes its connection and finds its inbox gone from the broker,
  as after `reset store` while it was disconnected, now ends `TARGET_NOT_FOUND` and says to join again.
  It used to print "consumer not found" about once a minute while it was missing from the roster.
- 9901303: A `.cotal/channels.json`, `--channels` file or `preferences.json` that begins with a UTF-8 byte-order
  mark, as some Windows editors write, now reads as the JSON after it. Before, `cotal up` refused the
  channels file, and such a preferences file stopped nearly every command, with a parser message that
  showed the mark as an invisible character.
- c4f67fa: `cotal up` from an unprepared folder, and `cotal up -f`, now refuse `CONFLICT` at once when another program holds the broker address without answering NATS, as the controller stack does, naming the address and the bind error. They used to launch a broker that exited on its bind, probe the other program for about 11 seconds, and end with an unconfirmed outcome.
- 1953565: The legacy `cotal personas list --running` heads its list with the mesh it read and marks each persona `● running` or `○ not running`. It used to print a bare `○` with no heading and nothing saying what the mark meant.
- a11eb89: The legacy `cotal personas show <name>`, piped or redirected, writes only the persona file, byte for byte. It used to write the file's path on a line before it, so `personas show <name> > <file>` produced a file that was not a valid persona. On a terminal it still prints the path first.
- dd8c812: The receipts of a legacy `cotal up` and its `cotal down` now begin with `Mesh: <space>` and end with a Next, as every other report does: `up` names `cotal spawn` and the stop, and `down` names `cotal up` to start the stack again. A bare `up` in a folder that names no space also says that it started the default space `main`.
- 575b01e: Without the `@cotal-ai/linear` extension, `cotal linear` and `cotal help linear` said only "unknown command: linear". They now say no installed extension provides the command and name `cotal ext add @cotal-ai/linear`, as a missing official connector or runtime names its package.
- e264d3c: In a folder whose `.cotal` is a link to another project's `.cotal`, `up` and `down` said the folder was copied from that project, `status` printed two inventory warnings without a cause, and `space create` said the folder held copied or moved records. Each now names the link: `up` and `down` refuse `CONFLICT` and say to use the stack from the project it leads to, `status` gives one warning that it did not read the attempt inventories through the link, and `space create` names the link.
- 3739adc: In a folder whose `.cotal` is a link to another folder, `cotal up` and `cotal down` exited 3 with an unconfirmed outcome ("maintenance path is not a real directory", or "refusing to delete under … it is a symlink"), and `down --yes --json` there printed a stack trace. With a `.cotal` link that leads nowhere, `up` said the folder inherits the machine's home `.cotal`. Both commands now refuse before anything reads through the link: `CONFLICT` for a link, `TARGET_NOT_FOUND` for one that leads nowhere, exit 2, naming the link, where it leads and the next step. `status` there names the same step in its `COTAL_DIR_LINKED` warning, and warns `COTAL_DIR_DANGLING` for a link that leads nowhere.
- af0a0bc: When a project's `.cotal` was moved to another folder and linked back, `up`, `down` and `status` in
  the project, and every command in the folder the records were moved to, no longer send you from one
  folder to the other. They name the way back: remove the link, then move that `.cotal` back in its
  place, which keeps the history. Nothing is moved for you.
- 87c852d: Only `cotal spawn` reads `COTAL_MANAGED_HANDOFF_FILE`. Every other command, `--help` and `version` included, drops the variable and leaves the file, where before each one failed with a bare "the managed handoff file does not exist" or silently deleted the file. A file spawn cannot take is refused `USAGE_INVALID`, naming the variable and the path, with `unset COTAL_MANAGED_HANDOFF_FILE` as Next, and under `--json` as an envelope.
- 71ec484: A managed `cotal spawn` and `cotal attach --on` name the mesh once, in the `Mesh:` heading of the
  report that answers. The launch and attach blocks name the space as a field, and the `→ using mesh`
  line is gone. The waiting line now says the manager answers when it refuses the launch, or when the
  agent joins or exits, within about 30 seconds, and wraps to the terminal.
- 3f19a67: When the host enrolls a managed agent with other read or post channels than its persona asked for,
  as a host that narrows a request to the account's grant does, the spawn receipt now says so on one
  line, listing what was granted beside what was asked. `--json` carries both lists as
  `acl.requested` and `acl.effective`.
- 223024b: A managed `spawn` prints its `Managed launch` plan on stdout with its receipt, so
  `cotal spawn <persona> -d > out.txt` keeps it, and a refusal is on stderr. With `--json` the
  plan stays on stderr. The manager that refuses a spawn now writes one line to its log with the
  original request ID, the persona and the reason, so `cotal service logs` on its host finds a refused
  launch after the terminal is gone.
- 608f2d0: A manager started by a cotal before 0.100.0 puts no host in its presence. The list of your live
  managers showed its host as a bare `-` and its name as `manager`. It now reads
  `not reported (started by an older cotal)` and the manager is listed by its runtime, such as `tmux`,
  which `--on` also takes when only one of your managers matches it.
- 00db0a6: A manager can be given a name when it starts: `cotal supervise --name <name>`, the `manager`
  service preset's `name` option, or `cotal up --manager-name <name>`. The name rides the manager's
  presence card and is recorded in its root, so a restart or repair keeps it. `who --all` and the
  choice listed when several of your managers are live show each manager by its name, or by
  `<host>/<runtime>` when it has none. On a user-auth mesh, `--on` takes a manager's name or host as
  well as its instance id when only one of your live managers matches it, and otherwise refuses
  and lists them with the command again on each. On a static or open mesh a name passed to `--on` is
  refused with a Next that asks for the instance id.
- 7f718a4: With several of your managers live on a user-auth mesh, `spawn`, `ps`, `stop`, `attach`, `input`,
  `models`, `persona` and `status` refused on a terminal too, so a plain `cotal spawn` could not run.
  On a terminal they now ask which manager to use, with the most recently started first and as the
  default, then run on the one you pick and say which one it was. A script, `--json`, `--no-input` and
  `COTAL_NO_PROMPT=1` keep the refusal and its `--on` reruns.
- 60b912d: `cotal up -f` on a root whose records hold a controller stack now refuses `CONFLICT` before anything starts, and so does its dry run. The refusal names `cotal team deploy <file>` for the running stack, and `cotal down --yes`, then `cotal team boot <file>`. On a stopped controller stack it used to start a legacy manifest stack beside it, which `cotal down` then could not stop; on a running one it refused with an unrelated reason.
- 3924665: `cotal topology view -f <folder>` and `cotal up -f <folder>` no longer print a raw `EISDIR` error.
  They refuse with exit 1, naming the path, that it is a directory, and the manifest file to give
  instead.
- d865176: A team manifest whose `persona` names a catalog persona, such as `persona: p20`, is still refused,
  but the refusal now says that `persona` takes a path relative to the manifest and names the catalog
  persona's path, such as `./.cotal/agents/p20.md`, when the project has one. The manifest docs say
  the same.
- a2b5eeb: A team manifest whose `space:` is not a name `cotal space create` takes, such as `bad name`, `a/b`
  or `x.y`, is now refused with `SCHEMA_INVALID` when it is read, naming the file, line and name. Before,
  `team check` reported it as resolved, `team boot --dry-run` gave the same partial result as for a valid
  name, and `team boot` failed later with an unrelated instruction. `up -f` refuses it the same way.
- c3f7724: `cotal up -f` with `--tls-cert` now refuses a manifest whose `broker.servers` names a `nats://` address, before anything starts, and names the `tls://` form to use, as a bare `up` already refused `--server nats://`. It used to start the broker, fail the readiness check, and stop it again.
- 8e2438e: `cotal up --max-file-store` accepted any positive integer, but the space's membership bucket reserves 64 MiB of the broker's file store, so a smaller cap failed the start with a bare JetStream code 10047 and no cause. That cap then stayed recorded: `up` with another `--max-file-store` refused `CONFLICT` even after `cotal down`, and no reset or clean cleared it. A cap below 67108864 bytes now refuses `USAGE_INVALID` before anything starts. A stopped stack's next `up --max-file-store` replaces the recorded cap, as the docs already said, while a running broker keeps its own. When stream setup fails for want of storage, the failure names the cap and `cotal up --max-file-store <bytes>`.
- bf13c83: `cotal channel members --follow` now outlives a broker restart. A lost connection is one `TARGET_UNAVAILABLE` error record, or one line, while the follow reads the feed again, and once it answers the follow writes a `gap` record and the current census. Before, a read that failed during the restart ended the follow with `OPERATION_PARTIAL`, exit 4. A credential that can no longer connect, because it expired or the broker rejects it, ends the follow with the refusal a one-shot command with that credential gets, as `cotal history --follow` does, and with `--json` that `error` record and then `end` with reason `refused`.
- a9a887d: Ctrl-C or Esc in the guided `cotal meshes add`, and in the questions `cotal space add` asks, now ends with "Cancelled. Nothing was registered." It used to say "Setup cancelled." under the title "Register a mesh".
- f53085c: The guided `cotal meshes add` no longer replaces a registration when you press Enter through it. On a name already registered by hand, "Use a different name" is now the first choice, and confirming a replacement defaults to No.
- 2df3f6c: The guided `cotal meshes add` no longer replaces a registered record when you press Enter through its defaults. When it would replace one, its last question is now "Replace the record for "<space>"?", and only a typed `y` or `yes` confirms it; Enter keeps No and nothing is written. Before, that question was "Register this mesh?" with Yes as the default, so Enter replaced the record of a space this machine had started, and `cotal down` there could then no longer stop its broker. A cancel at any of its questions now says "Cancelled. Nothing was registered." instead of "Setup cancelled."
- 57a8888: The guided `cotal meshes add` now offers the spaces an open broker serves, where it used to ask for the name with no list. Accepting the suggested folder with Enter now shows that folder on the answer line, where it used to show an empty one.
- d594f26: `cotal meshes add` now refuses a name that is prepared on this machine, or that this machine started or a catalog lists, with or without `--force`, as `cotal space add` does. Replacing that registration left a running stack that `cotal down` could no longer find. The guided form no longer offers to replace it either.
- 32f1340: `cotal meshes` writes its list through the shared table, so a terminal too narrow for its columns gets one labeled record per mesh instead of a line that runs past the edge. The `current` default is marked `(default)` after its name instead of with a leading `*`.
- e5b9613: `cotal meshes rm` of a running stack no longer says `cotal down` drops its record. A stack's `down`
  keeps it as a prepared space at its root, which `meshes rm` cannot remove, so the refusal now names
  `cotal space forget <space>`. A legacy root, whose `down` drops the record, keeps the old wording.
- 8cd715e: `cotal meshes rm --force` no longer drops the record of a mesh this machine is running. Dropping it left a running stack that `cotal down` could no longer find, so `rm` now refuses with or without `--force` and points at `cotal down`, which stops the mesh and drops the record. `--force` still drops a record whose folder cannot be checked for a running mesh.
- 6ca060e: `cotal auth mint --out` names the folder it cannot write through. A symbolic link among the output's folders is refused `PERMISSION_DENIED`, naming the link, the folder it points to and the same file named without the link. A path through a file is refused `USAGE_INVALID`, and a folder this account cannot create is refused `PERMISSION_DENIED`, each naming the folder. Before, all three were refused `SCHEMA_INVALID` with "native credential preparation failed" and no path or next step.
- 4fe8f9c: `cotal auth mint <name>` now names a persona file of that name that it cannot use. A file that
  cannot be read as a persona, such as one with a YAML error or saved as UTF-16, refuses
  `SCHEMA_INVALID` with its path and `cotal persona show <name>`, which says what is wrong. A role
  from the file that is not one word of letters, digits, `_` and `-` refuses with its path and
  `cotal persona edit <name>`. The mint refusals do not print file values or parser text. Before, both gave a generic refusal
  that named no file and no step.
- 17d7fb4: `cotal models` without `--on` on a space with several live managers now names the managers it did not ask, in a `Not asked` row and in `result.notAskedManagerInstanceIds`, and its Next asks each with `--on`. When the answering manager returns no catalog, the report says that manager has no agent application installed instead of only that no catalog was returned.
- d53c294: After `down --space <space>` stops a stack whose folder was moved or renamed while it ran, its Next
  names `cotal space create <space> --adopt --root <folder>` first, which keeps the folder's history,
  then `cotal space create <space>` for another folder. Its plan no longer says the stack journal is gone.
- 3aa2667: `cotal status` in a moved or copied controller folder listed "if the stored JetStream state is stale: cotal clean store --force" as a next step, although `clean store` refuses there and, in a moved folder, that store holds the space's only messages. Status now treats that folder's store as the stack's, as it does in the folder the stack started in, and reports `storedState` as `false`.
- 240dbf4: A controller project folder moved after its stack stopped got contradictory next steps: `up` and `down` said to move it back, while `status`, `send` and `history` said to forget the space and prepare it again with `space create --root <dir>`, which `space create` then refused. Every command run there now names the same next step. A folder moved on this machine is told to move back. When this machine records neither the space nor an instance of its stack, as for a copy brought from another machine, moving back would not start it, so `up` and `down` now name only `space create <space> --adopt`, as `status` already did. When the space is prepared or registered here, they name moving back or forgetting the space and adopting the journal.
- 54a9514: `status` in a project folder renamed while its stack ran said authentication was required, and offered `clean store --force`, which refuses there. It now says the folder was moved and names moving it back.
- 1de8abb: Renaming a project folder while its stack ran stranded it. The running broker created empty store folders at the old path within seconds, so `up` and `down` in the renamed folder said it was a copy and to use the stack from the old path, and `send`, `history` and `service stop` said the seed under the old path was missing. The broker configuration now names a store inside the project folder relative to it, and the broker runs from that folder, so a renamed folder keeps the broker's writes and the old path is not created again. `up`, `down`, `send`, `history`, `ps`, `service status` and `service stop` in a moved folder now refuse `CONFLICT`, say it was moved, and say to move it back, moving aside anything found at the old path first.
- d77b1a7: A `nats-server` on PATH that answered `--version` replaced the bundled broker whatever version it reported, and nothing named which one ran: an old one failed later with a broker that exited before readiness. `cotal up` and `cotal setup` now refuse a `nats-server` on PATH older than 2.12, or one that reports no version, with `DEPENDENCY_UNAVAILABLE` naming its path and version before the broker starts. The `up` receipt names the broker executable, where it was found and its version (`result.brokerExecutable` in `--json`), `status` names the one Cotal will run, and `service status` names the file a running instance executes.
- 0c7e317: On a terminal, more Next lines now keep each command whole when they wrap. Four of them name their
  commands in backticks now: `space delete` of a running space, `run answer` with a step name that
  matches an open request, `down` and `down --dry-run` beside a running service, and `up` in a moved
  folder that `space create --adopt` takes over. Before, at 80 columns, the `space delete --dry-run`
  Verdict of a space with a long name printed `cotal reset store` at the end of one line and the
  name on the next.
- 0f0a6f0: An `up --no-manager` interrupted by a signal named bare `cotal up` as the way to finish or restart the stack, and so did the `cotal down --yes` that settled it, so following either added the manager the operator had left out. Both now name `cotal up --no-manager`. An interrupted plain `up` still names `cotal up`.
- a8613e5: On a stack started with `--no-manager` whose root runs a `manager` preset service, `status` names that
  service on its Manager row, and in `--json` as `folder.managerService`, instead of saying no manager
  runs and that bare `up` adds one. Bare `up` there refuses naming the service and the
  `cotal svc stop <name> --instance <id> --space <space> --yes` that stops it, instead of calling it a
  legacy pidfile process with no next step.
- c204b4d: `cotal status` on a running stack started with `--no-manager` offered `cotal up --root <root>` to restart its stopped members when the only one was the manager record an earlier full `up` left, and on such a stack with a member really gone its restart dropped `--no-manager`. Following either started the manager. That record no longer counts as a stopped member, and the restart keeps `--no-manager`.
- b3f0edd: Every no-responders answer on the reserved sentinel now reads refused instead of unknown: core marks it `not-executed`, as SPEC 13.3 requires. An unpinned `cotal spawn` that no manager receives is refused with `TARGET_UNAVAILABLE` and exit 2. It names bare `cotal up` when no manager runs, and the `cotal ext add` to run when no live manager has an agent application installed.
- b8ef19b: A command run in a folder whose `.cotal/` names no space, as after `cotal space forget`, no longer heads its refusal `Mesh: main` or lists `Space: main`. The refusal names the folder, and its JSON `target` now holds only `root`, because the default space was only assumed there.
- f2523c8: A word that names none of a command's subcommands, and is near none of them, is now refused with the
  subcommands the command takes, so `cotal telemetry bogus` names the levels `off`, `minimal` and
  `regular`.
- 6fbd64e: On a static or open mesh, `cotal attach --on` and `cotal input --on` with an id the registry lists for no manager are refused `TARGET_NOT_FOUND` at once, naming the managers that run, as `stop --on` is. Before, each waited out the 10 s answer deadline, and `input` then said the manager registered for this space did not answer. A registered manager that does not answer is still waited on, and a user-auth mesh is unchanged.
- 3a8d39c: `ps --on`, `stop --on` and `models --on` with an id that names no registered manager now refuse at once on a static or open mesh, as `spawn --on` does: `TARGET_NOT_FOUND` naming the managers that run, with `--on <id>` or no `--on` as Next, or `TARGET_UNAVAILABLE` when none runs. They used to wait out the 10 s describe deadline and report the id as a manager that did not answer.
- ef9cdb8: On an open legacy root deployed with `cotal up -f`, a bare `cotal up` after `down` starts the manifest's space again. It used to start and select a space named `main` in the same store, because an open root holds no account that names its space and `down` had dropped the registration that did.
- ed15d75: An open start now writes its space into `.cotal/server-open.conf`, so a bare `cotal up` after `down` on an open legacy root started with `--open --space` starts that space again. It used to start and select a space named `main` in the same store. After a later plain open start of another space at a root deployed with `up -f`, a bare `cotal up` starts the space that ran last, not the manifest's.
- 788bf15: On a space registered as open, `auth mint` and `auth signer` refused `AUTH_REQUIRED` about missing static signing trust, with no next step, as if something were missing. They now refuse `UNSUPPORTED` and say why: an open space authenticates no one and issues no credentials, so nothing was minted or exported. The next step is to connect without credentials. A root with no signing trust and no open registration keeps the earlier refusal.
- 279f668: Option-parsing refusals name the spelling the command takes. An unknown option says to put `--`
  before a word that starts with `-`, and an option value that starts with `-` is refused with its
  `--name=value` form. `-c=general` and an option typed with a typographic dash are refused naming
  the option meant, where they were read as the value `=general` or as a positional.
- 2093a48: `cotal space create` and `cotal down` for a root whose controller stack runs under another `COTAL_HOME` now refuse `TARGET_UNAVAILABLE` and name the home to run with, like `cotal up`. `space create` used to prepare a space there that could never start, after which `status` reported it as prepared and stopped naming the other home, and `down` refused with a missing member definition and no next step. `status` now names the other home even when this home prepared a space at that root.
- 7b97877: An over-long service argument now names its position and the limit. A `service add --file` definition whose launch argument is over 8192 characters refuses `SCHEMA_INVALID` with "launch argument 2 (launch.args[1]) has 8193 characters, and a launch argument holds at most 8192"; it used to say only that the input did not match the schema at `launch`. A preset's array option, such as the exec-endpoint `--handler-args`, whose argument is over its declared length refuses `USAGE_INVALID` naming that argument's position and length, before the adapter's schema is checked.
- c7f55b1: `watch`, `chat` and `down` report output they could not write, such as stdout on a full disk, in one stderr line and exit 3, or with the non-zero status they had already set, as every other command does. Only a reader that closed the output ends them quietly. `chat --stdio` no longer says the reader closed stdout when a write failed for another reason.
- 2f7657c: More hints that name a path now quote it when a shell would split or expand it, so they can be pasted: the `chmod u+w` that a preferences folder, `up` and `down` name for a folder they cannot write, the home screen's `cotal up --root <dir>` row, the `cotal space create <name> --root <dir>` that `status`, an unreachable folder naming no space, and `up` for a forgotten space name, and the `cotal space create <space> --adopt --root <dir>` remedies for a moved folder.
- 9323110: Three hints that name a project path now quote it when a shell would split or expand it, so they can be pasted: the `cotal space create <space> --root <path>` that `status` names after a forget, the `chmod u+w` a persona catalog that cannot be written names, and the `cotal up --root <path>` that `status` names to restart a stack's stopped members.
- 2bb203a: `persona create` and `personas new` now refuse with `CONFLICT` a name that differs from an existing
  persona's only in case, such as `Rev` beside `rev`, and write nothing. A case-insensitive file
  system holds the two as one file.
- d785801: A `.cotal/agents` that is a file or a link that loops is now refused with `CONFLICT` by the persona
  listings, `show`, `create`, `edit` and `remove`, naming it and what it is, instead of a permission
  refusal that named the project folder or a listing that showed no personas.
- ec82202: `cotal persona create` now checks each `--subscribe`, `--allow-subscribe` and `--allow-publish` entry against the channel rules and refuses a bad one with `USAGE_INVALID`, naming the flag and the entry. A name written with `#`, such as `--subscribe '#general'`, gets a remedy to drop the `#`, and a `--subscribe` channel outside `--allow-subscribe` is refused the same way. It used to refuse with `SCHEMA_INVALID` about a temporary draft file you never saw.
- 2f1809d: Completing a persona name for `persona show`, `persona edit`, `personas show` or `spawn` no longer
  treats a catalog folder it cannot read as an empty catalog. The completion fails, so the shell
  offers nothing, and `COTAL_COMPLETE_DEBUG=1` prints `cannot read the persona catalog <folder>`.
- f59c1fb: The CLI reference documents `persona create`'s `--allow-subscribe`, `--allow-publish` and
  `--announce`, says that `--on` addresses one manager's catalog, and documents `config --verbose`.
- af43487: `persona edit` keeps a draft that fails validation, or that an editor exiting non-zero leaves, and
  names its path. A refused draft also says why.
- 6b1fd59: `persona create` and `personas new` now refuse an empty `--model` with `USAGE_INVALID` naming
  `--model`, instead of `SCHEMA_INVALID` "invalid persona fields". Any other field the writer refuses
  is named in that refusal too.
- 4b769cf: A persona file that is a symbolic link is now listed with a warning naming the file it links to, and
  `persona show`, `edit` and `remove` name that file as the next step when they refuse the link.
- daec68c: On a static space, the `persona --on <id>` listing's Next offers the local `cotal p show <name>`
  for this root's catalog instead of a `show --on` the manager always answers not-found.
- e30bffc: `persona edit` under `--no-input` or `--json` now refuses with the fix and without the command's
  help, as `persona remove` does without `--yes`.
- 16242a4: A malformed `--on` on `persona` names the command to rerun, such as
  `cotal persona create <name> --on <instance>`, instead of one that repeats `--on`.
- 085c03a: `persona create` no longer writes a flag value's terminal escapes back to the terminal when it
  refuses it. A `--role` or `--model` with control characters is refused by that rule first, and the
  `--role`, `--subscribe`, `--allow-subscribe` and `--allow-publish` refusals quote the value with its
  control characters escaped. A value could retitle or clear the terminal before.
- 4305004: A persona definition the agent-file rules refuse names the field and the reason, such as a missing
  frontmatter block, the renamed `channels` key or a `subscribe` channel outside `allowSubscribe`,
  instead of only the file. A YAML error names its line and column.
- a911c35: A cancelled `persona remove` now says once that it was cancelled and where the persona is kept, and
  its `USER_CANCELLED` warning says nothing was removed. It used to print "persona removal cancelled"
  twice.
- 31c5511: `persona remove default` says it removes the seeded default persona that a bare `cotal spawn`
  launches, in the question and the receipt, and names what writes a fresh copy.
- 57b51b4: `persona create`, `persona create --on` and `personas new` refuse `default_agent`, the name the
  seeded default persona's agents launch under, instead of making a second persona that launches
  under the same name.
- ac0b3f8: `persona create` refuses a role that `send -r` cannot reach, one that is not a single token of
  letters, digits, `_` and `-`, from `--role` or from a file's `role`, instead of saving it.
- 6b94a74: `persona create`, `personas new` and `persona edit` now refuse a persona definition over 1 MiB with
  `SCHEMA_INVALID`, the bound `persona create --on` already applies to its input. An edit keeps the
  oversized draft and names it. A 2 MiB persona used to be saved with no warning.
- 75f6cf6: `personas list` shows each persona's description or first prompt line whole, wrapped to the terminal's width, instead of cutting it at 100 characters, which lost text on a wide terminal and ran past an 80-column one.
- ff0c2e6: `personas list -v` no longer prints a persona's summary line and then the same line again as the
  start of its body. A description that differs from the body's first line is still shown.
- b4d30dd: Legacy `personas show` now refuses as `persona show` does: a missing persona with `TARGET_NOT_FOUND`
  (exit 2), an invalid definition with `SCHEMA_INVALID` instead of printing it, and a name no persona
  can have by the rule it breaks instead of "no persona". A valid persona is still written byte for
  byte.
- 50ec277: The CLI now classifies a local pidfile in one place, read through the shared pidfile reader. A pidfile that exists but cannot be read, such as a directory, now reports an error naming its path. `cotal status` used to print only the bare read error on that component's row.
- 84e1dda: `cotal up --open` or `cotal up --user-auth` on a root whose first `up` recorded another mode now names a way that works: keep the recorded mode with a bare `cotal up`, or run `cotal space create` and the other mode's `up` in another folder. The docs for `up` and `reset` say that no reset, clean or forget changes a root's mode.
- 4124c51: A usage refusal under `--plain`, or under a locale that is not UTF-8, now prints the classified report that begins `Request refused`, then the command's help. It printed the `✗` mark under `--plain`, and the `!` warning mark under such a locale.
- ea1b582: A preferences folder that another local account could write is no longer trusted silently. It
  follows the protected-path rule `space create` applies to a project root. Every command that uses
  the saved preferences still applies them, with a `PREFERENCES_FOLDER_UNPROTECTED` warning naming
  the folder and the `chmod` that fixes it, and `cotal status` lists that `chmod` under Next.
  `config set` and `unset`, `setup` and the preference removal in `space forget` refuse such a folder
  with `PERMISSION_DENIED` (exit 2) before anything is written.
- ec4172b: An invalid or linked `preferences.json` no longer stops `cotal version`, `cotal docs` or `cotal status`. Version and docs use no preference and run as usual. Status reports the file as a part it could not read, naming it and the problem, with "fix or remove <path>; nothing resets it" as its next step, and exits 4. Help's notice that status reports the affected records is now true. Every command that could act on a default, such as `config`, `spawn` or `ext`, still refuses.
- 998477a: `cotal config set` and `unset` now say when they replace a `preferences.json` whose mode was not `0600`, such as a read-only `0400`. The write still replaces it with a private `0600` file, and the receipt names the old mode in a `PREFERENCES_MODE_CHANGED` warning. It used to change the mode without a word.
- 062cdfd: A file where `~/.cotal/prepared` belongs is now refused as `<path> is a file, not a folder`, with the step that moves it aside, instead of as an unreadable mesh registry record to restore from backup.
- e3979fe: A space prepared in a project folder and not started yet counts as that folder's space: a command run there with another space selected targets the prepared space, as it targets a registered one, so a `send` there before the first `up` no longer lands in the selected space unannounced.
- 3282f56: `cotal up` on a freshly prepared root no longer starts the legacy launcher when it is given an option the controller stack has no route for, such as `--tls-cert`, `--tls-key` or `--rotate-sys`. It refuses `UNSUPPORTED` before anything starts, as a root whose stack the controller already owns does. The refusal now names each option, names the `cotal up -f <cotal.yaml>` route when it takes them, and says that a first start has no `$SYS` creds to rotate.
- 57e7b1b: A space prepared with `cotal space create` cannot serve TLS through a plain `cotal up`, and its refusals sent each attempt to another one that refused too: `--server nats://` with `--tls-cert` asked for `tls://`, `tls://` with the pair had no route, and `tls://` alone asked for `--tls-cert`. On such a root, and on one whose stack the service controller owns, any of those now refuses `UNSUPPORTED`, exit 2, once and before anything starts, and on a prepared root it names `cotal up -f <cotal.yaml> --tls-cert <cert.pem> --tls-key <key.pem>` with a `tls://` address in the manifest, which serves TLS there. The `--tls-cert` docs say so.
- 3a4483a: Shell completion now offers a prepared space that has not started. `space delete <TAB>` offers the spaces registered or prepared here, as `space show` and `space forget` do. A channel for `send -c`, `history`, `chat` and `channel show` comes from the space's persona catalog as `spawn` reads it, so a prepared space's declared channels are offered. Both used to offer nothing until the space was started.
- c66ac7c: `down --preserve-state` while a completed restore still holds the root's maintenance journal now
  refuses `LIFECYCLE_BLOCKED` (exit 2), says nothing was stopped, and names the restore attempt's
  `backup cleanup-fallback` as the next step. Before, every preserve form exited 3 as an unknown
  outcome with no next step.
- 61d4cd1: `down --preserve-state` on a legacy root now refuses, before it stops anything, while a saved
  service in the space still runs or cannot be verified, and names each one with the
  `cotal service stop` that stops it. It used to stop the broker under a running service without
  naming it, and a backup then proceeded with the service still running.
- 47bde6e: A process service's executable now follows the rule for other local writers that project roots,
  credential files and preset paths already follow. `cotal service add` refuses an executable that
  another account could replace, or one in a folder another account could write. `start`, `restart`
  and an installed unit refuse it the same way before anything launches. The refusal is
  `PERMISSION_DENIED` and names each unsafe path and the `chmod` that fixes it.
- 357fa7c: `cotal ps` now shows the instance id of the manager that answered even when it runs no agents, under a `Manager` heading. That id is what `--on` takes, and the `--on` help says to read it from `ps`, but with one manager and no agents `ps` printed only "No managed agents." With several managers each one already had its own `manager <id>` header.
- 4f1ade7: `cotal ps` while an `up` is still starting the stack's manager now refuses `TARGET_UNAVAILABLE` saying the manager is starting, with a Next to run `cotal ps` again once `up` reports it started. It used to say no manager was running and point at bare `cotal up`, or fail with the raw "has no live registered instances" error once the manager process ran but had not registered. It reads the stack journal's unsettled `up` and checks that a live process holds the root's maintenance lock, so an `up` that died keeps the no-manager refusal. `@cotal-ai/workspace` adds `maintenanceLockHolder`.
- 9097cf5: `cotal ps` with no agents now offers `cotal setup` instead of `cotal spawn` when no agent application is set up here, the same Next `cotal status` gives. Before, it offered a spawn that could only be refused for the missing connector.
- 62d85dd: `cotal ps` across several managers shows the host each answering manager reports, as `manager <id> · reports host <host>`, and `--json` adds it as `reportedHost`. It is the manager's own claim, asked under one 2-second limit, and a missing host leaves the census unchanged.
- 51b709e: `ps` no longer names the retired `deregister-instance` spelling for a manager whose host is gone. On an auth space it names `cotal endpoint deregister manager <id> --yes` from the space's own root, and on any other space it says to start that manager again and stop it cleanly if its host is still available, and that no supported command removes the record if the host is gone. The row is still listed and the read is still partial. `deregister-instance` still refuses and names `endpoint deregister`, without printing its old usage after the refusal, and a manager that cannot deregister at shutdown names the same two ways out.
- 3868da3: Preserve cause-specific control-plane recovery instructions in `cotal up` without appending a generic `cotal supervise` remedy.
- b77865a: A service definition whose `readiness` broke the schema, such as one with no `timeoutMs`, a `timeoutMs` of 0, an unknown `type`, an `http` readiness with no `url`, a status out of range or an extra field, was refused with "input does not match the version-1 definition schema at readiness" and no next step. The refusal now names the field and the rule it breaks, such as "readiness.timeoutMs must be a whole number of milliseconds from 1 to 120000", without echoing the value, and its Next says to correct readiness and add the definition again.
- c8372a5: `cotal up --server <url>` on a stopped stack recorded at another address now names that address when another program holds it, with any process of this account that listens there, and says to stop it before a bare `cotal up`, since no command moves a stack that ran to another address. Before, it sent the operator to a bare `cotal up` that refused for the same held port.
- 8c019ae: A refusal in a project folder whose space is not the selected one now keeps the note under its
  `Mesh:` heading that says the selection applies outside the folder. In a folder prepared for its own
  space and not started yet, `who`, `send` and `ps` refused under a bare `Mesh: <space>` heading, so
  nothing said why the selected space was not the target.
- 985f634: Refusals that named no next step now carry a remedy, in the JSON envelope's `error.remedy` and under Next in the text report: an unknown or missing `config` key, a `config` value, space name or `--space` it refuses, `persona show` and `persona remove` for a persona that does not exist, `persona create` for one that does, `run validate` of a file that cannot be read, and `service show` or `service remove` of a definition that is not saved. The envelope reference now says that `remedy` is present when a refusal names a step.
- 904c8c2: A refused `cotal up` no longer leaves `.cotal/maintenance` in a folder that had none. `up -f` with a manifest that does not validate or a flag it contradicts, and `up --json` on the retained launcher, used to leave that folder, with a stale lock after `up -f`, and commands run there afterwards treated the folder as a project of space `main` on 127.0.0.1:4222. The lock now removes the folders it created, while they are still empty, when the command refuses or fails.
- 1218c62: A mesh registry record that does not parse now refuses every command that reads the registry with `SCHEMA_INVALID`, exit 1, naming the file, as `space` and `space show` already did. `use`, `space forget`, `space create`, `send`, `persona` and the other commands that reach the registry used to end with "Outcome unconfirmed" and `OPERATION_UNKNOWN`, exit 3, which said the command might have had effects it did not have.
- 2f4f747: A registry-only restore no longer leads to deleting the only copy of the history it left out. The restore journal now records the restore's selection. For a registry restore, `backup cleanup-fallback` refuses with `USAGE_INVALID` and deletes nothing unless `--discard-history` is given, and its `--dry-run` warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`. `backup restore --only registry`, or a restore of a registry-only artifact, adds a `HISTORY_NOT_RESTORED` warning saying that chat and DM history start empty, and its result names the `previousStore` that holds the only copy of that history. `up --restore --restore-only registry` prints the same two lines. The receipt's Next says that deleting that store needs `--discard-history`.
- 2865836: `cotal space add` and `cotal meshes add` accepted a space name longer than 64 characters, which the local files that carry a space cannot hold, and from 117 characters failed with `ENAMETOOLONG`. They now refuse `USAGE_INVALID`, exit 1, naming the limit, and write nothing.
- 6084f21: Remove the unused detached broker boot-log callback and polling helper. Broker output remains in `.cotal/nats.log`, including startup failure diagnostics.
- e4d4384: From a folder that no longer exists, `cotal help` and bare `cotal` said "The local space or defaults could not be read. Status reports the affected records.", while `status` there refuses, and `cotal docs` and `cotal telemetry` refused with "this folder no longer exists" though neither uses the folder. `docs` and `telemetry` now run there, and `help` says the folder no longer exists and to `cd` to an existing one.
- f2c345c: A command run from a folder that no longer exists printed its refusal and the `cd` remedy, then the command's whole help, 50 lines for `cotal up`. It now prints only the refusal and the remedy, as a missing `--yes` does. The exit code and the JSON envelope are unchanged.
- fce91e7: `up`, `down` and `backup create` run from a folder that no longer exists crashed with Node's `process.cwd` stack trace, while other commands refused. They now refuse the same way, `USAGE_INVALID`, exit 1, saying to `cd` to an existing folder, before their own checks run.
- 0ce7197: An agent-profile `auth mint <label> --replace` now warns `REPLACED_GRANTS_CHANGED` when an old agent
  credential names this space's account as issuer and declares different grants. The warning names
  both sets and the `--allow-subscribe`, `--allow-publish` and `--role` flags for the replaced ones.
  Grant selection, inheritance, profiles, expiry and revocation are unchanged.
- 7ec0717: `cotal doctor auth` now names `--profile observer` or `--profile admin` in the `auth mint --replace` it gives for an expired, unbounded or revoked standing credential of that profile, and no longer opens that guidance with a manager that runs an agent. Following the old guidance turned an observer into an agent credential that could read nothing. `auth mint --replace` also warns `REPLACED_PROFILE_CHANGED` when the replacement has another profile than the credential it replaced, and `NOTHING_REPLACED` when the label had no standing credential, stating that exported files stay unchanged and naming `doctor auth` for their state-specific guidance.
- 9adf65a: `auth mint <label> --replace` now names the public key of the credential it replaced, in the
  receipt's `Replaced` row and in `result.replaced.publicKey`. When that credential had no expiry
  claim, the receipt also warns `REPLACED_CREDENTIAL_VALID`: the replacement does not revoke it, so
  any copy of it stays valid until its key is revoked. The warning names
  `cotal down --yes`, then `cotal auth revoke-credential <key> --yes`, then `cotal up`. Before, the
  receipt said only that it replaced a credential with no expiry claim, and the old key appeared
  nowhere once its file was gone. The replacement itself is unchanged.
- 1964019: `cotal reset space` and `reset store` for a space with no registration and no stopped controller
  stack, as a legacy root's `down` leaves one, now name `cotal clean all --force` (or `clean store
  --force`) from that root as the next step, as the reset docs say. They named `cotal space show`,
  which cannot find such a space.
- 7000a04: A `reset store` or `reset space` that finds the root's maintenance lock held, as when it starts at
  the same time as `up`, now names the holder. It refused `CONFLICT` with "the exclusive local
  maintenance lock could not be acquired", with no pid and no Next. It now refuses `LIFECYCLE_BLOCKED`
  (exit 2) the way `up` and `down` do: it names the pid of the command that holds the lock, removes
  nothing, and its Next says to run it again once that command exits.
- dc12188: `reset space` and `clean all` on a user-auth space now name the IdP trust and the actor ledger
  they remove, in the preview and in the receipt, and say that a later start needs
  `cotal up --user-auth --idp <auth base URL>` and each actor granted again. They used to say only
  that a later `up` starts the space with a new identity, which a bare `up` then refused.
- 537cb8d: On a terminal, the Next of `reset store` and `reset space` for a space whose stack still runs names
  `cotal down` and the review command in backticks, so a wrapped line keeps each command whole.
  Before, at 80 columns with a long space name, `cotal reset store` ended one line and the name and
  `--dry-run` began the next.
- 04b4275: The refusal `reset store`, `reset space` and the other store and identity commands give on a space
  that may still run now names each process once. The manager and the delivery daemon were listed by
  their own pidfiles and again as stack members. Such a process is now listed as its stack member, with
  the pidfile's pid and the member's instance.
- 1f6723d: `cotal reset space` now clears the `credentialRef` of a saved service definition whose credential file this space's account issued, such as one `cotal auth mint` wrote. Before, the reference was kept, so the next `cotal service start` after `cotal up` ran the child with a credential the new identity rejects and reported it running. Reset reads the issuing account from each referenced file. The preview and the receipt name each service and file it clears, and the receipt says how to give the service a credential again. A file reset cannot read as a credential is left as it is.
- 0abbc55: `auth retire`'s next step, `doctor`'s guidance for an unbounded credential and `reset space --dry-run` now say that rotating the space identity with `reset space` also removes the space's store, with its workflow runs, channel history and stored messages. The dry run and the apply's confirmation have the Store contents section `reset store --dry-run` has, and `--json` carries it as `storeContents`. Before, the next step named only the credentials it stops, and the dry run said only that it removes the stopped store.
- 948877c: `cotal reset store` now says what goes with the store. Its preview has a "Store contents" section (`storeContents` in JSON), its confirmation and its receipt (`removedContents`) name workflow runs and their journals, channel history and stored messages, and the preview says that a run still waiting for an answer cannot be answered or resumed afterwards. The runs are not listed, because only the stopped broker reads the store; the preview names `cotal up` and `cotal run ps` to see them first. Before, a reset removed waiting runs and history with no word in the preview or the receipt.
- 14e3dae: `cotal reset store` now lists the workflow runs it removes. Before it stops a controller stack's live manager, `cotal down` reads the runs that manager hosts and records the unfinished ones, with the steps they wait on and their requests, in the stack journal (`operation.runs` in its JSON receipt). The reset preview, its confirmation and its receipt list those runs as of the last down (`storeContents.runsAtLastDown` and `removedRuns` in JSON), and say so when no down recorded them or the read failed. A failed read never blocks the `down`.
- 303bf29: `cotal reset store` and `cotal reset space` name what is wrong with a target that has nothing to reset. A name no space has refuses `TARGET_NOT_FOUND` saying no registered or prepared space has that exact name, and names `cotal space` before the legacy-root step. A prepared space no stack has run for refuses `TARGET_NOT_FOUND` naming its root, `cotal up` and `cotal space forget`. Both used to say the reset needs a space this machine started and lead with the legacy-root step.
- be10c87: The `backup cleanup-fallback` and `backup recover` receipts and previews label the attempt row
  `Restore attempt`. They said `Full restore attempt`, which read as a full restore for a
  registry-only one.
- 9042ea2: The CLI reference says that a restore without `--store-dir` creates its store at `.cotal/nats` even
  when the preserved store is elsewhere, that the preserved store stays where it is until
  `backup cleanup-fallback` deletes it, and that `--store-dir` keeps the space on another disk.
- 5e02acd: `backup cleanup-fallback` and `clean restore-fallback` no longer delete files that no Cotal store
  writes. When the restore's old store also holds such a file, such as a report in a custom
  `--store-dir` folder or a file put into the fallback folder after the restore, the `--dry-run` names
  it and the cleanup refuses `CONFLICT`, names it and deletes nothing. The cleanup now removes the old
  store by its store entries, as `clean store` does, and moves the folder back if anything else is
  there. A restore into the preserved store's own path, which moves that store aside whole, refuses
  the same way before anything moves. Before, the cleanup deleted the whole folder with those files.
- 3fc0d8e: A restore that leaves the workflow runs out now says so and keeps their only copy. A registry-only
  restore, and a full restore of a user-mode artifact or one made before full backups held runs,
  starts the runs empty while the store it set aside still holds them. The restore receipt now names
  that store, with a `RUNS_NOT_RESTORED` warning for a full restore. `backup cleanup-fallback` and
  `clean restore-fallback` delete it only with `--discard-history`, as they already did for a
  registry restore's history, and their preview, refusal and receipt name the workflow runs. The
  next step that `cotal status` shows for such a restore includes `--discard-history`, and a full
  restore that brought the runs back shows the plain cleanup.
  `backup create` says when its artifact holds no workflow runs.
- e93ff4c: A default `backup restore` or `up --restore` on a root whose `.cotal/nats` links to its store now
  restores that store in place. It ended `OPERATION_UNKNOWN` (exit 3) with "alternate restore target
  must not equal … the retained source", though no `--store-dir` was given and nothing had changed.
- 4725a7f: A full restore of a backup made before the state it replaced was preserved now says that it left
  out the chat and DM history and workflow runs written after the backup, and keeps their only copy.
  Its receipt warns with `NEWER_HISTORY_NOT_RESTORED` and names the store it set aside. The
  `backup cleanup-fallback` preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`, and
  `backup cleanup-fallback` and `clean restore-fallback` delete that store only with
  `--discard-history`, as they do after a registry restore.
- 583d267: `backup restore` and `up --restore` of a file, an empty folder, a folder no backup create wrote, or
  `.` in the folder they restore now refuse before they take the maintenance lock, naming the path
  and what it is, where they used to exit 3 with an unconfirmed outcome. A file, or a folder that is
  not an artifact, refuses `TARGET_NOT_FOUND`, and a path that is, holds or sits inside the preserved
  store or `.cotal/maintenance` refuses `USAGE_INVALID`. `backup verify` and `backup inspect` now say
  whether such a path is a file or an empty folder.
- deaccaf: A restore whose artifact path names the preserved store or `.cotal/maintenance` only once the restore
  holds the maintenance lock, such as a link changed during the restore, now refuses `USAGE_INVALID`
  with the same message as the check before the lock, naming the path and that store or folder. It used
  to exit 3 with an unconfirmed outcome and a message that named neither.
- fcf2dba: `backup restore`, `up --restore` and a bare `up` that resumes a preserved cut now probe the broker
  address they will bind before they move or start anything, as `backup create` does. While another
  process listens there they refuse `CONFLICT` (exit 2), name the address and leave the cut unchanged.
  Before, the restore went past its commit point and the resume started, the broker failed to bind,
  the command exited 3, and the root was left degraded.
- 4dcdc62: A full restore of a backup made before the state it replaced was preserved now names each workflow
  run it rolled back, and each step that was answered after the backup and is open again, in its
  receipt, in `cotal status` and in the `backup cleanup-fallback` preview. It says that answer is
  only in the store the restore set aside. To read it, the restore copies that store and reads its
  run journals on one more isolated broker, through a new read-only maintenance login on the step
  journal stream.
- cbb6cc7: The CLI reference no longer says a restore accepts a non-empty `--store-dir`. `up --restore` and
  `backup restore` refuse any path that already exists, other than the preserved store, as the
  backup section already said.
- e6a8ff4: A full `backup restore` or `up --restore` refused `CONFLICT` because the root's trust state moved,
  such as after `clean all`, now names `cotal backup restore <dir> --only registry` in its Next when the
  artifact holds the registry, which restores the channel settings with history starting empty.
- 5bc69c1: On a legacy root, `cotal up` after `down --preserve-state` with a `--server` other than the recorded broker address now refuses `CONFLICT`, exit 2, before anything starts, as another `--store-dir`, `--max-file-store` or `--runtime` does. It used to resume the preserved state at the other address.
- 1e71fd3: A broker or delivery stop that was cut off after it recorded the member `stopping` and before it sent the signal, for example when a foreground `up` lost its terminal while stopping its stack, no longer leaves the stack stuck. The member kept running under a stop it never received, and `down`, `down --abandon-stop` and `service stop` all refused. The next bare `up` or `down` now returns that record to `running`: `down` signals the process again and `up` reuses it.
- 6f1bdce: On a legacy root, `cotal up` after `down --preserve-state` with a `--max-file-store`, `--store-dir` or `--runtime` other than the recorded one exited 3, outcome unknown, with no next step, and a `--store-dir` that held no store said only "store path is missing". It now refuses `CONFLICT`, exit 2, before anything starts, naming the value given and the recorded one. The next step resumes with `cotal up` without the flag, then `cotal down` and `cotal up` with it.
- 55ceab6: `auth revoke-credential` given one of the stack's own system-account credentials, such as
  `connection-evictor.creds` or `membership-observer.creds`, now refuses `UNSUPPORTED` and says the
  space's system account issued it. Its Next is `cotal down --yes`, then `cotal up --rotate-sys`,
  which retires that account's credentials, and it says that full backups taken before then no longer
  restore. Before, it refused `CONFLICT` as a credential from another account and told you to run it
  for the space that issued it, which was this space.
- d5e1e1f: A `--creds` file whose key the space's account on this machine revokes is refused naming the revocation, such as `credentials rejected at <server>: the key <key> in <file> was revoked at <time> with auth revoke-credential`, with a Next that mints a new key with the grants the file held. Before, `send`, `history` and `who` said only "credentials rejected … check your creds". `cotal whoami --creds` reports `revokedAt`. A channel post refused for a `--creds` agent file names that file's own post grant, where before it said this machine cannot read the grant.
- 16dd187: A label's own credential file whose key `auth revoke-credential` revoked is no longer reported
  healthy. `doctor auth` lists it in state `revoked`, with `revokedAt`, as a finding whose repair is
  `auth mint <label> --replace` with the file's read and post channels and role. Any other revoked
  agent file names stopping the agent that uses it. `auth mint <label> --replace` now replaces a
  revoked standing credential at once, under a new key, and its receipt says the key was revoked.
  Before, it refused until the credential expired, up to 24 hours later. A revoked key is still never
  signed again.
- 720c959: The `run` command's usage line, receipts and next steps, and the run docs, now name the canonical
  forms: bare `cotal run` to list runs, `run show` and `run check`. `ps` (or `list`), `journal` and
  `migrate` still work, and the CLI reference lists them as compatibility aliases.
- b928dfa: The CLI reference now names the codes these refusals give. A run verb given a program file that
  does not exist refuses `TARGET_NOT_FOUND`, one this account cannot read `PERMISSION_DENIED`, both
  exit 2, and a folder `USAGE_INVALID`, exit 1. `up --server tls://` without a certificate and key
  refuses `USAGE_INVALID`, and on a prepared root `UNSUPPORTED`, exit 2.
- 789de43: Cotal's own runtime Node is usable as an executable-endpoint handler after an older installer left
  its install group-writable under a umask of 0002. `cotal update`, run through the installer's
  launcher, and a new run of the installer remove group and other write from the folders and files
  you own in Cotal's install root, without following links. When every unsafe folder of a declared
  adapter path is inside that install, the refusal says so and names `cotal update` as the fix.
- 186ed2c: `cotal send --file` and `--stdin` read the body only to one byte past the broker's message limit before refusing it. A large file is refused with its size without being read whole, and an endless input such as `/dev/zero` is refused at the limit instead of growing until the process is killed.
- 55a5c60: `cotal send` and `cotal chat <channel>` now give the real reason when a channel or role name breaks the subject rules. `send --channel kanäle` or `--channel 'gen eral'` says the segment must be a NATS-safe token, and `send --role 'bad role!'` says the role must be a single NATS-safe token. Before, every invalid channel name got "name one concrete channel, without wildcards" and every invalid role got "name one native role token". A wildcard channel still gets the wildcard message.
- e8bd4fe: `cotal send` refuses an empty `--to`, `--channel` or `--role` value for the flag that was given, with a remedy that keeps that flag. It used to say to choose one body and suggest `-t <agent>` whatever flag was used.
- 6a9b881: `cotal send --file` refusals begin with the mesh the send was aimed at and end with a Next that keeps the destination, as a refusal after connecting does. A missing file says it does not exist. `connectSpace` names the space `connectOrThrow` would connect to from local records, without a probe or a dial.
- f538f97: `cotal send --file` refuses a directory and a file that is not UTF-8 with `USAGE_INVALID` in the same refusal block as a missing or unreadable file, naming the path and without the command's help. A directory used to get a bare line followed by the whole usage block, and the UTF-8 refusal did not name the file.
- 4d577e6: A command that connects to a static-auth space whose stack folder was deleted while the stack ran,
  such as `send` or `history`, no longer says to restore the seed at that checkout. It says the
  folder is gone with its seed and names `cotal down --space <space> --yes`, the stop `status`
  already offers. Its JSON refusal now carries the space and folder as its target.
- 1253d61: `cotal send -t` or `-r` with `--mention` is refused as `USAGE_INVALID` (exit 1) with a remedy, since the parser can judge that combination, rather than `UNSUPPORTED` (exit 2).
- 981c6d0: A `send -t` or `--mention` name collision lists each full identity with its display name beside its kind and start time, so participants whose names differ only in case can be told apart. The send docs state that direct-target names match without regard to case.
- c3efa4f: `cotal send -r <role>` warns `ROLE_NOT_HELD` when no present participant holds the role. The message is still stored on the role's queue, and the warning names the closest role a present participant holds, such as `color` for `colour`, or lists the roles present.
- 59f7628: `cotal send --stdin` now waits for a piped writer that has not written yet or pauses, instead of refusing with `the message on stdin could not be read`.
- f7b15da: `cotal send -c` to a channel with no registry entry now says whether the channel already has messages or this message starts it, and lists the space's registered channels, so a mistyped channel name no longer gets the same warning as a post to a channel in use. The `--json` warning carries the same facts as `earlierMessages` and `registered`. The count is read as `cotal history` lists channels; where it cannot be read, the warning says it was not checked.
- c8aee2c: `cotal send --to` refuses a name that no participant can carry, such as one holding `\` or longer than 128 characters, with the name rule and before any presence lookup. It used to wait out the lookup and answer `TARGET_NOT_FOUND`. A legal display name, spaces and punctuation included, is still looked up.
- df1abff: A command given `--server` and no `--space` no longer dials the brokers this machine records at
  other addresses before it dials the one `--server` names. Its liveness sweep now probes only the
  records at that address, the only ones its resolve reads, so `history`, `who`, `ps` and the other
  commands that resolve this way connect to the `--server` address alone. `status --server <address>`
  no longer checks the selected space's recorded address when `--server` names another, and that
  row reads `not checked`. `status --all` still checks all recorded addresses because that flag asks for them.
- 70641aa: `cotal up --server` records and compares the broker address with the scheme in lower case and without a bare trailing `/`. A stack first started with `--server NATS://127.0.0.1:<port>/` is no longer refused `CONFLICT` as moved to another address when a later `up` passes `--server nats://127.0.0.1:<port>`. A path, query or fragment is still refused.
- 93f029a: Every command that takes `--server` refuses a URL with a user name or password in it `USAGE_INVALID`, exit 1, before it reads, writes or dials anything, and does not repeat the value. The NATS client keeps only a broker URL's host and port, so before, a command such as `send`, `history`, `ps`, `status` or `join` dropped those credentials in silence and connected with the credential it resolved. `up` keeps its own refusal.
- 9e538e7: `cotal service add <name> --file <definition.json>` looked the name up in the selected space before it read the file. A file for another space, named like a service the selected space already has, was refused `CONFLICT` "already exists" with a next step that removes the selected space's service. The file is now read first, so it gets the `SCHEMA_INVALID` refusal that names both spaces, as it does under a fresh name.
- 50561fb: `cotal service start` or `restart` for a definition whose `envRefs` read a variable the shell does not set refused `DEPENDENCY_UNAVAILABLE` with "a selected host environment reference is unavailable" and named no variable, and `service show` did not list the references at all. The refusal now names each missing variable and the child variable it feeds, never a value, with a Next that says to set it, and `service show` lists the references as `REVIEWS_TOKEN from MY_TOKEN`.
- 1a6cd03: `cotal service add` now looks a bare executable name, such as `python3`, up on its `PATH` once and
  saves the absolute path it finds, so a later `start` runs the same file whatever the starting
  shell's `PATH` is. A `PATH` with a relative or empty entry refuses that lookup, as a unit install
  does. The add receipt shows the saved executable. A definition saved with a bare name by an earlier
  release refuses to start and says to add it again.
- 3ae7d67: Several instance records of one service no longer leave every bare command stuck. A `service start|stop|restart|status|logs` that names no instance while several records exist still refuses `TARGET_AMBIGUOUS`, and its Next now lists each instance with its state, plus a `cotal service remove <name> --instance <id> --space <space> --yes` command for each stopped one. The new `service remove <name> --instance <id>` forgets only that stopped instance record, after the checks `remove` makes for every record, and keeps the definition, its other instances and the logs. A controller stack's member records are refused there. `cotal down` refused by another live service instance in the space now names `cotal svc stop <name> --instance <id> --space <space> --yes` for each one, where its Next was a literal `cotal svc stop <name>` that ran into the same ambiguity.
- cd8dbeb: A service start, restart or install whose executable or working directory was moved, removed or
  changed mode since `add` now names that path and what is wrong with it, such as `does not exist` or
  its mode, and its Next names the fix: putting it back, `chmod u+x <path>` or `chmod u+rx <path>`,
  or `cotal service remove` to add the service again with another path. It used to say only that the
  executable or working directory was not usable, with no path and no Next.
- 178b537: Quote executable and working-directory paths in launch-permission repair commands, so spaces
  and apostrophes remain part of one path when the command is copied into a shell. Refusal codes,
  launch checks and permissions are unchanged; repairs are never applied automatically.
- 22028f2: A background service's log no longer grows without bound across runs. A start or restart moves a
  log of 16 MiB or more to `<log>.1`, replacing an earlier one, and the run writes a fresh log. A
  running service's log grows until its next start.
- 8cfcf38: `cotal service logs` on a service log this account cannot read ended `OPERATION_UNKNOWN` (exit 3) with the raw `EACCES` error and no remedy, though it only reads. It now refuses `PERMISSION_DENIED` (exit 2), naming the log and `chmod u+rw`, with the path quoted when a shell would split it.
- 1d4a53f: `service logs --tail <n>` reads back from the end of a log until it has n lines, up to 16 MiB, so
  long lines no longer cut a tail short at 1 MiB. `service remove` deletes the removed instances' logs
  and names each file it deleted.
- ae51a90: `cotal service logs` returns a complete result, exit 0, when its tail holds every line asked for. A
  log longer than its 1 MiB bounded read made every tail partial, exit 4, so a script could not tell
  the tail it asked for from a failure. A tail is now partial only when that read holds fewer lines
  than requested.
- 94a5354: `cotal service add <name> --preset broker` used the preset's own `--server` and `--root` to choose the space. In a prepared space that was not started it saved the definition into "main", even with that space selected, and with `--space` it refused as "prepared but not started". Only `--space`, the selected space or the folder's space now choose where it is saved, as for `--file`.
- cc980ed: `service start --new-instance` of a service whose HTTP readiness address its first instance answered reported the new instance running and reachable, though the new process had already failed to bind that port. A start now sends one readiness request before it launches, and when something already answers there it refuses `CONFLICT`, exit 2, naming the address and the instance that answers, and launches nothing. A service that keeps answering its readiness check with another status, such as 503, now fails with `OPERATION_FAILED`, exit 5, naming that status, instead of sharing the unknown outcome of a check that got no answer. That unknown outcome's Next now also names `cotal service show <name>`, which shows the readiness deadline. A process service with process readiness whose child exits at once, such as on a bad configuration, was reported running by `service start` and `service restart`, and its exit code was never recorded. Process readiness now waits up to one second for such an exit, and the start fails with `OPERATION_FAILED`, exit 5, recording the exit code; a restart is partial, exit 4, and names the replacement's exit code and its log.
- e9dd1de: When the space's service instance records folder under `services/` in the Cotal home was not writable, `cotal down --yes` exited 3 with an unknown outcome, left every member running and blamed the manager, and `cotal up` exited 3 saying the stack did not start every member. Neither named the folder. Both now refuse `PERMISSION_DENIED`, exit 2, before anything starts or stops, naming the folder and the `chmod u+w` that fixes it, and `down --dry-run` names it as a refusal the real stop would hit.
- 9fbfe6e: `cotal service remove` takes `--instance <full-id>` to forget one stopped instance record, but `cotal help service remove` did not list it. Its help and usage line now name it.
- d530831: A Ctrl-C during `service start`'s readiness wait now names the instance it left running and the
  commands that finish it, and `service status` and `cotal status` show that start as interrupted
  instead of starting.
- f8c506f: `cotal service status --instance` of a background service with no recorded supervisor whose process
  ended after readiness, with no stop through the controller, now names `cotal service logs <name> --space <space> --instance <id>` in its
  Next. Before, it showed only "Process observation: gone" and "Process stop evidence: not recorded",
  without pointing to that instance's recorded output. No exit code or signal is reported, because
  none was observed. The log may contain output explaining the exit; it is not guaranteed to do so.
- 1e6d789: `cotal service stop stack-manager` and `cotal service restart` on a full store refuse `DEPENDENCY_UNAVAILABLE`, exit 2, before any stop is submitted, as `cotal down` does: the message names the store and its `--max-file-store` cap, and Next names `cotal history clear --space <space> --yes` and then the same command. They used to exit 3 `OPERATION_UNKNOWN` with only "insufficient resources" and no Next.
- 351fc27: `service stop --dry-run` now names what the stop would signal: the process group with its member
  count, or the process alone, and the grace period before `SIGKILL`, and says a descendant that left
  the group, such as one started with `setsid`, is not signalled. `--json` carries it as `stopSignal`.
  A `service start` refused because something already answers its HTTP readiness address now names
  each process of this account that listens there by PID and program name, as the
  `SERVICE_ADDRESS_HELD` warning does, and its Next says to stop that process. The start still does
  not signal it.
- 440ce81: `cotal service stop` and `restart` now signal the process group a background start leads and wait
  for the whole group to exit. A server that a shell backgrounded no longer outlives the stop and
  keeps the service's port. When a saved service's HTTP readiness address still answers while none
  of its instances runs, `service stop`, `service status`, `cotal service`, `cotal status` and
  `cotal down` print a `SERVICE_ADDRESS_HELD` warning naming the address and the process of this
  account that listens there.
- 52bf576: `cotal service stop`, `restart` and `uninstall` and a named `cotal down <service>…` name what kept
  them from asking when they refuse for a missing `--yes`: `--json`, `--no-input`,
  `COTAL_NO_PROMPT=1` or no interactive terminal.
- 63cf84c: `cotal help setup` fits 80 columns. Its examples use the short flags, and the self-hosted and runtime
  examples are the terminal forms, where setup asks for the rest, so each example stays one line to
  copy.
- f31f796: Choose an available, unreserved broker address when starting a new local space without an explicit address. Keep recorded addresses on later starts. Preserve confirmed local startup refusals and their diagnostics in setup instead of reporting every failed child command as an unknown outcome.
- 71bbae4: `setup --destination self-hosted` with a missing input prints the self-hosted scripted form, which
  takes `--connection-file`, instead of the local one. A space name `cotal up` cannot start is refused
  with the name respelled as the remedy, and an unknown `--harness` with a remedy naming
  `cotal ext add`, so `--json` carries a remedy for both.
- 4763411: A long-running command that SIGINT stops now ends cleanly and exits 130, and SIGTERM exits 143.
  `console`, `history --follow`, `channel members --follow` and `join` used to exit 0 on a signal, and
  the `watch` and `chat` terminal views died by the signal before the chat session closed. The JSON
  streams end with reason `interrupted` or `terminated`, `chat --stdio` included.
- 9ef5dca: Wait for isolated maintenance brokers to acknowledge delayed login reloads during backup and restore, within the reload and operation deadlines.
- f2e0c06: `space add` and `meshes add` refusing a public address or a host name without required TLS now say the connection must require TLS and name the `tls://` form of the same address, or `wss://` for `ws://`, as the next step, instead of asking for the address itself. A user-auth space from a bundle whose broker does not answer now gets the same diagnosis as a `--server` one: a host name that does not resolve, a port that takes no connection, or a broker under another scheme.
- 73930b2: A space `cotal space add --force` registers without checking its broker now records that its mode was not checked. `cotal space`, `cotal space show` and `cotal status` show the mode as not checked, with `modeChecked: false` in `--json`, and `cotal whoami` reports a partial result with `MODE_NOT_CHECKED` instead of stating that the broker authenticates nothing.
- 1e5423f: `cotal space add` refused for a broker that does not answer now gives a next step: pass `--force` to add the space unchecked, as for a space that is down right now. It used to carry no next step.
- c63f6d8: `cotal space add --server <url>` with no broker answering at that address now says why, with a remedy. It says when nothing takes a connection at the port, and gives the port check as the remedy. When a broker answers at the same host and port under another scheme, such as `nats://` for a `tls://` address, it names that address, says when it has no TLS, and offers it as the next `--server`. It used to say only that no broker answered, with no remedy.
- 6682bcb: `space add --server` with `tls://`, `ws://` or `wss://` against a port that greets as a plain NATS
  broker now says the scheme failed and names the URL to register. It used to say that no broker
  answered, as it does for an address where nothing listens.
- d166dc7: On a terminal, `space create` in a moved or copied folder that holds another folder's stack journal
  names its adopt command in backticks, as `status` there does, so a wrapped line keeps the command
  whole. Before, at 80 columns, the quoted `--root` path started on the next line, and at 40 columns
  it was split inside its quotes.
- d205ad2: A stopped controller project copied to another machine could never start there: `status` said to run `cotal space create <space> --root <copy>`, which refused because the folder was already the root of that space, and `up`, `down` and `clean all` said to use or move back to a folder that machine does not have. `cotal space create <space> --adopt` now takes over the copied stack journal: it rewrites it to name the new folder and the broker store under it, and records a stack that never ran there, so the next `cotal up` starts it from the copy with its store. It refuses, writing nothing, when the folder's `.cotal` is a link, when the recorded folder still holds the journal, when this machine records an instance of that stack, or when the space is prepared or registered here. Without `--adopt`, `space create` still refuses, and that refusal, `status` and the `up` refusal in a moved folder name the exact `--adopt` command.
- 1b7678a: `cotal space create` no longer exits 3 with an unknown outcome and a raw Node error when the folder it writes cannot take the space. A Cotal home (`~/.cotal` or `COTAL_HOME`) this account cannot write now refuses `PERMISSION_DENIED`, exit 2, naming that folder, and the empty project `.cotal` the attempt made is removed, so nothing is left behind. A project `.cotal` that links to a folder that does not exist refuses `TARGET_NOT_FOUND`, exit 2, naming the link and its target. Nothing is written in either case, and `cotal setup` refuses the same way.
- c9c8868: `cotal space create <name>` in a folder another space already uses refused with "create the space in another folder, or pass --root <dir>", even to a caller who had just passed `--root`, and named no step for the space already there. The next step now names creating it in another folder with `--root <dir>` (`--project <dir>` for `setup`), and starting, selecting or forgetting the space that uses the folder.
- 1e254be: `cotal space create` in a folder whose stack journal is not valid JSON said the folder was already the root of the space whose trust it keeps, and named another folder as the way out, for any space name and also after `cotal space forget`. It now refuses `SCHEMA_INVALID`, exit 1, naming the journal and the way out, as `up` and `down` do. When no space is recorded at the folder, as after `space forget`, that way out no longer promises saved definitions: it says to remove the journal and run `cotal up`.
- 7aa9d14: `space delete` now lists the workflow runs that have not finished, with their recorded state, in its
  dry run, its typed confirmation and its receipt, says that a run waiting for an answer goes with the
  space, and names `cotal up`, then `cotal run show <run>`, to read a run's open request first. It used
  to delete them without a word. The `teardown` credential's grant now reads run states: one direct get
  on the space's records bucket, confined to run status keys, on a stream it could already delete.
- 99853a8: `cotal space delete` with a typed confirmation now refuses `CONFLICT` when a stream's message count
  changed while the confirmation waited, naming each changed count. A message posted after the impact
  was shown used to be deleted with the rest, because only the stream states and presence were
  checked again.
- 09d7263: When a service the user added still runs in a space, `cotal space delete` now names that service and
  the `cotal service stop` that stops it. Its Next used to name `cotal down --yes`, which refuses while
  that service runs. With only the broker left after the stop, it names the delete again.
- 531b374: When a space's streams are gone from a broker that still runs, `cotal status` says so and names the
  way back, and `send`, `history` and `run ps` refuse with that cause. On an open space that another
  machine deleted under a running stack, status showed the space as reachable, `send` exited 3 with
  "may have been stored", `history` reported an empty conversation and `run ps` printed a raw
  contract-store error. Status now shows `Space streams: not on the broker` and leads its Next with
  `cotal down --yes`, then `cotal up`, or with `cotal up` when the stack's other members are stopped.
  The three commands refuse `TARGET_UNAVAILABLE` with the same remedy.
- 71218f2: The `space` listing marks a prepared space whose folder no longer exists and names `cotal space forget` for it instead of offering `cotal up`, and each `prepared` entry in its `--json` carries `rootMissing`.
- 1799e25: `cotal space` no longer says "No spaces registered" above the prepared space it lists. With only
  prepared spaces, it says no space has been started or registered yet. The prepared table's header
  reads `Space  Project` instead of `SPACE  Project`, and the registered table's `ROOT` column is
  `Project`, as in the prepared table.
- 81f82e3: `space create`, `space add` and `meshes add` refuse a space name that starts with `-` with `USAGE_INVALID`, exit 1, before anything is written. Such a name cannot be passed as a flag value, so `use`, `--space` and the stack's own delivery child could not take it. The docs state the name rule: ASCII letters, digits, underscores or hyphens, starting with a letter, digit or underscore.
- 03e3777: `space create` refuses a space name longer than 64 characters with `USAGE_INVALID`, exit 1, before
  anything is written. A longer name failed with a raw `ENAMETOOLONG`, exit 3, and left an empty
  `.cotal`, or was prepared and then could not be started by `cotal up`.
- 88c64a0: The docs allowed space names of 1 to 200 characters, but every local file that carries a space spells its name twice over, and a file name holds at most 255 bytes. `space create` of a name longer than 116 characters failed with a raw `ENAMETOOLONG`, exit 3, and `cotal up` of a space named with more than 100 characters failed partway, with a delivery daemon that exited or a broker that was never defined and no cause recorded. A space name now holds at most 64 characters. `space create` and `cotal up --space` refuse a longer one with `USAGE_INVALID`, exit 1, naming the limit and its reason, before anything is written, and `cotal up` refuses a longer name an earlier release prepared the same way, naming `cotal space forget`. The `--max-file-store` docs no longer say a controller stack keeps the cap across `down --preserve-state`, which it refuses; it keeps the cap across `cotal down`.
- 8be664d: `space create` with a name of characters `cotal up` cannot start, such as `"bad name"`, now gives a remedy, so its `--json` envelope says which characters a name can use as the text form does.
- 6a39b4d: A refusal for a space name no space has no longer heads its report `Mesh: <name>`. `space create`
  of a name it refuses, and `space show` and `space forget` of a name that is not registered or
  prepared, carry the name as `target.requested` instead of `target.space`. `meshes add` and
  `space add` now refuse a name `space create` refuses, such as `a*b`, with `USAGE_INVALID`, even with
  `--force`. A mesh an earlier release registered under such a name still lists, shows and removes as
  before.
- a2f00f6: A bare `cotal space show` in a project folder shows that folder's space when nothing is selected, as every other command there targets it. Before, it refused with "no space is selected" unless some other space was selected. Outside a project with nothing selected it still refuses.
- acf7aea: `cotal space show` of a prepared space whose project folder was deleted now says the folder no longer exists and names `cotal space forget` and `cotal space create --root`, as the other commands do, instead of telling you to start it with `cotal up` in that folder. `--json` gives `rootMissing: true`.
- 48431ca: After a live `cotal space delete` and before `cotal up`, `cotal history` and `cotal send` on a recorded auth or user space refuse `TARGET_UNAVAILABLE` (exit 2), saying the space's streams are not on its broker and naming `cotal up` in the space's root. History used to read zero messages, and send exited 3 with `no responders`. `chatRetention` also returns whether the chat stream exists.
- bfb6d80: `cotal space show` and `cotal use` with an unregistered name now head their refusal `Mesh: <name>` and carry the name in `target.space`, as `space forget` and `space delete` do.
- dab2d83: `cotal space forget <name> --yes` refused with "--yes is taken by `cotal space add` only", though `cotal space delete` takes `--yes` too. The refusal now names both.
- b3f2369: An unpinned `spawn -d` that no manager takes no longer waits out the reply deadline on a registered manager whose host is gone. It skips a manager the broker reports nothing subscribed on, names it in a `MANAGER_SILENT` warning, and gives the reason the managers that answered report, such as none having an agent application installed.
- 232db41: When a managed spawn on a user-auth mesh is refused because the chosen manager's catalog has no
  `default` persona, the Next now gives the spawn again with `--on` for each of your other live
  managers whose catalog lists one.
- 83c2b1b: A managed spawn that a manager cannot run because it has no agent application installed is now
  refused with `DEPENDENCY_UNAVAILABLE`, as a spawn in this terminal is, whether it is pinned with
  `--on` or sent unpinned with `-d`. Both refusals name the manager and the host its status reports,
  and say to add the application where that manager runs, then restart it.
- 7fb38be: A managed spawn refused because the manager's catalog has no such persona now names that manager,
  its host and the catalog file to create there, instead of pointing at `--config` and
  `cotal personas list`, which act on your own machine. When another of your live managers has the
  persona in its catalog, the Next gives the spawn again pinned to it, on every kind of mesh rather
  than only for a missing `default` on a user-auth mesh.
- dcf3ad6: `spawn -d --on <instance>` to a manager that does not answer is refused `TARGET_UNAVAILABLE`, exit 2, saying the launch was not sent, as `ps --on` and `stop --on` are, where it reported an unconfirmed outcome, exit 3. On a static or open mesh an instance id that names no running manager is refused `TARGET_NOT_FOUND` at once, naming the managers that run, or `TARGET_UNAVAILABLE` when none runs, instead of waiting out the 10 second reply deadline.
- 2a4d99e: A managed `spawn -d --dry-run` exits 0 with `completeness` `not-checked`, instead of exiting 4 with
  an error mark. Both previews name the persona's source in words: `--file`, the command line, a
  preference or the default. A harness that names no connector this workstation knows is now a
  warning, `HARNESS_UNKNOWN`, or the `PREFERENCE_INVALID` warning `config` gives when only
  `COTAL_DEFAULT_AGENT` chose it. The JSON source `explicit-or-product-default` is now `argument` or
  `default`.
- 79deef5: `spawn --dry-run` refuses a missing persona the way the launch does. It names the catalog directory
  or the file it checked, gives `--file <persona.md>` or, for a missing default, the command that
  writes one, and uses `TARGET_NOT_FOUND`. It no longer reports an invalid file and points at
  `cotal team deploy`.
- 207a291: An unpinned `spawn -d` whose describe no manager answers, as when every registered manager's process has died, is now refused `TARGET_UNAVAILABLE` (exit 2) saying the launch was not sent and nothing was launched. It used to report `OPERATION_UNKNOWN` (exit 3) and tell you to inspect the manager before retrying, although nothing had been submitted. When this folder's stack records its manager stopped, starting or running but silent, the refusal says which and names the same next step `ps` does.
- bec3778: A controller stack whose journal was removed, after `cotal down` had dropped its registration, started at the default address 127.0.0.1:4222 on the next bare `cotal up`, without saying so. `cotal up` now starts it at the address its saved broker definition names and warns `STACK_ADDRESS_RECOVERED`. With no saved definition either, a folder that holds the space's trust or a store from an earlier start refuses `USAGE_INVALID`, exit 1, and asks for `--server`. A freshly prepared folder still starts at the default address.
- 4de7f7a: A controller `cotal down --yes` printed its stop plan, the manager's impact and the broker's stop scope before its receipt, named the mesh twice, and listed the stopped members in the reverse of the order it stated. It now prints one receipt: the mesh once, each member with its result in stop order, and `cotal up` as the next step. An interactive `down` still shows the plan and the manager's impact before it asks to confirm.
- f208d04: `cotal up --host 0.0.0.0` opened the broker, a plaintext broker websocket and the manager's plain HTTP console on every interface, while its receipt and `service status` named only the broker's loopback URL. The controller stack's receipt now has a `Listeners` section naming each listener with its address, how far it reaches and whether it is encrypted, and says when a plaintext listener is reachable from other machines. `service status stack-broker` and `service status stack-manager` list their own while they run, and `--json` carries the list as `listeners`. The manager picks its console's port when it starts and records it nowhere, so the console is named by its host.
- 73f1e59: A controller stack keeps the `--max-sessions` an earlier `cotal up` set. A bare `up` after `cotal down` used to start the manager with the default of 64, because the manager's definition was rebuilt from the command line alone. It now takes the ceiling from the saved definition, and an explicit `--max-sessions` still replaces it.
- 4ce7a3d: `cotal service remove stack-manager --yes` removed a controller stack member's definition once its instance was stopped, although the docs say a stack's member records go only with `cotal space forget`. The next bare `cotal up` then defined and started that member again, and after `stack-delivery` was removed from a stopped stack, `cotal down` refused because a recorded member's definition was missing. `service remove` now refuses a stack member's definition with `UNSUPPORTED`, exit 2, keeps it, and names `cotal down --yes`, then `cotal space forget <space>`.
- 0aee903: A controller stack that took a channel-only `cotal team deploy` now starts again with a bare
  `cotal up` after a clean `cotal down`, and the deployment's records and cards stay as they are. The
  start used to refuse `LIFECYCLE_BLOCKED` with no next step, and `team remove` needed the registration
  that `down` removed, so the stack could not start again. A start that another retained deployment
  still blocks names `cotal team show <id>` for each one. `team remove` on a stopped stack names
  `cotal up` in its root and then the remove again, and a refusal over an edited card names that card.
- e61399c: A `service start` that selects an instance record of an earlier definition revision, as a definition
  moved aside and added again leaves, still refuses `CONFLICT`, and now names that record and a Next:
  `cotal service remove <name> --instance <id> --space <space> --yes`, then `start` again, after a
  `service stop` of that instance when it still runs.
- 83b08a3: On a controller stack, a crashed member's process record whose pid another process now holds no longer blocks `cotal down` or `cotal down stack-broker`. A record whose process is gone, or whose pid runs another start than its identity pin records, is stale: `down --dry-run` names it, and a complete `down` removes it with its pin and says so in a `STALE_PROCESS_RECORD` warning, without signalling the process that holds the pid. A record that may still front a live process still refuses, and the refusal now names each record's path and pid, with a Next that says what to check.
- cb3b967: Check a new project's folder-derived space name once inside startup, so an unreadable prepared-space
  registry keeps its classified refusal instead of printing a stack trace. Existing prepared or
  registered spaces retain their names even when their project records directory is empty or missing.
- 8d59280: `cotal space add` and `cotal meshes add` refused for a static-auth space whose trust is not in `--root` no longer offer `--mode open`, which a broker that requires auth refuses. They now name what a machine without the space's signing seed can use instead: a credential the owner mints with `cotal auth mint`, passed with `--creds <file> --server <url>`.
- 1de1f58: `status --all --server <address>` no longer shows the `--server` connection's state in the selected
  space's row under its recorded broker when `--server` names another address. That row now reports
  the check of its own recorded address, as `meshes.items[].check` in `--json` already did, so a
  recorded broker that answers no longer reads `unreachable` because the `--server` address did not.
- aef1cf1: `status` no longer calls a selected space stopped when the last `up` of its stack was cut off after
  it launched the broker and before it registered the space. The Brokers block says the space is
  prepared, not started, as it does when the cut came earlier, and `meshes.currentStopped` is false
  while that broker runs.
- 26f407a: `cotal status` now follows a controller stack whose last `up` or `down` was cut off before it
  recorded an outcome, even when that `up` ended before it registered the space. The selected space
  names the blocked or half-started stack, and Next leads with the step that works: the stop to abandon,
  the member to inspect, or `cotal down --yes` and then `cotal up --root <root>` when the cut-off `up`
  left its broker running. Before, plain status said the space was prepared but not started and offered
  `cotal up`, which refused. A command that targets such a space, such as `cotal ps`, says its last
  operation has no recorded outcome and names `cotal status` in its root. While the stack is blocked,
  the `Delivery responder` row says that `up` refuses until the block is cleared instead of offering
  `cotal up`. `status --json` adds `space` and `root` to an unresolved `not-started` selection.
- 9e9fcab: `cotal status` no longer reports a controller stack's delivery member as `NOT BOUND` with `cotal up` as the remedy while its process runs without a delivery lease, as when it hangs. The delivery responder line names the member's pid as alive with no lease, so it is starting or not responding, and Next names `cotal service status stack-delivery`, then `cotal down --yes` and `cotal up`. `status` cannot probe the delivery daemon directly yet, so it does not tell those two apart, and a hung daemon still reads as bound until its 30-second lease expires.
- a87c0fb: `cotal status` on a space whose store is over its `--max-file-store` cap now names the route that keeps the history, as `up` and `down` do: `kill -TERM <pid>` for the stack's manager on this host, then `cotal down --yes` and `cotal up --max-file-store <bytes>` with a larger cap. It used to offer only `cotal history clear`, which purges the history.
- 02e1ae5: `cotal status` names a controller stack that an interrupted `up` or `down` left part way, and offers
  the command that finishes it first. After an `up` cut off before the manager started, status listed
  the running members with no word about the missing one and offered no `cotal up`; after an
  interrupted `down` it offered only a restart. It now shows `Half started` or `Half stopped` with the
  members on each side, and leads Next with `cotal up --root <root>` or `cotal down --yes`. The next
  `up` or `down` no longer calls the earlier operation failed when every member already runs after an
  `up`, or is stopped after a `down`, and it names a member that never started.
- a054adc: `cotal status` listed the selected space's service instances, in its rows and in `result.services.instances` under `--json`, by their random instance IDs, so the stack's members changed order whenever one started under a new ID. They are now listed by definition name, then instance ID, as `result.services.definitions` is.
- 3caf13f: `cotal status` in the folder of a static-auth stack whose broker or manager exited now puts
  `cotal up` first under Next, which starts it again on the recorded address and store. Before, the
  manager's stale pidfile was followed only by `setup`, `ps` and `use`. A broker's stale pidfile left
  `clean store --force`, which removes the stored history, as the only recovery command named.
- 5a96028: `cotal status` in a folder whose `.cotal` is a link names the refusal that `up` and `down` give there, and its Next gives their next step. Before, its selected space and Next still said to start the space with `cotal up`, which then refused.
- 567073e: `cotal status manager`, with the manager answering, now says that `manager` is the space's manager
  and not an agent it runs, and points to `cotal status` and `cotal endpoint describe manager`. It
  refused as an unknown agent with no next step.
- b7916c6: After a foreground `up` lost its terminal, or a `down` was killed, while it stopped the broker or the delivery daemon, `up` and `down` refused until that stop was abandoned with `cotal down --abandon-stop <request-id> --yes`, but `status` offered `cotal up --root <root>`, which refused. `status` now says why the stack is blocked, names the member, and offers the same `--abandon-stop` command and the member's `service status`. `status --json` carries it as `folder.stackBlock`.
- fe808a2: `cotal status` on a controller stack started with `--no-manager` now has a Manager row saying the stack runs no manager by choice and that bare `cotal up` adds it. It used to list the broker and delivery members and never mention the manager. `status --json` reports it as `folder.noManager`.
- 1402dd2: `cotal status` with a selected space that is not registered and a `~/.cotal/prepared` it cannot read now reports partial, exit 4, naming the folder under `meshes.unreadable`, as it does for an unreadable mesh registry folder. It refused the whole report. A hint two readers give is listed once.
- 0c53a6d: Quote the root in status restart commands after an interrupted stop or deleted space streams.
  Roots containing spaces, apostrophes or shell variables stay one literal argument when the
  printed command is copied into a shell. Recovery ordering, flags and lifecycle checks are unchanged.
- 4bdffc8: In open or static-auth mode, `status --server` at an unreachable address other than the recorded
  one no longer offers `cotal up --root` to restart the stack's stopped members while that stack runs. Its
  Next names the address that did not answer and the recorded broker, as the refusal of other
  commands does. A stack member whose process is gone still leads with `up --root`.
- ff650ba: A prepared space whose controller stack ran and was stopped read as "prepared but not started", the words for one that never ran. `status`, and every command that refuses a space that does not run, now says it is stopped, with its last operation and how it ended. When that stack recorded a file store cap below 67108865, `status` shows the cap in a `Store cap` row, and Next names `cotal up --max-file-store 67108865` or more instead of a bare `cotal up`, which would fail on that cap.
- 9195e4e: `cotal status` now shows a `Store` row reading `damage logged` when the space's running local broker logged damage in a stored file since it started: a message block whose records do not parse, a stream whose recovery rolled back past what a consumer had delivered, or a stream metafile that fails its checksum. The row quotes the broker's warning, and for a controller stack the Next is `cotal service logs stack-broker`. It used to report the store as fine while `history` returned fewer messages, and only the broker's log said why.
- 5795d6f: `cotal status` after a broker store write failure words its Next as `First <repair>; then cotal up starts the broker again with the history it kept`, as it did before the JetStream-disabled route was added, instead of ending the repair with `does first`.
- 3be9acc: `cotal status` with no mesh running, a prepared space not started, or a folder that names no space now marks the selection as absent instead of with the mark a reachable mesh gets, and gives its step once, under Next. The `selected.message` field states why, and `hints` carries the step.
- 68b7557: With a stack journal that is not valid JSON, `status` no longer offers `cotal up` or
  `cotal clean store --force` under Next, which both refuse until the journal is fixed. Next now gives
  the journal's own step, as `up` and `down` name it: remove the file when no member runs, or stop each
  running member first.
- cc3872d: A `cotal chat --stdio` `send`, `dm` or `anycast` request whose `text` is empty or only whitespace is now refused with `USAGE_INVALID` and `the message is empty`, the sentence `cotal send` gives for an empty message. Before, the request was stored and showed in history as a row with no body.
- 81e50d7: The `chat --stdio` docs now define `join`'s `backfilled`: the retained channel messages the join read back, which can be more than the inbox gains when some were already handed over, held or dropped.
- 5f1e773: A `chat --stdio` session sometimes never wrote its own presence `joined` record, and never wrote one for the members already online: what the session reported while it started, before its front end subscribed, was dropped. The front end now gets it, so the session's own row and each member already online come as `joined` as it opens.
- 5cbbd6f: Every `attention` and `channelMode` change in a `chat --stdio` session sent peers a presence `updated` record whose row was unchanged, since the row shows neither. A presence change that leaves the row as it was now writes no record, and `updated` means a field the row shows changed.
- a8c3461: A `chat --stdio` `status` request with an `activity` reached every peer as two presence `updated` records, the first pairing the new activity with the old status. It now sets both in one presence write. `CotalEndpoint.setStatus` takes an optional activity for that.
- 8365955: A `down stack-broker` refused while a service outside the stack runs, such as one added with
  `cotal service add`, now names that service's `cotal service stop` first and then bare `cotal down`,
  which refuses beside it. Its other route names the stack members' own stops and the broker stop
  again. The dry run warns with the same refusal.
- cee533e: The dry run of a stop of the stack's broker, as `down stack-broker --dry-run` or
  `service stop stack-broker --dry-run`, now warns with the refusal the real stop gives while another
  service instance of the space is live or a legacy daemon record under the root may front a process.
  That refusal's Next names `cotal service stop <name> --instance <id> --space <space> --yes` for
  each instance instead of a `<name>` placeholder. On a stopped stack, `down --dry-run --with-agents`
  still shows the no-op and now warns that the real `--with-agents` stop refuses.
- a923eaa: On Linux, a broker on a loopback address whose process is stopped by a signal, such as SIGSTOP, is
  named with its pid instead of waited on. Once the first dial times out, the refusal names the pid
  and gives `kill -CONT <pid>`, without the longer confirm, so `run ps` returns in about 3 seconds
  instead of 35. `cotal status` shows the connection as `broker process <pid> is stopped` and offers
  the same command, and `down` refuses at once from the broker's recorded process state.
- b505ad6: A command run in a folder whose stack was stopped with `cotal down` no longer dials the default broker address `127.0.0.1:4222`. That `down` drops the folder's registration, and commands such as `send`, `history`, `ps` and `who` then fell back to the default address and presented the folder's credentials to whatever listened there. They now refuse with `TARGET_UNAVAILABLE`, naming the address the folder's last start configured, with the bare `cotal up` that starts it there again as the Next.
- 457d771: After `cotal down`, `space`, `space show` and `use` read the space as stopped, with its last operation, such as `cotal down, completed`, as `status` does. Before, they called it prepared and not started, and `space` said no space had been started yet. `space --json` adds `state` and `lastOperation` to each prepared entry, and `use --json` adds `preparedState` and `lastOperation`.
- 9b9ded2: `cotal up --max-file-store 67108864`, the documented minimum, always failed with JetStream error 10047: the space's membership bucket reserves all of it, and nats-server creates each other stream only while one more byte is free. The least accepted cap is now 67108865, a smaller one refuses `USAGE_INVALID` before the broker starts and names it, and the docs state it.
- 05e8906: `cotal up --store-dir` and `cotal backup restore --store-dir` now refuse a path that is a link,
  naming the directory it points to. `up` used to accept it and record the link, and every later
  `reset store` and `reset space` then refused without naming a path. Those refusals now name the
  recorded store path, and for a link the directory it points to and how to replace it.
- 2f99b5a: `up` refuses a `--store-dir` that does not exist while the root's last served store still holds data, since the start would open a new empty store at a mistyped path; creating the directory first names a new store on purpose. A `--store-dir` path this account cannot create is refused `PERMISSION_DENIED` before anything is written, instead of failing with a raw `EACCES` from `mkdir`.
- cf7dc5c: `--store-dir` refuses an empty value `USAGE_INVALID` instead of reading it as the default store, and
  refuses a value that starts with a `~` no shell expanded instead of making a folder named `~`; that
  refusal names the absolute path to pass. A store in the project folder itself, as `up --store-dir .`
  makes, still refuses `clean store` and `reset store`, now `CONFLICT` with a Next that names the
  store's own entries to remove by hand.
- d08c387: A store folder now belongs to one space. `cotal up --store-dir`, with or without `-f`, refuses
  `CONFLICT` when another space's registration, stack journal or broker configuration names the
  folder, or when the folder holds that space's streams, and names the space, its root and its
  streams. `reset store`, `reset space`, `clean store` and `clean all`, and their dry runs, refuse such
  a folder the same way instead of deleting the other space's data with it. A folder an earlier release
  let two spaces share still starts from its recorded store with a `STORE_SHARED` warning. A
  controller stack whose recorded store folder is missing starts empty and warns `STORE_MISSING`.
- 7fcc25d: `cotal up` over a broker store this account could not write exited 5 with "its log records the cause", and only the broker's log said "storage directory is not writable". `cotal status` afterwards said to start the space with `cotal up` again. `up` now checks the store before the broker starts and refuses `PERMISSION_DENIED`, exit 2, naming the store and `chmod -R u+w`, and `status` names the same step for that space.
- 620d06b: The `ocsp` folder nats-server makes in its store directory when it reloads its configuration, as a
  restore does, now counts as part of the store. `up` no longer warns about it, and `clean store` and
  `reset store` remove it with the store instead of refusing the directory.
- 3999c9d: The `chmod` step that `cotal up` and `cotal status` name for a broker store this account cannot write printed its path as is, so a root whose name held a backtick or a space gave a command that a shell would substitute or split. The path is now quoted for the shell when it needs it, as the `--root` hints already are.
- 5c8c99a: Refuse a broker store root without read access before startup, even when its JetStream folder is writable. Previously a write/search-only store root made `up` end `OPERATION_UNKNOWN` without naming the cause, and `status` suggested starting it again. Both now name the root and the quoted `chmod -R u+rwX` step. This does not require read access on the writable JetStream child, which can still retain messages without it, and no permissions are changed automatically.
- e05dc21: A broker that stopped JetStream after a store write it could not make, such as on a store that went read-only, no longer reads as a deleted space. `send` and the other commands that read the space first said its streams were deleted under the running stack and named a restart that creates them again, empty, though every message was kept. They now refuse `DEPENDENCY_UNAVAILABLE` naming the write failure the broker logged. Only a broker that answers that the chat stream is not found shows the space deleted. The repair that `send` and `status` name now follows the cause: a permission denied makes the store writable again instead of freeing disk space.
- 58b025c: Every subcommand's help now gives its whole usage, from `cotal` through its arguments, such as
  `cotal channel set <name>` and `cotal persona create <name>`, and lists only the options that
  subcommand takes. `help history clear` no longer prints a usage without `cotal history`, and the
  usages of `meshes`, `personas`, `spawn`, `backup`, `describe`, `invoke`, `actor`, `agent-bearer`
  and `service-endpoint` now start with `cotal`.
- c6eab6e: `cotal team boot` on a stack that is up says so: the space is already up at this root, no `cotal down`
  has stopped it, and nothing was booted. Its Next offers `cotal team deploy <file>` with the same
  manifest, which adds its channels and agents to the running stack, or `cotal down` first. It said
  only that the last operation was not a completed whole-stack stop.
- 2354557: A second `cotal team boot` on a stopped stack that an earlier team boot started now names the way
  forward. Its Next names `cotal up` in the root, which starts that stack again, and `cotal team show`
  with the earlier boot's recorded ID. It used to name only `cotal team show <deployment-id>`, with a
  placeholder.
- 306e8a2: `cotal team boot <file> --dry-run` for a space with no root of its own says whose folder it read. In a
  folder that belongs to another space it says so and that the apply needs a folder of its own, with
  `cotal space create <space> --root <project-directory>`. In an unprepared folder it names
  `cotal space create <space> --root .` with the space filled in. It labelled both folders
  `invoking-folder-unprepared` and suggested `--root .` in a folder that belongs to another space.
- 2168647: `cotal team check` and `team boot --dry-run` show the manifest's `defaults:` block. A channel field
  the card leaves out shows the default it inherits at boot, marked `(default)`, instead of "not
  declared". The check's JSON result carries `defaults`.
- 7c271ce: `team check`, `team boot` and `team deploy` refuse a manifest file that does not exist with
  `TARGET_NOT_FOUND`, exit 2, naming its path. A missing required key, an empty file, a value of the wrong
  shape and one outside a key's fixed values now get a plain reason in place of the validator's text. A persona file that does not
  exist is named at its entry's line with the manifest's other problems, where an earlier problem used
  to hide it.
- ae92c25: An unknown manifest key that misspells a required key left out beside it, such as `chanels`, is now
  one `team check` problem that suggests the key meant, where it used to count as two.
- 5b6316e: `cotal team deploy` names the cards it refuses for lacking `deliveryClass: live` and says what to do:
  set it on each card, or create a durable channel with `cotal channel set <name> --delivery durable`.
  `team deploy --dry-run` warns `LIVE_DELIVERY_REQUIRED` for the same cards, so the preview says the
  apply would refuse. The manifest page lists each card's keys, `deliveryClass` among them.
- 737ca24: `cotal team deploy --dry-run` no longer says a reapply refuses. Reapplying an identical settled
  deployment changes nothing, and the preview now says so; other existing cards still refuse.
- 543354a: `cotal team show <id>` for a fresh boot, and `cotal team remove <id>` refusing one, offer
  `cotal down --space <space> --dry-run` with the recorded space filled in. They printed a
  `<recorded-space>` placeholder and said the guarded down was not integrated, although `cotal down`
  is the guarded whole-stack stop that the boot receipt already offers.
- fe757a8: A team deployment ID that no record in the root names is refused with `TARGET_NOT_FOUND`, which names
  the ID, by `cotal team show` and `cotal team remove`. It was `TARGET_UNAVAILABLE` with a vague Next,
  and `team remove <id> --yes` refused it as a route it does not support. `team show` adds that a
  deployment ID is 16 hex characters when the value has another shape.
- 2b28311: `team check`, `team boot` and `team deploy` given a folder instead of a manifest file, such as
  `team check .`, now refuse it as `topology view` and `up -f` do: `USAGE_INVALID`, naming the path and
  that it is a directory, with the Next to name the manifest file in it. They used to give a generic
  `SCHEMA_INVALID` that named no path.
- 645d6a3: A team read or preview that completes exits 0. `cotal team`, `team show <id>`, `team deploy --dry-run`,
  `team boot --dry-run` and `team remove <id> --dry-run` exited 4 with a failure line on stderr, although
  each one answered. Their JSON still marks `completeness` as `partial`, and the report has a line saying
  what the read does not establish.
- df9116b: The team reports name each record's kind, recorded state, next action and auth mode in words, such as
  `boot returned`, `inspect the stack` and `static auth`. `team show` printed the raw values, such as
  `broker-boot-returned`, and the auth mode read `auth`, `static` or `static-auth` depending on the
  report. The JSON results keep the recorded values.
- 5e08575: The team reports leave out rows that do not apply. `team check`, `team deploy --dry-run` and
  `team boot --dry-run` print "Durable delivery on open" only for an open space, and `team check`
  says "No agents declared." instead of an empty agent table. The deploy preview's TLS row reads
  `required` or `not required`, as `team show` does, instead of "not recorded required".
- a42556b: `team show` after a card removal lists each card's steps in the order they were written: the delete
  submission, then its outcome, with the cards in manifest order. It used to list "deleted at created
  revision" before "delete submitted; outcome not implied", so a finished removal ended on a step that
  read as still in flight, and a tenth card sorted before the second. The removal journal is unchanged.
- c4eeeee: A `COTAL_TELEMETRY_URL` that is not an `http` or `https` URL was reported by `cotal telemetry` as where events go, and every send to it failed unseen. It now refuses `USAGE_INVALID`, exit 1, before the command runs whenever the level in force sends events, and `cotal telemetry` refuses it at every level.
- d0d885a: A TLS stack whose certificate names its IP address now starts. Every TLS dial to an IP address checked the certificate against `localhost`, so `cotal up --server tls://127.0.0.1:<port>` with a valid certificate for that address waited out its readiness and failed `OPERATION_UNKNOWN` with no cause, even with the CA trusted. When this client refuses the certificate, `up` now stops at the first handshake, fails `OPERATION_FAILED` (exit 5) with the native error, and names `NODE_EXTRA_CA_CERTS` as the way to trust a self-signed certificate or a local CA. A `nats://` address with such a certificate names the `tls://` address to use instead.
- 92cdc27: `cotal up --tls-cert` now records the stack's address as `tls://` and names it on the receipt's `TLS: serving` line, so every client checks the certificate against that address. An address `up` chooses, the default or the one a stopped folder last ran at, becomes `tls://`, and `--server nats://…` with `--tls-cert` refuses `USAGE_INVALID` before anything starts, naming the `tls://` form. Such a start used to run the broker and then fail its own certificate check against `localhost`.
- 212b4be: The console topology lens now labels each agent with the same `name/role` label as the roster and the
  feed. The sequence and matrix used to print the bare name, and the map dropped a role equal to the
  name and printed brackets in a role as they were.
- 73d6301: On a terminal, a command in a report's command list, and a command a sentence names in backticks
  after other words, from its `cotal` to its closing backtick, now wrap as one word, so a line copied
  from Verdict, Next or a warning is never part of a command. The Next of `space delete` for a prepared space, of
  `persona create` over an existing persona and of a `team boot` on a running stack name their
  commands in backticks. Before, `reset store <long name>
  --dry-run` at 80 columns printed `cotal reset store` on one line and the name on the next.
- 7a09919: The typed-name question of `space delete`, and the message under a wrong answer, now continue under
  clack's bar when they wrap, as the yes-or-no questions do, instead of at column 0.
- 1590fdb: A flag typed with an en dash, an em dash or a minus sign, as autocorrect writes `--`, is now refused as a usage error that names the dash and the flag to type, such as `--yes` for `–yes`. It used to be read as an argument, and the refusal was about something else. After `--`, such a word is still an argument as typed.
- b12b86b: When a registered manager does not answer, as after a crash, `input` and `stop` refuse
  `TARGET_UNAVAILABLE` because nothing was sent, instead of reporting an unconfirmed outcome. That
  refusal, and the one `cotal run`'s hosted verbs give, now leads with "the manager registered for this
  space did not answer".
- 722ebe0: `cotal stop`, `input` and `attach` without `--on`, on a space with several managers, now refuse a
  name no manager runs `TARGET_NOT_FOUND` with exit 2, naming the managers that answered and `cotal ps`
  as Next, as the same miss with `--on` does. `--json` prints the refusal envelope. A search that some
  manager did not answer refuses `TARGET_UNAVAILABLE`. Both used to print one bare line and exit 1.
- 260ff6d: A command given a `--server` nothing answers at, such as `send` or `history`, now says that nothing
  answered at that address, and names the broker recorded for the space when the command runs from
  its root or with `--space`. It used to say the space's mesh was recorded there but not running and
  to run `cotal up`, which answered that the stack was already running, and in a folder with no space
  it named a `main` mesh recorded there that was never recorded. The recorded broker is still never
  dialed in its place.
- 8e35b7c: `cotal status` in a folder this account cannot read now says so, naming the folder and `chmod u+rx` on it, instead of reporting an unreadable `auth.json` that does not exist. A local record that cannot be opened for lack of permission names the folder that withholds it, so `cotal down --dry-run` there no longer says the record "could not be opened without following links".
- 595aa8e: A saved definition of a service you added that is not valid JSON, as an interrupted write can leave
  it, is now named by `service` and its verbs, such as `service show`, `service add` and
  `service stop`. The `SCHEMA_INVALID` refusal gives its path, the `mv` that moves it aside, and
  `cotal service add <name> --space <space> --file <declaration>`, which adds the service again so that an instance
  still running can be stopped. Before, the refusal named no file, so the stop that `down` names for a
  running service could not be followed. A stack member's definition keeps the plain refusal.
- 72ed932: A service instance record left truncated or overwritten made `up`, `down`, `service` and `reset store`
  refuse "local record input is not valid UTF-8 JSON" with no file and no next step, while `status`
  called the space stopped and suggested `cotal up`. Saved local records that are not valid JSON are
  now refused with their path and the `mv` that moves them aside, and are left as they are. For a
  stopped space, `status` warns about the record and gives that step under Next in place of `cotal up`.
- 3f47717: A stack journal left truncated or empty, as an interrupted write or a full disk can leave it, made `up`, `down` and `clean all` refuse "local record input is not valid UTF-8 JSON" with no file and no Next, `reset store` refuse with no path, and `status` report the space as prepared with no warning. Each refusal now names the journal's path and the way out: remove it when no member of the stack runs, after which `cotal up` starts the stack again, or first stop each running member with the `cotal service stop` it names. `status` warns about the journal.
- 9f655c1: `cotal up` on a stack whose broker store folder this account cannot open, such as one at mode 000, crashed with a raw Node EACCES stack trace and wrote nothing to stdout for `--json`, while `status` told the user to run `cotal up`. It now refuses `PERMISSION_DENIED` (exit 2), naming the folder and `chmod -R u+rwX`, which restores the read and search access that `chmod -R u+w` leaves out, and `status` names the same step.
- 1e6a324: `up` of a stack whose `.cotal/auth/server.conf` is a symlink or a folder, or whose trust record this
  account cannot read, no longer exits 3 `OPERATION_UNKNOWN` saying started members were kept while
  nothing started. It refuses `PERMISSION_DENIED` (exit 2) before it starts anything, in text and
  `--json`, carries the cause, and names the path and the step: move the generated configuration
  aside, or make the trust record readable again.
- 6bdc4e5: `cotal up` now checks a channels seed file, from `--channels` or the root's `.cotal/channels.json`, before anything starts. A channel name or value the registry would not take used to start the broker and then end as an unknown outcome with no reason, and a file that was not an object, or had a misspelled key, started with nothing seeded and no warning. Each of these now refuses with `SCHEMA_INVALID`, naming the file and the entry. The seed file format is documented under `cotal up`.
- 821e6a6: Accept `cotal up -d` as the short form of `--detach`, consistent with managed agent spawning.
  Startup still runs in the background by default, and combining `-d` with `--foreground` refuses
  before anything starts.
- 0a94945: `cotal up --dry-run` without `-f` now refuses `USAGE_INVALID` and names `-f <cotal.yaml>` before anything starts or is written. It used to start a real stack, consume the folder's prepared space and register it, and its `--json` form refused with a remedy that pointed at that starting command.
- 672e982: `cotal up -f` refused over an active restore that left history or workflow runs out now names
  `backup cleanup-fallback <attempt> --yes --discard-history` as the step that retires it, and says
  that it deletes the previous store, where it used to name a cleanup that then refused.
- 92ae21e: `cotal up -f` after a restore exited 3, outcome unknown, with "active listener ownership is alive; refusing ordinary startup" while the restored stack ran, and with an instruction to relaunch with bare `cotal up` once it was stopped, though `up -f` boots a fresh mesh and starts only after the restore is retired. It now refuses before anything starts. While the restored broker runs, the refusal is `CONFLICT`, exit 2, naming its PID, with `cotal down`, `cotal backup cleanup-fallback <attempt> --yes` and `cotal up -f <manifest>` as the next steps. Once that stack is stopped, it is `LIFECYCLE_BLOCKED`, exit 2, naming the cleanup.
- 98f32fd: `cotal up -f <manifest> --json` and `--plain` now check the manifest before refusing the flag. A
  manifest that does not validate gets its own `SCHEMA_INVALID` refusal with each problem, and a valid
  one is refused `UNSUPPORTED` with the remedy to omit the flag. Both used to get the controller-route
  remedy, which never applies to `up -f`, and an invalid manifest's error was hidden behind it.
  `define-a-team.md` now says that `cotal down` drops the space's registration.
- bd84d60: `cotal up -f` under a TLS certificate this client does not trust now fails as `cotal up` does:
  `OPERATION_FAILED`, exit 5, naming the native error and the step that sets `NODE_EXTRA_CA_CERTS`.
  It printed the failure alone and exited 1, with no code and no step.
- 3fe1408: `cotal up --foreground` refuses when this folder's stack is already running, naming `cotal down` first. It used to print `already running`, restart a missing manager in the background and exit 0, so a `Type=simple` service unit read the exit as the stack ending and restarted in a loop.
- c939674: `cotal up` on a controller stack and `cotal history` now warn `STORE_DAMAGE_LOGGED` when the space's broker on this machine logged damage in a stored file since it started, quoting the broker's warning. The history read stays complete, because it read the stream as the broker serves it. A broker whose log is not on this machine is not checked. Both used to report nothing while history returned fewer messages.
- c6ca36a: `cotal up` in the home folder, whose `.cotal` holds this machine's own records, now refuses `CONFLICT` and names a project folder, as `space create` does there. A home that already holds a stack an earlier release started there keeps starting it in place, and `up --root <dir>` still starts a prepared project from the home. A `cotal down` in a home with no stack says there is nothing to stop.
- a843156: `cotal up` now answers every `--host` refusal as a `USAGE_INVALID` report, so `--json` gets its envelope instead of a bare error line. A `--server` naming an IPv4 address other than `127.0.0.1` with no `--host` is refused before anything starts, and its next step names the `--host` to add; the broker used to bind `127.0.0.1`, exit 3 and record the address. A stopped stack whose broker bind does not serve its recorded address, as an earlier version could leave behind, now refuses `up` with `CONFLICT` and names `cotal up --host <host>`, which replaces the recorded bind host.
- cc1fb41: A bare `cotal up` whose folder names a space that already runs from another folder
  now names how to start a separate space here: its Next is `cotal up --space <name>` with a name no
  other folder uses, or the `cotal down` that stops the other stack, run in that stack's folder. It
  used to say only "pick a different `--space`, or `cotal down` it first".
- b8b5d3f: `up` no longer says a space was forgotten when it names a saved service that was added in this
  folder. The receipt still lists every saved service it does not start, and names only those a space
  forgotten under the same name left from another folder as inherited, with
  `cotal service remove <name> --space <space> --yes`. `--json` carries them as
  `result.inheritedServices`.
- c78b4be: An `up` killed after it recorded a member's launch and before it recorded the child no longer
  leaves the root refusing every `up` and `down` with no way out. A detached `up` interrupted by
  SIGINT, SIGTERM or SIGHUP in that window records the launch on its way out, as `failed` when no
  child was spawned yet or with the child's process when one was. After a SIGKILL or an out-of-memory
  kill, the refusal names `cotal down --abandon-launch <instance-id> --yes`, which records that member
  `failed` with a `LAUNCH_ABANDONED` warning, since a process the launch started without recording it
  is not excluded, and stops the rest of the stack.
- 09dd488: A command can declare `keepsStartupNotice`. The published CLI then keeps its notice for an interrupt
  before the command begins until the command's own notice takes it over, instead of ending it as the
  command starts. `up` declares it, so an `up` interrupted during its recovery check, before it reaches
  the stack, now says so and exits 130, 143 or 129. It used to exit with no output.
- 69c70ff: When `up` ran under a low open-file limit, the manager could exit before readiness with only "Can't reach NATS … Run: cotal up" in its log, while the broker's log recorded that it ran out of open files, and the next `up` reused that starved broker and failed again. `up` now names the broker's log and that cause when a member other than the broker fails readiness, and says to stop the stack with `cotal down --yes`, raise `ulimit -n`, then run `cotal up`.
- 1d55856: On a legacy root, a bare `cotal up`, or `cotal up --server` with the same address, while a committed restore's broker ran exited 3, outcome unknown, with "a commit-token handoff needs a manager-committed resume or restore, not active", and left the restore journal degraded until another `up` repaired it. It now refuses `CONFLICT`, exit 2, before it touches the journal, naming the broker's PID, with `cotal down`, then `cotal up` as the next step, as `cotal up -f` does.
- 78538c7: `cotal up` on a broker port that nothing listens on, but that a connection's local end still holds,
  such as one in TIME-WAIT after an outbound connection closed, now says so on Linux. It used to say
  another process holds the address and tell you to stop the process listening there. For TIME-WAIT
  its next step is to wait up to a minute and run `cotal up` again, or to pick another address.
- 08a9fe6: After `cotal space delete` removed a space's streams from a controller stack's running broker, `cotal up` refused until `cotal down --yes` restarted the whole stack. A bare `up` there now creates the streams again, empty, on the running broker, the way a broker start does, and starts the other members; its receipt says so, and `--json` sets `result.streamsRecreated`. It does this only when every one of the space's streams is gone. A broker that lost only some of them is left as it is, and `up` still refuses, naming the restart. The delete receipt's Next now names `cotal up` first.
- 7a30e2f: A controller `cotal up` refused before any member started said "started members were kept and nothing was retried", which read as if part of the stack ran. When no member started or was reused, it now says the stack started no member.
- 3e9a00f: `cotal up` now refuses an IPv6 address in `--server` or `--host`, such as `nats://[::1]:4222`, with `USAGE_INVALID` before anything starts. The stack's own clients cannot reach a broker there. With `--server` alone it used to start a broker on 127.0.0.1, report an unconfirmed outcome and leave that broker running. With `--host` it started a broker on the IPv6 address whose delivery daemon or manager then failed.
- 3a0aed9: `up --restore` now names the restore attempt and the `backup cleanup-fallback` step that retires
  it. Its output did not mention the restore, so the attempt id was only in `cotal status`. For a
  registry restore, that step in `up --restore` and in `cotal status` now includes
  `--discard-history`, which the cleanup requires. When `backup cleanup-fallback` refuses a registry
  restore for lacking that flag, it no longer prints the whole `cotal backup` help after the remedy.
- 0eebdbb: `cotal up --root <root>` run from another folder now says in its Next to run `cotal down` from that root, since `down` stops only the stack of the folder it runs in, and offers `cotal up --root <root>` to add the manager. It used to offer a bare `cotal down`, which refuses from the folder you ran `up` in.
- 12bdf0f: `cotal up --json` on a controller root now gives `result.selection`: `current`, the space selected after the start, and `changed`, true when this `up` selected its own space because no space was selected. The docs also say that a space stays selected through its `cotal down`.
- 6b46d92: `up --server` with an IPv6 address, embedded credentials, or a path refused with the example `--server nats://127.0.0.1:4222`, so pasting it moved the stack to port 4222 and dropped `tls://`. The example now keeps the scheme and port given, such as `--server nats://127.0.0.1:29888`.
- 8617731: `cotal up --server` with a host name such as `localhost` is now refused `USAGE_INVALID` in every folder, with an example on `127.0.0.1` and your port. An unprepared folder used to start and record it, while a prepared folder refused it with no next step.
- b99492f: `cotal up --server <url>` now refuses a URL with no port, such as `nats://127.0.0.1`, with `USAGE_INVALID` before anything is started or written, and its next step names the port to add. It used to start the stack on the default port 4222 and record the broker address without a port.
- 5122f54: A `cotal up --server` value that no local broker can serve is now refused as the short classified report, without the command's help, and its example keeps the port you passed instead of 4222.
- 1a7f71c: `cotal up --space <space>` from another folder, while that space runs from its own folder, refuses `CONFLICT` naming that folder with `--json` and `--plain` too, and with no `--server`. Those forms used to refuse `UNSUPPORTED` about the launcher, aimed at the calling folder, and the form with no `--server` left an empty `.cotal/nats` in the calling folder.
- 4abc6bf: `cotal up --space` refuses a name that starts with `-` with `USAGE_INVALID`, exit 1, before anything is started or written. The stack passes its space to its own children as `--space <name>`, so such a name started a broker whose delivery daemon then exited.
- 28da173: `cotal up --space <name>` run from another folder than the one the space is prepared in now names `cotal up --root <root> --space <name>` in its refusal, which starts the space in its own folder from where you are.
- 8d24462: `cotal up` on a stack whose broker process is stopped by a signal now refuses `TARGET_UNAVAILABLE` at once, naming that pid and `kill -CONT <pid>`, before it writes the stack journal. It used to wait about 20 seconds, end `OPERATION_UNKNOWN` without naming the stop, and record the stopped broker's readiness as ready again.
- a7dadf4: When the broker a controller `cotal up` started cannot create the space's streams, `up` now stops that broker again and fails `OPERATION_FAILED` (exit 5), so the next `up` starts a fresh one. The failure names the cause when the broker's log shows it ran out of open files, with raising `ulimit -n` as the next step, and otherwise names that log. It used to exit 3 with no cause and keep the crippled broker, which every later `up` reused and failed on.
- 53d2702: An `up` stopped after its broker started and before it registered the space, as an early Ctrl-C
  does, no longer leaves every next `up` refusing that the space is prepared but not started. The next
  `up` refuses `LIFECYCLE_BLOCKED` before it writes anything, naming the broker's pid and
  `cotal down --yes`, after which `cotal up` starts the stack.
- a323edf: When `up` refuses a space before any member starts, as it does for an earlier release's record whose
  name is not a routing token, it says that no member was started instead of that started members were
  kept, and its next step quotes a space name that holds a space or other shell character.
- ec15906: The `✗` line of a usage refusal now shows control characters as escapes, as the classified report
  already did. A `.cotal/channels.json` or `--channels` file that is not valid JSON is refused with the
  parser's excerpt of the file, and an escape sequence in that excerpt reached the terminal raw, so
  `cotal up` in a cloned project could clear the screen or set the window title. The same applied to an
  argument a refusal repeats, such as an unknown command, docs page, preference key or channel name.
- 32a0c58: `cotal use --clear` removes the space selection, so a command targets its folder's space again. Nothing could clear it before: `use ""`, `use -` and `use none` were refused as unknown spaces, so after the first `up` selected a space, the rule that a folder's space applies when nothing is selected could not be reached again. The receipt names the space that was selected, `--json` reports it, and with nothing selected the command is a no-op.
- 90168db: `use` with a name that is neither registered nor prepared now says so, lists the known spaces as `config --space` does, names `cotal use --clear` only while a space is selected, and is no longer headed with the unknown name.
- 24769e9: A file saved as UTF-16, as Windows PowerShell 5.1 writes by default, is now refused by its encoding,
  with the step to save it as UTF-8. That covers a persona file in the catalog, in `persona show` and in
  `persona create --file`, a team manifest, a `.cotal/channels.json` or `--channels` file, and
  `preferences.json`. Before, each reported a generic invalid definition, schema shape or JSON error,
  with no word about the encoding.
- 22e7127: A refusal of a value that names its own fix no longer prints the command's whole help after it. An
  `--on` that is empty, a principal id or not an instance id, a `spawn --on` that needs a terminal or
  `-d`, `attach` with no name and no terminal, and a `run` command given no run id now print the
  refusal and its next step only. The `run` refusal names `cotal run ps`, or `cotal run turns` for
  `yield`.
- d407e4b: `cotal down` over an empty manager pidfile no longer warns that an older manager may have reaped its managed agents. No manager ran there and nothing was signalled. `verifyIdentityPin` now answers `no-pid` for a pidfile that is absent, empty or holds no pid, where it used to answer `legacy`, the verdict for a live record written before identity pinning. A pidfile it cannot read for any reason other than its absence now throws, naming the file.
- 377b0e0: `watch --plain` marks a message it cuts at the observer stream's 16,384-code-unit row bound: the line ends with the count not shown and the `cotal history` read that shows it whole. The watch docs name the bound.
- b3b6d12: `cotal who` lists live `cotal chat` sessions with the agents, in a Kind column that names each one `chat session`, and its JSON rows carry `sessionKind`. A chat session used to be hidden and counted as an infrastructure endpoint, so two people chatting got "no agents present".
- 0af63ec: `cotal who --creds` with a manager on the roster is now a complete read that labels the managers `MANAGERS_DENIED`. A credential passed with `--creds` carries no caller the managers accept from this command, so they are not asked. It used to exit 4 as a partial read, with a `MANAGERS_UNREAD` warning that blamed the managers.
- b6681bc: `cotal whoami --creds <file>` reports what a credential file may do: the space its permissions
  name, its profile, principal and agent lifecycle, when it was issued and when it expires, the
  channels it may read and post to, and whether it may read every DM, only its own, or none. It
  decodes the file's own claims and contacts no broker. No command showed this before: `whoami` had
  no `--creds`, and `auth handle inspect` refuses a credential file, whose Next now names
  `whoami --creds`.
- fe231cd: `cotal whoami` on a space that is prepared and not started now reports the identity its folder's trust gives it, with `server` and `mode` null and a note to start it with `cotal up`, instead of refusing with `TARGET_UNAVAILABLE`.
- f111104: In a folder whose `.cotal/` names no space, as after `cotal space forget`, `cotal whoami` and `cotal spawn --dry-run` keep exit 0 and the `Mesh: main` heading, and now add a line saying the held default `main` was assumed. Their JSON `target` names the folder as `root` and that space as `assumed`, where it used to name a space `main` that does not exist.
- dd91362: `cotal whoami --server <address>` from a space's own folder now reports an address that space is not registered at as `BROKER_NOT_PROBED`: partial, exit 4, with the identity unknown and a remedy naming `cotal whoami --space <space>`. It used to report full access as complete, because the folder holds the space's signer, while the same command from a folder with no trust was already reported unprobed. `--space <space> --server <address>` is treated the same way.
- 6f40c5a: `cotal whoami --server <url>` for an address no registration here names, with no trust for it in the folder, no longer reports an open broker with read, post and capabilities `all` as a complete run. whoami does not contact the broker, so it cannot know whether the broker authenticates. It now reports identity `unknown` with `mode`, `read`, `post`, `dms` and `capabilities` `null`, and the run is `partial` (exit 4) with a `BROKER_NOT_PROBED` warning and a next step that checks the broker through `cotal space add`. A registered address reports as before.
- 6e18c29: `cotal down`, `cotal history clear`, `cotal channel remove` and `cotal persona remove` name what kept
  them from asking when they refuse for a missing `--yes`: `--json`, `--no-input`, `COTAL_NO_PROMPT=1`
  or no interactive terminal. On a terminal with `--no-input` they used to say confirmation was needed
  outside an interactive terminal.
- Updated dependencies [ff99364]
- Updated dependencies [39e0c7a]
- Updated dependencies [fc17f8f]
- Updated dependencies [e7cb03f]
- Updated dependencies [0d1dfc3]
- Updated dependencies [d0c3cd7]
- Updated dependencies [c74a853]
- Updated dependencies [fff2909]
- Updated dependencies [b0257f2]
- Updated dependencies [0c9e498]
- Updated dependencies [1e75421]
- Updated dependencies [b58bf37]
- Updated dependencies [0af0377]
- Updated dependencies [dedb739]
- Updated dependencies [ea76a77]
- Updated dependencies [9736397]
- Updated dependencies [0282994]
- Updated dependencies [dbbd7f5]
- Updated dependencies [7d489d2]
- Updated dependencies [cfeaddd]
- Updated dependencies [afec9b6]
- Updated dependencies [7c8564e]
- Updated dependencies [66d2f93]
- Updated dependencies [5cc55a7]
- Updated dependencies [3a12438]
- Updated dependencies [c2503db]
- Updated dependencies [60cb005]
- Updated dependencies [54f044f]
- Updated dependencies [f0d97cd]
- Updated dependencies [b8fa243]
- Updated dependencies [09d905f]
- Updated dependencies [286bccd]
- Updated dependencies [4b2eb30]
- Updated dependencies [855e595]
- Updated dependencies [1c978f9]
- Updated dependencies [f0d3143]
- Updated dependencies [5703dfb]
- Updated dependencies [a62d32d]
- Updated dependencies [5f312f7]
- Updated dependencies [057e96d]
- Updated dependencies [41db374]
- Updated dependencies [700695c]
- Updated dependencies [30f0900]
- Updated dependencies [2ed3641]
- Updated dependencies [89d5637]
- Updated dependencies [9aa4be8]
- Updated dependencies [35ec68e]
- Updated dependencies [e5ea994]
- Updated dependencies [0b638b8]
- Updated dependencies [817f353]
- Updated dependencies [b7d985d]
- Updated dependencies [e124c5a]
- Updated dependencies [957b8d8]
- Updated dependencies [77c915a]
- Updated dependencies [2dcc119]
- Updated dependencies [75476c5]
- Updated dependencies [71e91d8]
- Updated dependencies [5521d3f]
- Updated dependencies [d4afe89]
- Updated dependencies [b6cfff1]
- Updated dependencies [332d20e]
- Updated dependencies [9901303]
- Updated dependencies [b8304ce]
- Updated dependencies [e264d3c]
- Updated dependencies [af0a0bc]
- Updated dependencies [71eeb1c]
- Updated dependencies [608f2d0]
- Updated dependencies [00db0a6]
- Updated dependencies [0decd7a]
- Updated dependencies [240dbf4]
- Updated dependencies [1de8abb]
- Updated dependencies [2343ae8]
- Updated dependencies [0c7e317]
- Updated dependencies [62c4874]
- Updated dependencies [b3f0edd]
- Updated dependencies [b8ef19b]
- Updated dependencies [788bf15]
- Updated dependencies [2093a48]
- Updated dependencies [7b97877]
- Updated dependencies [2f7657c]
- Updated dependencies [9323110]
- Updated dependencies [101e4f1]
- Updated dependencies [70e9a65]
- Updated dependencies [ea1b582]
- Updated dependencies [998477a]
- Updated dependencies [062cdfd]
- Updated dependencies [e3979fe]
- Updated dependencies [b5017a7]
- Updated dependencies [b1397f4]
- Updated dependencies [3a3d489]
- Updated dependencies [4f1ade7]
- Updated dependencies [d38a3e0]
- Updated dependencies [66af07b]
- Updated dependencies [b77865a]
- Updated dependencies [8c019ae]
- Updated dependencies [985f634]
- Updated dependencies [2f4f747]
- Updated dependencies [0abbc55]
- Updated dependencies [5e02acd]
- Updated dependencies [3fc0d8e]
- Updated dependencies [4725a7f]
- Updated dependencies [4dcdc62]
- Updated dependencies [d5e1e1f]
- Updated dependencies [e5ddaed]
- Updated dependencies [b3426bb]
- Updated dependencies [cc023f7]
- Updated dependencies [789de43]
- Updated dependencies [7e56bcd]
- Updated dependencies [d12f4bc]
- Updated dependencies [6a9b881]
- Updated dependencies [4d577e6]
- Updated dependencies [df1abff]
- Updated dependencies [eabc54d]
- Updated dependencies [d7bb55f]
- Updated dependencies [8704be1]
- Updated dependencies [440ce81]
- Updated dependencies [aa3ff60]
- Updated dependencies [9c86a40]
- Updated dependencies [f2e0c06]
- Updated dependencies [73930b2]
- Updated dependencies [c63f6d8]
- Updated dependencies [6682bcb]
- Updated dependencies [d205ad2]
- Updated dependencies [7aa9d14]
- Updated dependencies [531b374]
- Updated dependencies [88c64a0]
- Updated dependencies [48431ca]
- Updated dependencies [83c2b1b]
- Updated dependencies [aef1cf1]
- Updated dependencies [26f407a]
- Updated dependencies [ff650ba]
- Updated dependencies [a8c3461]
- Updated dependencies [a923eaa]
- Updated dependencies [b505ad6]
- Updated dependencies [457d771]
- Updated dependencies [e16a6a5]
- Updated dependencies [d6f9f7a]
- Updated dependencies [03858ae]
- Updated dependencies [d0d885a]
- Updated dependencies [73d6301]
- Updated dependencies [447b7eb]
- Updated dependencies [bd52202]
- Updated dependencies [260ff6d]
- Updated dependencies [8e35b7c]
- Updated dependencies [5cb1819]
- Updated dependencies [595aa8e]
- Updated dependencies [72ed932]
- Updated dependencies [09dd488]
- Updated dependencies [d74686f]
- Updated dependencies [24769e9]
- Updated dependencies [d407e4b]
- Updated dependencies [89f14f2]
- Updated dependencies [914b1f1]
- Updated dependencies [b6681bc]
- Updated dependencies [78a2035]
  - @cotal-ai/workspace@0.101.0
  - @cotal-ai/core@0.101.0

## 0.100.2

### Patch Changes

- 7c055cf: `cotal config set persona <name>` now warns `PERSONA_NOT_FOUND`, naming the catalog, when the catalog of the space a command there uses does not hold that persona or file. The value is still saved, since the file may be created later. A name that breaks the persona name rule is still refused.
- 8d81c12: `cotal persona create --on <manager>` on a static space no longer records the CLI's one-call caller as the persona's owner, which no later call could match, so the receipt's own `persona show --on` Next was refused. On a static space the manager now records an owner only for one of its own seats, and any other caller defines an operator-owned file, as a local `persona create` writes it. A peer joined with its own credentials is such a caller too. When the manager writes the file into this root's catalog, the receipt's `Local files` line names it instead of saying `unchanged`, and JSON `localFilesChanged` is true. For a one-call caller the Next offers `cotal p show <name>`, and a `persona show --on` that is answered not-found names that command when this root holds the file.
- 713a9a9: `cotal backup restore` of an artifact whose file is missing, undeclared or not its declared size and SHA-256 now refuses `SCHEMA_INVALID` (exit 1) and names the file and the fault, as `cotal backup verify` does for the same check. It exited 3 `OPERATION_UNKNOWN` with a Next about the maintenance journal, though the check runs before any transition and the preserved cut is not changed.
- 48240a5: `cotal backup restore` of a full artifact taken under another trust state, such as another machine's or a reset root's, now refuses `CONFLICT` (exit 2) and says the artifact restores only into a root that still holds the trust state it was taken under. It exited 3 `OPERATION_UNKNOWN` with a misleading Next, though nothing had changed. `cotal backup create`, `inspect` and `verify` now show a `Restores into` row for such an artifact, and their JSON carries `trustBound`.
- bb4145f: `cotal telemetry <level>` now reports `ok` when the run creates the settings file, even at the default level. With no `telemetry.json`, `cotal telemetry regular` or `on`, also under `COTAL_TELEMETRY=minimal`, created the file and reported a `no-op`.
- Updated dependencies [8d81c12]
- Updated dependencies [bb4145f]
  - @cotal-ai/core@0.100.2
  - @cotal-ai/workspace@0.100.2

## 0.100.1

### Patch Changes

- 8bb8900: Concurrent `cotal channel set` writes on different fields of one channel no longer drop one of them. A channel registry write now lands on the revision it read, and a write that loses the race to another writer reads the entry again and merges again, so each confirmed field stays saved. A write that keeps losing refuses with `CONFLICT` and saves nothing, where before each writer printed `Channel saved` even when another writer overwrote its field. `channel defaults` and the runtime's channel writes use the same path.
- 4bce73e: `cotal up` in a project whose `.cotal` this account cannot write, and `cotal persona edit` with a
  `TMPDIR` that is missing, not a folder or not writable, now refuse with exit 2 and name the folder
  and a next step, before anything is started or written. They used to end `OPERATION_UNKNOWN` (exit 3)
  with a raw `EACCES` or `ENOENT` and the name of an internal file.
- Updated dependencies [8bb8900]
- Updated dependencies [546b661]
- Updated dependencies [b1d2cb5]
  - @cotal-ai/core@0.100.1
  - @cotal-ai/workspace@0.100.1

## 0.100.0

### Patch Changes

- 7e62dcf: A declared adapter path that other local writers could change is refused with every unsafe entry
  at once, the reason group write is not accepted, and the one `chmod` that fixes them. Before, the
  refusal named only the shallowest directory, with no reason and a Next that pointed at
  `cotal service`. An install made by `npm i -g` under umask 0002 left the bundled `nats-server` and
  each of its directories group-writable, so a controller `up` refused one directory per attempt.
- 4e6bc19: A `backup create` that recovers an interrupted create's claim first now backs up the cut's recorded
  store. On a root whose store is a custom `--store-dir`, it looked for `.cotal/nats` instead, removed
  the partial artifact and then failed with an unknown outcome, "store path is missing".
- 8c4894e: `backup create` without `--store-dir` now backs up the preserved cut's recorded source store. It used
  `.cotal/nats`, so after a restore into another store it refused `path-missing` although the cut was
  ready.
- 776eb6c: A `backup create` refusal or failure now shows its cause as native detail, such as a broker still
  listening at the preserved cut's endpoint. Since the command line redesign it printed only a generic
  sentence, while `backup restore` and `down --preserve-state` kept naming the same cause.
- 769c5d2: `cotal channel members` on an open mesh now refuses with `UNSUPPORTED`, exit 2, and says why: the delivery service writes the membership feed, and an open mesh runs none. It used to report an unestablished census, exit 4, and tell you to check a delivery service the mesh does not run. The remedy names `cotal who` for who is present.
- a78af23: `cotal channel remove` no longer says a channel was removed when it had no saved entry, such as a mistyped name or one already removed. That run is now a `no-op`: the receipt reads `Nothing removed` with `Metadata: no saved entry`, and `result.removed` is `false`. With `--purge`, the channel's retained messages are still purged and the receipt says so. `deleteChannels` now returns the channels it removed, and `clearChannel` says whether it removed the channel's entry.
- 762a9eb: `cotal channel` and its subcommands now report a target they cannot use, such as a space that is prepared but not started, the way `ps`, `who` and `history` do: a refusal under its own code, such as `TARGET_UNAVAILABLE`, in one JSON envelope with `--json`, exit 2, and the remedy under Next. They printed one line and exited 1, the usage exit, with no JSON.
- da15900: `/help` in `chat` lists the slash commands. It used to be refused as an unknown command.
- 1089733: `/leave` of a channel the chat session never joined now answers `not on #<channel>`. It used to say
  `still on #<channel>`, as if the session were reading that channel.
- 6c415a0: `/history` in `chat` works on an open mesh. It reads the channel the way `cotal history` does,
  because an open mesh runs no delivery daemon. It used to fail with "no responders" and a raw
  delivery subject.
- e026868: `/quit` in `chat --plain`'s numbered recipient list leaves the session. It used to print the list
  again, so only the end of input left.
- 53f688c: In `cotal chat --plain`, `:to <target>` now sets the recipient. `:to eve` or `:to @eve` became a draft to the current channel, and answering `y` would have posted that text. `:to @eve`, `:to #<channel>`, `:to @<owner>.<actor>` and `:to role:<role>` now choose that recipient, and a target in another form, such as a bare name, names the forms it accepts and opens the numbered list. The docs now describe `:to`, `:multi` and the other line commands.
- 5b73632: `/reconnect` in `chat` reports the outage it causes once. It used to print the gap line twice.
- 117a998: `chat` now shows when a static or signed-in session ends: the banner gives the time, and a notice a
  minute before says the session is ending. In `--plain`, `/quit` leaves a session that has already
  ended. It used to be answered with "end input (Ctrl-D) to leave".
- 4b8ac08: A static `chat` session can `/join` a channel again after `/leave`. Leaving used to empty the
  session's read list, so `/join` refused with a message saying the session was opened on no channel.
- bd17d7e: `cotal chat --stdio` now answers every line in the order it arrived, as the docs say. A request refused at validation, such as an unknown `type`, a line that is not JSON or one too long to read, was answered at once, ahead of the requests queued before it. A request reusing the id of one still queued was refused under that id before the first request's result, so a client matching by id read the first request as refused. Each refusal now waits its turn, so the first request's result comes before the duplicate's refusal, and the refusal says the id was still in flight when the request arrived.
- 9eed6bc: Output is no longer colored on a terminal whose `TERM` is `dumb`, unless `FORCE_COLOR` asks for it,
  and `FORCE_COLOR` set to `false` in any letter case, such as `FALSE`, now turns color off as `false`
  does.
- ec3e499: `cotal completion install` with a symlinked startup file, such as a `~/.bashrc` that stow links into a dotfiles folder, now names the file, says it is a symlink and gives the line to add to the file it points to. It used to refuse with "could not be opened safely" and no path or next step. Bare `cotal completion` also warns that the file is a symlink.
- a464a24: `cotal completion install` and `uninstall` now name the directory they refuse and why. The refusal said only that completion paths "cross a symlink, untrusted owner or writable ancestor", with no path and no next step. It now names the directory and whether it is a symlink, not a directory, owned by another user, or writable by group or others. For a writable one, Next gives `chmod go-w <path>`. Otherwise Next says to wire completion yourself from `cotal completion script <shell>`.
- 9cbcf51: `cotal completion install` with a group-writable `~/.bashrc` or `~/.zshrc`, as a umask of 0002 leaves
  one, now names the file, its mode and the `chmod go-w` that fixes it. It used to refuse with "shell
  integration needs an owned, bounded regular file" and no path or next step. One refusal names every
  unsafe startup file, stub and folder on the way to them, and nothing is created before it.
- c8b8f7e: `cotal config set persona` now refuses a value that can name neither a persona nor a persona file. It saved anything that was not empty, such as `"  spaced  "` or a name holding a terminal escape. A name must use letters, digits, `_` and `-`, as `persona create` requires, and a path must hold no control characters or surrounding spaces. Whether the persona exists is still checked when a launch uses it. The `no harness` refusals of `config set harness` and `setup --harness` now escape the value as the other keys do, so a control character in it no longer reaches the terminal.
- f615bbb: `cotal console --plain` and `cotal chat --plain` now write their lines in ASCII, as every plain report does: no status marks, and `·`, `…` and `→` as `-`, `...` and `->`. They drew the marks and punctuation under any locale. The console line stream that a pipe gets does the same under a locale that is not UTF-8, as `LC_ALL`, then `LC_CTYPE`, then `LANG` decide.
- 4964459: `cotal console` now shows a control character in a peer's message body, name or other text as its `\uXXXX` escape, in both `--plain` and the TUI, as `history` and `watch --plain` already did. `console --plain` wrote a body to the terminal as it arrived, so a message could clear the screen, set the terminal title, plant an OSC 8 hyperlink, ring the bell or overwrite its own line with a carriage return. The TUI passed the title and hyperlink sequences through too. The TUI still shows a body's line breaks.
- 532ba71: A controller-stack `up` now says when another space stays selected, with the same line a legacy `up`
  prints: `"<space>" up; current is still "<selected>" - cotal use <space> to switch`.
- 02ad0fb: A copied or moved controller project folder no longer gets an "unsupported shape" refusal. The stack journal records the absolute folder it was written in, and in a `cp -a` copy or a renamed folder it named the old path, so `up` (and every other command that reads the journal) refused `SCHEMA_INVALID` with a literal `<root>` in its Next. A well-formed journal that names another folder now refuses `CONFLICT` (exit 2) and names that folder: a copy is told to use the stack from the original, and a moved folder to move back there first. A malformed journal still refuses `SCHEMA_INVALID`, and its Next now names the journal's real path. `space create` in a copy whose records name another root as their space's root says that the records were copied or moved from there, rather than calling the copy that space's root while `status` names the original.
- f5424e1: `--creds` reads and checks its file before dialing. A missing, empty or malformed file (CRLF line
  endings, a truncated JWT, no seed block) and a directory are refused naming the file and the cause,
  instead of reporting a serving broker as unreachable or dumping the command's help. A file other
  accounts can read is still used, with a warning that names `chmod 600`.
- a4e37f4: `COTAL_DEBUG=1` now prints a stack trace for a command that fails with a reported error, such as a failed `ep describe`, as docs/config.md says. It prints the failure's stack and then the stack of each error that caused it, so an endpoint call's underlying error, for example `no describe reply ... within 10000ms`, is visible. It used to print nothing for these failures. The JSON envelope is unchanged.
- cd60efb: `status` no longer suggests the deprecated `cotal deliver` when the delivery responder is not bound;
  it names `cotal up`. The delivery daemon's missing-credential error named `cotal go`, which does not
  exist, and now says that `cotal up` mints and writes the credential.
- 72c4595: `backup cleanup-fallback` now retires the journal of a restore made with `--accept-missing-source`.
  That restore replaced a missing source and keeps no old store, so cleanup refused with an unknown
  outcome, every other recovery route refused too, and the root could never start another backup
  cycle. Its plan, prompt and receipt now say that nothing is removed, and `clean restore-fallback`
  does the same.
- 918d0e5: `cotal doctor auth` names a credential file that other accounts can open by its mode, with `chmod 600` on the file as the repair, instead of reporting a parse failure. It also parses each file the way `--creds` does, so a file the NATS client cannot parse, such as one with Windows (CRLF) line endings, is a finding rather than healthy.
- fb51349: `cotal down` now runs to its end when the reader of its output goes away, as `cotal down --yes | head -1` does. It used to exit 0 at its next write, partway through a member's stop, and the next `down` or `up` refused `LIFECYCLE_BLOCKED` because that stop was never confirmed.
- 869d26f: A controller stack no longer stays blocked after a `cotal down` exits partway through a member's stop, for example because it was killed or its terminal closed. A manager stop that the dead `down` had not yet handed to the manager is settled by the next bare `up` or `down`, and the stop reservation that `down` left is released once its pid has exited. A reservation held by a live process is refused with that pid named. A broker or delivery daemon that the dead `down` left `stopping` is named in the refusal with `cotal down --abandon-stop <request-id> --yes`, which now takes that stop once the process is gone. Before, every `up`, `down`, `--abandon-stop` and `service stop` refused.
- 2c21df1: `cotal down` of a controller stack keeps a selection that names its space. The stopped space stays prepared at its root, so the next command run without `--space` refuses with `TARGET_UNAVAILABLE` and names the root to start it in, as the docs describe. It used to clear the selection, so that command quietly ran against another running space.
- 3bb7510: `cotal down` run in a folder that holds no stack, while `--space` or the selected space names a controller stack rooted in another folder, now refuses with `TARGET_NOT_FOUND` and names that space and its root, with a next step that runs the same `down` from there. It used to blame `--yes` or `--space`, or say there was no stack, and point at a `down` that stopped nothing.
- 83f8e0a: A bare `cotal down --space <name>` or `cotal down --dry-run --space <name>` run outside the folder where that space's stack is recorded now refuses the same way for both, `TARGET_NOT_FOUND` (exit 2), naming that folder and the stop or preview to run there. The stop used to exit 1 with a usage error and the whole help, and neither named the folder.
- 31d6f87: A repeated `cotal down --with-agents --yes` now reports that the stack is not running and exits 0 when the stack's last completed `down` already took `--with-agents`, and so does `--with-agents` on a root that never started a stack. It used to refuse with `LIFECYCLE_BLOCKED` and ask to start the stack first. After a `down` without `--with-agents` it still refuses, because agents that run outside the manager may remain.
- b77a47a: `cotal down --yes` now works on every root. On a root without a controller stack, such as a prepared space that never started or a stack `up -f` started, it gives the same answer as `cotal down`: it stops the running stack, or reports that the stack is not running. It used to refuse with `UNSUPPORTED` because `--yes` applied only to a controller stack.
- f2367fb: `auth mint --endpoint`, `ep describe` and `ep invoke` now say when no instance of the endpoint
  answered its contract read: they refuse with `TARGET_UNAVAILABLE`, exit 2, and their Next says to
  start the service that serves it. They used to fail with "the endpoint contract read did not
  complete", exit 5, and no Next.
- f55ff3a: `cotal endpoints` now shows each participant's name and role in separate columns, as `cotal who` does. The Participant column held `<name>/<role>`, such as `manager/manager`, and following the Next line with that value, `cotal endpoint describe manager/manager`, was refused. The Participant column now holds the name `endpoint describe` takes. The `--json` rows are unchanged.
- c8550cc: `config`, `config get` and `status` now warn with `PREFERENCE_INVALID` when a variable such as
  `COTAL_DETACH_KEY`, `COTAL_DEFAULT_AGENT` or `COTAL_DEFAULT_PERSONA` holds a value `config set`
  refuses, naming the variable and the reason. The variable still wins.
- ba23d00: `cotal ext remove` creates a missing process-record folder under a mesh root's `.cotal` with mode
  0700. Under a group-writable umask, the reservation it takes for a provider whose records sit in a
  folder of their own left that folder 0775.
- 4a2a2fc: A first `cotal up` that launched nothing no longer wedges its folder. When another NATS broker already answered at the address, the refused `up` left a stack journal that every later command treated as a stack that once ran: `up`, `up --server <other>`, `reset space` and `down --yes` all refused `LIFECYCLE_BLOCKED`. A journal whose members never launched now pins nothing. The next `up` plans a first start, at the same address once it is free or at another `--server`, and `down` reports that nothing runs there and exits 0. `reset space` and `reset store` refuse `TARGET_NOT_FOUND` and name `cotal up`, because no broker wrote a store.
- 4c07737: A foreground `cotal team boot` that another command's `cotal down` releases now exits 0, as a foreground `cotal up` does. It used to keep the exit code 4 of its partial start receipt, so a script waiting on it read a normal stop as a failure.
- 9466591: Ctrl-C or SIGTERM on a foreground `cotal up` while the controller stack is still starting now stops
  what was started. The start settles first, then the same guarded whole-stack stop as bare
  `cotal down` runs, and the command exits 130 or 143. Before, the interrupt ended the command at
  once with no output and left the broker, delivery and manager running.
- cff6115: `space forget` now removes the stopped stack definitions `cotal up` saved for the space at its root, so another folder can start a stack under the same name. When a member was not stopped cleanly, the definitions are kept and the result warns with `STACK_DEFINITIONS_KEPT`, naming the route that releases them. A bare `up` that meets another folder's stack definitions names that folder and every definition saved for it.
- d235fb0: After `space forget` on a stopped controller stack, `status` and every command in that root now say
  to prepare the space again with `cotal space create <space> --root <root>` before `cotal up`. Before,
  they said to run `cotal up`, which refuses there until the space is prepared again.
- 0e729b5: A broker that accepts the connection and never answers, as a stopped or overloaded one does, is no longer reported as not running, and `status` no longer hangs on it. `ps`, `who`, `send` and `history` refused such a broker with "no mesh running at <url>; ... recorded at <root> but not running". They now say it "accepted the connection but is not answering", keep the registry entry, and name checking that the broker is not stopped or overloaded. `cotal meshes add` and a raw `--server` connect use the same wording. `status` printed its report and then never exited, because its manager service probe dialed the broker without first reading its greeting and the client library left that socket open. `status` and `status --components` now read the greeting first, report the manager service as unchecked or refused, and exit.
- d224f3a: A controller `up` whose broker address another broker already answers now says where to go next. The refusal said only "something already answers at the stack's broker address", without the address, and its next step was to inspect the stack's members. It now names the address and any space this machine registered there. For a first start, the next step is `cotal up --server` at another port, or stopping that space and running `cotal up` again. A stack that ran keeps its recorded address, so the next step is stopping that space, then a bare `cotal up`.
- 5d89494: Bare `cotal` now offers `cotal up` first for a prepared space that has not started. Before, it offered
  `cotal spawn` for a selected prepared space, which refuses until the space runs. With nothing
  selected, it also names the space prepared in the current folder, including right after `down`
  there, rather than saying no space is selected and offering `cotal setup`. With no agent application,
  `status` Next no longer says setup prepares a space when one is running or prepared, and on a
  running space it still lists `ps` and `use`.
- 28f3ca0: A `backup create` stopped by Ctrl-C now says what it left and how to clear it, and the claim it leaves no longer locks the cut for 30 minutes. Interrupted after it claims the cut, it exits 130 (143 for SIGTERM, 129 for SIGHUP) and prints its attempt id, the partial artifact and `cotal backup recover <attempt> --yes`. `backup recover` now takes a create's `backup-<uuid>` as well as a restore's id. Once the backup process and the broker it started are proven gone, which takes seconds, it removes the partial artifact, the clone and the broker files, each matched by inode, and returns the cut to ready. A create to another directory does the same first. While the claim is live, `up`, another create and `backup recover` refuse `LIFECYCLE_BLOCKED` (exit 2) and name the backup process and the deadline, where `up` used to say "follow the recorded recovery" without naming one and a new create exited 3. `cotal status` shows the create's own attempt and its next step. A create naming the partial artifact refuses `CONFLICT` and names the recovery, and `backup verify` or `backup inspect` on a directory with no `manifest.json` calls it an incomplete artifact.
- 73cd25b: A `backup restore` (or `up --restore`) stopped by Ctrl-C no longer locks its root for 30 minutes without saying so. Interrupted inside its pre-commit window, it now exits 130 (143 for SIGTERM, 129 for SIGHUP) and prints its attempt id and `cotal backup recover <attempt> --yes`. The claim it leaves is stale as soon as its restore process and every broker it started are proven gone on this host, which takes seconds because each broker's watchdog stops it when the restore process exits. So that recovery, `clean restore-attempt`, or a rerun of the restore rolls it back at once. The 30-minute deadline still applies when a broker cannot be proven gone. While the claim is live, `up`, a repeated restore and `backup recover` refuse `LIFECYCLE_BLOCKED` (exit 2) and name the restore process and the deadline, rather than exiting 3 with an unknown outcome. A restore or recovery that finds the root's maintenance lock held names the pid holding it. The status and receipt hints now say `--yes`, which the apply needs, and `status` no longer offers `clean store --force` while a maintenance journal holds the store.
- 3f4c6ae: `join --creds` or `--token` and `feedback-intake --creds` with no `--server` now dial the broker the
  space is registered at, keeping its TLS requirement, and refuse an unregistered space before any
  dial. Before, they sent the credential to the default address.
- 2f64d94: On a running legacy root, the `reset store` and `reset space` verdicts now name `cotal down` and then
  `cotal clean store --force` or `cotal clean all --force` from that root. Before, they named the reset
  again after `down`, which refuses because a legacy `down` drops the registration a reset selects.
- b926b5c: A bare `cotal up` on a stopped legacy root now starts it at the address its last start used, and in
  open mode when that start was open, and says so. Before, a legacy `down` dropped the registration
  that kept the address, so the next bare `up` started on 127.0.0.1:4222 in static auth. After
  `clean all` on a root deployed with `up -f`, a bare `up` that would start another address, mode or
  space refuses and names `cotal up -f <manifest>`.
- cdceff6: Under a locale whose character set is not UTF-8, such as `LANG=C`, `POSIX` or ISO-8859-1, reports,
  refusals and usage errors now write their marks and punctuation in ASCII, as `--plain` does, and
  keep their color. With no locale variable set, the marks stay UTF-8.
- 773e6d3: A managed verb such as `cotal ps`, `stop`, `attach` or `spawn` that cannot choose between several of your live managers now shows the choice. It used to refuse with only the instance ids inside one sentence. It now lists each manager on its own row with its instance id, host, activity (which names its runtime) and the time its process started, and its Next gives your own command again with `--on <instanceId>` for each one. The code and the exit code stay as they were, and `--json` carries the rows under `error.cause.detail.managers`.
- 42d9ea1: `cotal auth mint --expires-at` refuses a time that is not in the future, before anything is written. It used to write a credential the broker already refused, under a label that was then taken, and `doctor auth` reported it as expired.
- 1950421: A legacy project folder that was renamed or moved after `up -f` no longer leaves a stack that no `down` stops. The launch summary that `up -f` writes records its absolute folder, and after a move it named the old path, so it was counted as an unreadable record. `status` then exited 4, `team show <id>` refused `SCHEMA_INVALID`, and bare `down` refused `LIFECYCLE_BLOCKED` while the broker kept running. A summary that reads cleanly but names another folder is now listed by `status` with the folder it was recorded at, blocks no `up` or `down` in the new folder, and `team show <id>` refuses it with `CONFLICT`, naming that folder. A summary that does not parse is still reported unreadable and still blocks. A copy of a running folder still refuses `down`, so the original keeps running.
- 8500c51: A bare `cotal up` in a prepared project folder that was moved no longer starts the legacy launcher under the default "main" space. A prepared space records its folder by path, so after the move nothing in the folder names it, and `up` fell back to the default. When the selected space is prepared in a folder that no longer exists and the current folder names no space, `up` now refuses `TARGET_UNAVAILABLE` (exit 2) with nothing written, and says to forget the space and prepare it again in its new folder, or to pass `--space` to start another space there. `space create <name>` for a space whose recorded folder no longer exists now says so and says to forget it first, rather than "start it with `cotal up` there".
- 51170cb: A project folder moved after `down --preserve-state` no longer blocks resume and restore with an unknown outcome and no path. The maintenance journal records the preserved store by absolute path. When that path is gone and the folder's own `.cotal/nats` is the same store by device, inode and generation, `up`, `backup create` and `backup restore` (with or without `--accept-missing-source`) now refuse `CONFLICT` (exit 2), naming the folder it was moved from, and say to move it back there first. `status` gives the same next step instead of "resume with bare cotal up". A store that is missing from its recorded path is refused `TARGET_NOT_FOUND` with that path, rather than exiting 3, and `backup restore --accept-missing-source` still restores over a lost store. Previously `up` exited 3 with "store path is missing", restore exited 3 with "preserved source is missing", the flag gave "store path must be absent", and `backup create` blamed a `--store-dir` that was never passed.
- 8360fbf: With the space's manager stopped, `cotal run` and its hosted verbs and `cotal models` refuse at once, as `cotal ps` does: `TARGET_UNAVAILABLE` (exit 2) with the Mesh header, the registry's own answer as the native detail, and bare `cotal up` as the next step. They used to wait about 10 seconds for a manager answer that could not come and then print a refusal about the `ep.v1` rail with no code or next step. An unpinned operator call reads the service registry first and refuses only when it lists no live manager; an unreadable registry, a pinned call and a user's manager view go to the manager as before. Core marks the registry's empty answer with a new `ai.cotal.ep.no-live-instances` detail, so a caller can tell it from an unreadable registry.
- f0aebea: Create a missing persona catalog `.cotal/agents` with mode 0700 from every writer. Under a
  group-writable umask, `space create`, `up` and `setup` made it 0775 while seeding the default
  persona, so until the first `persona create` tightened it, a group member could replace
  `default.md`. The setup log's `.cotal` is created 0700 the same way. An existing directory keeps
  its mode.
- 047b289: A persona file with CRLF line endings or a UTF-8 BOM now reads like the same file with LF endings, so `persona create --file`, `persona list`, `persona show`, `persona edit` and launches accept it. `persona create --file` now names the file it read when it refuses a definition, not the catalog path it would have written.
- 944be3c: `cotal persona edit` keeps your edited draft when it refuses with `CONFLICT` because the persona changed or was removed while the editor was open. It deleted the draft, so the edit was lost. The refusal now names the draft and how to use it, and a persona file that is gone is reported as removed.
- f9c0ae6: `cotal persona edit` with an editor the shell cannot find or run now refuses with `DEPENDENCY_UNAVAILABLE`, exit 2, as it does when no editor is set. It failed with `OPERATION_FAILED`, exit 5, and "editor exited with status 127", with no next step. The refusal names the editor and says to set `VISUAL` or `EDITOR` to an installed editor or run `cotal config set editor vim`. It also notes that the value runs as a shell command, so a path that holds spaces needs quotes. An editor that runs and exits non-zero still fails as before.
- 346bb62: `persona create <name> --file <path>` with a file that names another persona now says which name the
  file has and points to `cotal persona create <file's name> --file <path>`. Before, it said only that the
  name must match the catalog name.
- 63aa48a: `cotal persona create --harness <name>` refuses a harness this machine does not know, with `USAGE_INVALID` and the list of known harnesses, the same check `cotal config set harness` makes. It used to save the pin as given, so a typo surfaced only when the persona was spawned.
- e47a4ab: A refused persona name now says which rule it broke. A name over 128 characters said only `invalid persona name`; it now gives the limit and the name's length, and the character rule names the limit too.
- 9b21dcc: `cotal persona` with no space selected, outside a project, now says that no space is selected and this folder is not a space's project. It said `no mesh running`, though the catalog is read offline and needs no running mesh. Commands that read the same catalog, such as `cotal team`, give the same message.
- 96cc9c8: `cotal persona create`, `edit` and `remove`, and the legacy `personas new`, `edit` and `rm`, refuse a persona catalog folder you made read-only, such as `.cotal/agents` set to mode 0500, with `PERMISSION_DENIED`, and leave the folder and its files as they were. They used to set the folder back to 0700 and write into it without a word. `edit` refuses before the editor opens.
- 152e236: `cotal persona --server <address>` with an address that no registered space uses no longer turns the current folder into a catalog. Outside a project it listed an empty catalog for a space named `main`, and `persona create` wrote `.cotal/agents/<name>.md` into whatever folder you were in. It now refuses with `TARGET_NOT_FOUND` and writes nothing. In a project it still reads that folder's catalog, as launch does. `@cotal-ai/workspace` exports `isGenuineSpace` for this check.
- 5242839: `cotal personas list` prints the YAML diagnostic of an unparseable persona as lines: the reason, then the excerpt with a caret under the fault. It printed them on one line, with each line break shown as `\u000a`.
- 7359625: `personas list` and `personas list -v` now escape control characters in the persona names, roles,
  models, descriptions and bodies they print, as `persona show` does. `persona create` and
  `personas new` refuse a `--role` or `--model` that holds control characters.
- 1fb2b06: `personas show` on a terminal now escapes control characters in the persona file, as `persona show`
  does. Piped or redirected, it still writes the file byte for byte.
- 49d88b5: `cotal help personas <subcommand>` and `cotal personas <subcommand> --help` print that subcommand's usage for `list`, `show`, `edit`, `new` and `rm`. `help personas new` and `help personas list` said the subcommand did not exist, although `personas` runs them.
- afb587c: `config set` and `config unset` in a preferences folder you cannot write are now refused with
  `PERMISSION_DENIED`, exit 2, naming the folder and how to make it writable. Before, they reported
  a raw `EACCES` as an unknown outcome, exit 3, although nothing had changed.
- b9ddce8: A selected prepared space whose project folder was deleted now says the folder no longer exists and
  names `cotal space forget <space>`. Before, `use`, `status`, `ps` and `up --space` said to start it
  with `cotal up` in the missing folder, `persona` refused with no path or remedy, and `space forget`
  said the files under that folder were kept.
- f89fb86: `down --preserve-state` now cuts the store the mesh record names, such as a
  `backup restore --store-dir` target. It used `.cotal/nats` unless `--store-dir` was passed, so after
  a restore into another store it stopped the delivery daemon, left a mismatched prepare intent and the
  manager fenced, and exited with an unknown outcome. A `--store-dir` that differs from the recorded
  store now refuses `CONFLICT` before anything stops.
- b24190d: Observers and chat sessions no longer hang silently after a broker outage the client could not ride out. `watch --plain` and `console --plain` now resume when the broker comes back, as `history --follow` already did: the endpoint re-subscribes their feed on every reconnect, where before it subscribed once and stayed silent while reporting itself connected. A `chat --stdio` or `--plain` session whose inbox is gone from the broker after the outage, as when `cotal up` restarted the space and retired it, no longer reports reconnecting forever. It ends by itself with that reason, its `--stdio` end record and `close` carry it, and it exits 5. An endpoint stopped from its own warning listener also exits promptly instead of waiting out the reconnect backoff.
- e0d1edf: A re-entry `up` that adopts the surviving listener of an interrupted restore or resume now
  recreates the space's memory-only buckets before the daemons start. When the first `up` stopped
  after binding its listener and before it made them, the delivery daemon exited with "stream not
  found" and the re-entry reported a degraded control plane.
- fe0bad6: `space add` and `meshes add` against a broker that requires auth, with a `--root` that holds another
  space's trust, now say that the folder holds the trust for that space and refuse with
  `DEPENDENCY_UNAVAILABLE`. Before, they said to copy the mesh's credentials there and re-run with
  `--mode auth`. The note on what such a copy carries is now part of the same line, so `space add` no
  longer prints a literal `\u000a` in its message.
- 393e0a0: A command run from a folder that no longer exists is refused with `USAGE_INVALID`, exit 1, before
  it does anything, and says to `cd` to an existing folder. `status` and other commands used to
  report an unknown outcome, exit 3, with Node's raw `uv_cwd` error. `help`, `version` and
  `completion` still work there.
- 74315ea: After a crash on a controller stack, `cotal down --yes` now leaves a root that `cotal reset store`, `cotal reset space` and `cotal clean store|all --force` accept. That `down` finds every member gone and records it as already stopped, and these commands, which remove the store, now count such a member as stopped. They used to refuse it for having no stop receipt and name a `down` that changed nothing, so the only way out was a full `up` and another `down`. A reset refused before that `down` now names `cotal down --yes`. Backup still requires each member's own stop receipt.
- b5bb4e1: `backup restore` and `up --restore` with an artifact of another space now refuse `CONFLICT` (exit 2)
  and name both spaces. They reported an unknown outcome (exit 3) and sent the operator to check a
  restore attempt that never existed, although the check runs before the preserved cut changes.
- 4ebface: `backup restore` and `up --restore` with the preserved source missing and no
  `--accept-missing-source` now refuse `TARGET_NOT_FOUND` (exit 2), naming the missing path and the
  `--accept-missing-source` route. They reported an unknown outcome (exit 3) with a Next about a
  restore attempt that did not exist, although nothing was changed.
- 043939b: `cotal backup restore <dir> --store-dir <path>` and `cotal up --restore <dir> --store-dir <path>` refuse a store path that already exists, or whose parent directory is missing, as `USAGE_INVALID` (exit 1), naming the path, before anything is staged. Both used to exit 3 with `OPERATION_UNKNOWN`, "store path must be absent" or a raw `ENOENT`, and a Next that said the journal names no restore attempt.
- af26abf: A command that targets the selected space from inside a project whose root has a different
  registered space now says so before it acts. It warns on stderr and in its JSON `warnings` with
  `SELECTION_NOT_FOLDER_SPACE`, naming both spaces and the `--space` that targets the folder's space.
  `send`, `status`, `who`, `ps`, `whoami`, `endpoints` and a named `down <service>` used to act on the
  selection there with only a `Mesh:` header to show it.
- b079d7d: `cotal send --creds` with a credential that may not read the space's roster now refuses with `PERMISSION_DENIED` as soon as the broker denies the read. It used to wait about five seconds and report an unknown `timeout`. A batched Direct Get in core now ends on the broker's permission denial for its request.
- 0b4597a: `cotal send` refuses a lone `-` and names `--stdin` and `--file -`, which read stdin. It used to
  publish the text "-". An empty quoted body is refused as empty. It used to be told to choose one
  body. These refusals now suggest the destination you gave.
- fd4218e: `cotal send --file -` now reads the message from stdin, as `--stdin` does and as `persona create --from -` already did. It was refused with `TARGET_NOT_FOUND` and "the explicit message input could not be read". A message file that cannot be read is now refused with its path, in the message and in the `--json` target.
- d666ad3: `cotal send` now says what to do when its target or a mention cannot be resolved. A name that several participants share is refused with the full identities that carry it, and one that is not present points at `cotal who --all`. Both reach `error.remedy` and the human "Next" line.
- 8f5b9b1: `cotal space add --mode open` now checks that the broker serves a space by that name, as its streams show. A name it does not serve, such as a typo, is refused with `TARGET_NOT_FOUND` naming the spaces it does serve. Before, an open broker's answer was enough, so the mistyped space was recorded as healthy and every later operation on it failed without naming the name.
- 2288d6b: `cotal space add` outside a project with no `--root` now refuses with one line and a remedy that says what to pass, instead of printing the whole `space` help. The line no longer describes the folder only in terms of credentials: an open space keeps none there, so any folder will do.
- 9e5b8a7: `space add` of a space this machine started, or one a catalog lists, now says so in its refusal
  and points to `cotal space show <name>`. Before, the refusal offered `--force`, which is then
  refused for that space.
- c20ed79: `space create` refuses a name that `cotal up` cannot start, such as one with a space, a dot or a
  non-ASCII letter, with `USAGE_INVALID` before anything is written. Such a name used to be prepared,
  and the first `up` in its folder then refused it and left the folder held by that name.
- dfd4bf6: `cotal space create <name> --root <dir>` on a folder this account cannot write, such as `/`, now refuses `PERMISSION_DENIED` (exit 2) with "<dir> is not writable by this account, so its .cotal could not be made; nothing was written" and a next step, rather than exiting 3 with an unknown outcome and a raw `EACCES` error. Nothing is written in either case. `cotal setup` prepares a space through the same step and refuses the same way.
- 25d7780: The `space delete` receipt now has a Next that names the route back: on a space this machine started, `cotal down --yes` (or `cotal down` on a legacy root) and then `cotal up` start it again with empty streams, or `space forget` after that stop drops it. A bare `cotal up` under a broker whose streams were deleted now refuses `TARGET_NOT_FOUND` (exit 2), saying the broker no longer holds the space's streams and naming that restart, instead of exiting 3 with a raw JetStream code 10059.
- b0bf2e1: `space delete` of a stopped stack now names `cotal reset store <space> --yes`, which removes its stored
  streams, and `space forget`. Before, it said to start the space and delete it then, which meets the
  running-stack refusal again. A prepared space that never ran names only `space forget`. The
  `--dry-run` warning on a running stack no longer says that no broker was contacted.
- 85213b4: `cotal space forget` now removes the per-space preferences saved under the name it forgets, so a later space with the same name no longer inherits them. The receipt lists each removed key and value with the `config set` that restores one. The removal takes the preferences file's lock and revision check; when it fails after the record is gone, the run is partial and names the `config unset` that finishes it.
- f8d928a: When a controller stack's manager or delivery daemon has died, `status` now leads its Next with
  `cotal up --root <root>`, which restarts it. `ps` against a stack whose manager died refuses with
  "no manager is running for this space" and names bare `cotal up`, as it does for a stack started
  with `--no-manager`. It used to end with "no manager reachable on the ep rails" and no Next.
- 4f58a3c: When a root's controller stack runs under another `COTAL_HOME`, `status` and `up` now say so, name the
  Cotal home in use and tell the operator to run with the one the stack was started under. `status`
  said to start the stack with `cotal up`, and `up` refused its own members as legacy pidfile-owned
  processes with no next step.
- 2812cd4: A controller stack's first `up` records its broker address, and an `up --server` naming another address refuses `CONFLICT`. That refusal said only "this root's stack journal names another space or broker address; it was not rebound", with no address and no next step, after a `down`, after a successful run, and after `space forget` and `space create`. It now names the recorded address and the address this `up` asked for, and its next step is the bare `cotal up` that starts the stack at the recorded address. A different `--store-dir`, `--max-file-store` or `--host` names each input it changes with its recorded value, and gives the same next step. `up --help` and docs/cli.md no longer call `--server` an override: a stack's first `up` records it.
- 844a07e: `status --components` no longer fails a healthy stack because the optional web dashboard is not
  installed. With no dashboard extension and no dashboard process record, the web row reads
  `not-installed · optional` and exits `0`. An installed dashboard that is not running still reads
  `absent` and exits `1`.
- 0caaa99: `cotal status` in the folder of a forgotten prepared space now names `cotal space create <name> --root <root>` as the next step. It used to name a bare `cotal up`, which started the default space `main` there and then blocked preparing the forgotten space in that folder again.
- a1f38cd: `cotal status` no longer reports the delivery responder as bound right after the delivery daemon is killed. The dead daemon's ready row stays in the lease for up to 30 seconds and names this folder's own credential, so status read it as healthy while the same report showed the delivery process gone. When this folder's delivery pidfile names a process that has exited, status now reports that row as `stale`: not bound, a dead daemon's record that expires on its own.
- 0284080: `cotal status` on an open mesh no longer reports the delivery responder as `NOT BOUND` with a `cotal up` remedy. Open mode runs no delivery daemon, so when no delivery lease is recorded the row says the responder is not used, and `status --json` gives `deliveryResponder: null`. A lease that is recorded is still reported as before.
- b1919f5: A command whose output cannot be written no longer crashes with a Node stack trace. `cotal version >/dev/full` printed a 21-line trace and exited 1, and every command did the same on a failed stdout write. It now prints one line, `could not write to stdout`, with the reason, and exits 3, or with the non-zero status it had already set. A `--json` refusal whose envelope cannot be written keeps its own exit code, and a reader that closes the output early, as `| head` does, stays quiet there too.
- 38723ac: `up`, `up --restore` and `backup restore` refuse a `--store-dir` that is a control directory or lies
  in one, such as a root's `.cotal` or the machine home's `.cotal/nats`, unless it is the root's own
  `.cotal/nats`. Before, the broker wrote its store among the root's credentials and records, or into
  the home stack's store, and `reset store` then could not inspect it or offered to remove the home
  store.
- 0132531: The existing part of an explicit `--store-dir` path on `cotal up`, `cotal up --restore` or `cotal backup restore` is now held to the rule `space create` applies to a project root. A group- or world-writable directory in it refuses `PERMISSION_DENIED` before anything is written, naming the path and its `chmod` remedy. `up` used to start the stack on such a store and leave the directory writable by other local accounts. A non-empty directory is still accepted.
- 91160f5: An explicit `--store-dir` on `cotal up`, `cotal up --restore` or `cotal backup restore` that names a regular file, or a path under one, now refuses `USAGE_INVALID` (exit 1) before anything is written, naming the file as not a directory. `up` used to exit 3 with `OPERATION_UNKNOWN` "the controller stack did not start every planned member" without naming the path, after writing its stack journal, and the restores exited 3 with "store path must be absent".
- d29311b: A refusal of a mesh target now names the space and root it concerns under `target` in `--json`, where they are known. A stopped space's `ps`, `who`, `whoami`, `endpoints` and `history` refusals carried `"target": null` although the message named the space, so a script had to parse the message to tell which space refused.
- 9011309: `team boot` of a manifest that requests no agents now returns `ok` with a complete receipt. Before, it
  returned `partial` with exit 4 because agent joins were not checked, though there were none. The docs
  now give the reason every `team remove --dry-run` is `partial`.
- 2842576: `team check`, `team boot` and `team deploy --dry-run` now name each manifest problem by file, line,
  key and reason, and `--json` lists them under `target.issues`. An alias bomb is reported as a
  manifest problem. Before, every mistake gave one identical sentence.
- 8998adc: `team deploy` now names each manifest problem by file, line, key and reason, as `team check` and
  `team boot` do. Before, it refused every mistake with one sentence.
- c650dfc: `cotal telemetry <level>` no longer creates or rewrites the settings file while the environment forces telemetry off. Under `DO_NOT_TRACK`, `COTAL_TELEMETRY_DISABLED` or `COTAL_TELEMETRY=off` it created `~/.cotal/telemetry.json` with an install id, though the docs say the file is neither read nor created then, and it reported `ok` on every repeat while the receipt showed no install id. It now saves nothing and reports a `no-op` with an `ENVIRONMENT_OPT_OUT` warning that names the variable to unset.
- 28a9e11: `cotal up` now refuses a project root that other local accounts can write, with the same check `space create` applies, before it writes anything. In a group-writable folder on a host without a private-group proof, such as one whose `/etc/nsswitch.conf` names `sss`, `space create` refused but `up` started a legacy `main` stack, and bare `down` then refused "the additive attempt inventory could not be read" with no cause and no next step. The refusal from every command that checks a path now names every unsafe entry in its chain at once, with one remedy such as `chmod g-w <project> <parent>`. Bare `down` and `status` also name that cause for a stack an earlier release started there.
- 1e9c0f4: `cotal up --channels <path>` with a file that is missing, unreadable or not JSON now refuses `USAGE_INVALID` (exit 1) and names the file, before anything is written. It used to exit 3 with `OPERATION_UNKNOWN` and no path, after writing the stack journal and creating the broker store directory, and every later `up` in that folder then refused.
- 60e0cee: `cotal up -f <file>` run again in the folder whose mesh for that manifest's space is already running now says the mesh is already running and names `cotal team deploy <file>` and `cotal down` before another `up -f`. It used to report the folder's own broker as one that a fresh boot will not adopt and advise selecting another address.
- 88a07bc: `up -f` on a root that holds a stack preserved by `down --preserve-state` now refuses
  `LIFECYCLE_BLOCKED` (exit 2) and names bare `cotal up`, which resumes it. It reported an unknown
  outcome (exit 3) with no next step, although nothing had started.
- e674ef3: `cotal up` refuses a URL or port-bearing `--host`, or one naming another address than `--server`,
  before anything is written. On a prepared root the controller stack used to take such a value, exit
  3, and leave a stack journal and trust behind, so every later `up` refused with `LIFECYCLE_BLOCKED`.
- f4d074b: A `cotal up` that loses the root to another whole-stack or maintenance command now refuses with `LIFECYCLE_BLOCKED`, names that command's pid, and gives a next step, as `cotal down` already did. It used to exit 3 with an unconfirmed outcome and a bare "maintenance lock is held by a live owner".
- a4ecc63: A start that names no store no longer opens an empty second store over data `down` stopped
  tracking. After `backup restore --store-dir` and a plain `down`, `up` and `up -f` opened a new
  `.cotal/nats` and left the restored messages unused in the other store, with no warning. They now
  refuse `CONFLICT` and name the store the last broker served, and `up -f` accepts `--store-dir` to
  reopen it.
- 86061e2: `cotal up --space <name> --server <url>` from another folder, where `<url>` is the address that space already runs on, now refuses `CONFLICT` (exit 2), saying the space runs there and naming the folder it was started in, instead of blaming "a broker not started here" and suggesting a free port that would start a second broker.
- 9ce709c: The receipt of a controller `cotal up` now offers `cotal spawn --space <space>`. `up` keeps an existing selection, so after starting a second space the bare `cotal spawn` it used to offer launched into the other, still-selected space.
- ba6354e: `up` now refuses a `tls://` broker address, from `--server` or a manifest's `broker.servers`, when no
  TLS certificate and key are configured. It used to start a plaintext broker and record the `tls://`
  address, which every later dial reads as required TLS. The refusal is `USAGE_INVALID` before anything
  starts, and it names `--tls-cert` and `--tls-key`, or a `nats://` address.
- e54b869: `cotal watch --json` now names the resolved space and the refusal's own reason in its `error` record, as the plain form does. `watch --json --view dms` on an authenticated space used to report only `requestedSpace: null` and a generic sentence. The plain refusal also begins with its `Mesh:` line.
- Updated dependencies [7e62dcf]
- Updated dependencies [0aa2ca7]
- Updated dependencies [a78af23]
- Updated dependencies [9eed6bc]
- Updated dependencies [f5424e1]
- Updated dependencies [3ec07a5]
- Updated dependencies [a4e37f4]
- Updated dependencies [72c4595]
- Updated dependencies [869d26f]
- Updated dependencies [2c21df1]
- Updated dependencies [ba5a685]
- Updated dependencies [c8550cc]
- Updated dependencies [ac5a105]
- Updated dependencies [d235fb0]
- Updated dependencies [0e729b5]
- Updated dependencies [28f3ca0]
- Updated dependencies [73cd25b]
- Updated dependencies [0934f70]
- Updated dependencies [cdceff6]
- Updated dependencies [773e6d3]
- Updated dependencies [42d9ea1]
- Updated dependencies [8360fbf]
- Updated dependencies [f0aebea]
- Updated dependencies [047b289]
- Updated dependencies [152e236]
- Updated dependencies [afb587c]
- Updated dependencies [ca4ce70]
- Updated dependencies [b9ddce8]
- Updated dependencies [b24190d]
- Updated dependencies [6471d27]
- Updated dependencies [af26abf]
- Updated dependencies [b079d7d]
- Updated dependencies [85213b4]
- Updated dependencies [4f58a3c]
- Updated dependencies [0caaa99]
- Updated dependencies [d29311b]
- Updated dependencies [28a9e11]
- Updated dependencies [9234229]
  - @cotal-ai/workspace@0.100.0
  - @cotal-ai/core@0.100.0

## 0.99.3

### Patch Changes

- 965af11: `cotal persona show default` and `cotal persona edit default` read and save the default persona that `space create`, `setup` and `up` write. Its file is `default.md` and it names its agents `default_agent`, and both commands refused it with `SCHEMA_INVALID` ("persona name must match the catalog name"), as did `cotal personas edit default`. Show and edit now accept any valid definition whose `name` is not its catalog name. `persona create` still requires the file to name the persona it creates.
- 15effd7: An invalid `preferences.json` no longer stops `cotal help`, `cotal --help` or `cotal completion`. The docs say such a file stops every command except help and shell completion, but both exited 1 with `SCHEMA_INVALID`, so a person with a broken file could not read the help. Every other command still refuses. The refusal's next step now reads "fix or remove <path>; nothing resets it".
- 0da5225: A connector seed that fails now says why on its failure line. With npm missing from PATH, `failed to seed connector "claude" from <path>:` ended in an empty reason, followed by the seed child's progress lines; the reason, here the failed npm install and its `spawn npm ENOENT`, now follows the colon and the progress is printed before it. A seed that fails also stops being reported as an interruption: every later command that seeds said "a previous connector seed was interrupted" after a clean failure. It now says the previous seed failed, gives the reason, and names `cotal ext seed --repair`. A seed stopped by a crash is still reported as interrupted.
- 4da7b78: `cotal space` and `cotal space show` refuse a mesh registry record that does not parse, or is not a usable record, with `SCHEMA_INVALID` and exit 1, naming the file, as `who` and `whoami` already did. They exited 3 with `OPERATION_UNKNOWN`, which says the command may have had an effect, although both only read the registry.
- d91e746: A controller stack now comes back after a crash. When every stack member was killed, both the
  documented `cotal down --yes` then `cotal up` and a direct `cotal up` used to exit 4: the new
  delivery daemon found shard 0 still leased to the killed one and refused to bind. The controller
  `up` now waits out a delivery lease held by the credential the folder gave its previous daemon,
  as the legacy launcher already did, and `down` keeps that credential when the delivery daemon was
  already gone, so the next `up` can still recognise the row. Its JSON `cleanup` field then reads
  `registration-removed-delivery-credential-kept`.
- Updated dependencies [96325dc]
- Updated dependencies [15effd7]
  - @cotal-ai/core@0.99.3
  - @cotal-ai/workspace@0.99.3

## 0.99.2

### Patch Changes

- 74a688d: Lead a signed-in Cloud user to the spaces they can use. `cotal login` lists the spaces its catalog
  discovered and names `cotal use <name>`. A space registered from elsewhere that refuses an ungranted
  account now answers with those discovered spaces, or with `cotal sync` when there are none, instead
  of the operator's `cotal actor grant` command, which only the space's operator can run. The root that
  holds the space's grant ledger still prints that command. `credentialFailure` takes an optional
  remedy, which a structured command reports as `error.remedy`.
  
  A failing space catalog warns once when it starts failing and stays quiet while the outage lasts;
  `cotal status` and `cotal sync` still report it, and a command aimed at one of its spaces still
  refuses. A failed `AuthSpaceCatalogResult` carries `ongoing: true` when it continues an earlier
  failure.
  
  `cotal setup` no longer calls Cloud in development: `--destination cloud` and the terminal choice say
  to sign in with `cotal login` and set the space up as self-hosted. A scripted run with missing flags
  prints the error, the missing flags and the scripted form without the full command help.
- 8b7d625: `cotal send` no longer reports a possibly stored message when nothing was stored. A channel post the
  broker refuses is `PERMISSION_DENIED` and lists the channels you may post to, or the space's
  registered channels when your grant is on another machine. A message over the broker's message
  limit is refused with its size and the limit before anything is sent. Bare `cotal down` blocked by
  an additive ledger now names each ledger and the `cotal down --run <id>` that finishes it.
- Updated dependencies [74a688d]
  - @cotal-ai/core@0.99.2
  - @cotal-ai/workspace@0.99.2

## 0.99.1

### Patch Changes

- 1708ce5: Create a missing Cotal config directory with mode 0700 from every writer, not only the extension
  writer. Under a group-writable umask, `config set`, the seed store and lock files made it 0775, and
  `completion` and `ext seed` then refused the directory cotal had just created. A completion file
  that cannot be read now names why instead of a bare PERMISSION_DENIED.
- 50de78d: Point Claude Desktop chat on a signed-in space at the space's hosted connector. Desktop chat
  supplies no native session, so this computer's `--desktop` server cannot join a signed-in space,
  yet setup wrote its entry and status reported it as added. Setup for a signed-in space now writes no
  Desktop entry and prints the hosted connector URL to add under Settings > Connectors > Add custom
  connector, the Claude Desktop status row prints it for a signed-in selected space, and the server's
  refusal names it. The URL comes from `cloudCapabilities.hostedConnector` (version 1, HTTPS) in the
  space's discovery document; a space that advertises none is reported that way. The Desktop server's
  instructions no longer tell the model to prefer the local path for a signed-in space.
- 636cb2c: `cotal history --dms` names a DM's recipient when a message in the window came from that principal, in the table and in `--follow` lines, and shows the principal otherwise. It used to show every recipient as a raw principal. An open-mode `chat` session's principal is now `local.<hex>`, the same form as other open-mode endpoints. It was `local.local_<hex>`, which read as a doubled prefix wherever the principal was shown. `result.items[].to` in `--json` is still the principal.
- 6661221: `cotal send -c <channel> --mention <agent>` now puts the agent's name in the message's mention list, as SPEC §5 defines it. It used to put the agent's instance id there, so a `chat` session, which compares the list with its own label, received the post with `mentionsMe: false`, and the durable mention copy on a `live` channel never resolved. An instance id is still accepted and is sent as that agent's name, and it is refused when the name also resolves to another participant.
- cce57c1: The `cotal send` guide now says when a recipient can answer by the sender's name. On a static or open mesh every send has its own principal under the same display name, so once a recipient has heard two sends from the same login and host, a reply by that name refuses with `TARGET_AMBIGUOUS`. The guide names the replies that still work: the id on the message, or `/reply` in `chat`. It used to say a reply by the sender's name always works.
- bcc22a2: Keep a controller stack controllable across an upgrade. Each member record pins its built-in
  adapter at the release that wrote it, and every control path compared that version too, so after
  `npm i -g cotal-ai@<new>` the new `cotal down` refused to stop a running stack (CONFLICT, "the
  selected native service pins another definition or adapter revision") and `cotal up` refused to
  restart a stopped one. Built-in and first-party adapters are version-locked to the CLI, so their pins
  now match on name, package and declaration; a third-party adapter's version still counts. Also list
  the candidate IDs of an ambiguous service instance on one line, instead of printing `\u000a`
  between them.
- Updated dependencies [1708ce5]
- Updated dependencies [50de78d]
  - @cotal-ai/core@0.99.1
  - @cotal-ai/workspace@0.99.1

## 0.99.0

### Minor Changes

- 6999190: Telemetry counts a person once. The settings file with the install id now lives in the OS user's own Cotal directory (`~/.cotal/telemetry.json`, or `%LOCALAPPDATA%\Cotal` on Windows), which `COTAL_HOME` no longer redirects, so every workspace one person runs under their own account reports the same install id instead of a new one per `COTAL_HOME`. At `regular`, the `command` and `install` events carry a new `account` field: a sha256 hash of the IdP URL and subject id of the home's cached sign-in, cut to 32 hex characters, so one person on several machines counts once; the id itself is never sent, and the field is `null` without a sign-in. `cotal telemetry` reports the hash. A level set earlier in a `COTAL_HOME` file is not read any more; set it again with `cotal telemetry <level>`.

### Patch Changes

- Updated dependencies [8aac50d]
- Updated dependencies [6999190]
  - @cotal-ai/workspace@0.99.0
  - @cotal-ai/core@0.99.0

## 0.98.0

### Patch Changes

- Updated dependencies [b6e3fba]
- Updated dependencies [c445511]
  - @cotal-ai/core@0.98.0
  - @cotal-ai/workspace@0.98.0

## 0.97.1

### Patch Changes

- Updated dependencies [aa8d11e]
  - @cotal-ai/core@0.97.1
  - @cotal-ai/workspace@0.97.1

## 0.97.0

### Minor Changes

- e2fc5e1: Host service endpoints from the stock CLI. `cotal up --user-auth --service-endpoints` passes `--service-endpoints` to the auth service, which opens the service endpoint engine, the public `/service-endpoint-authority` door and the new authenticated `/service-endpoint-host` route. That route authenticates the caller's IdP token and derives the granter itself: `decide`, an `owner-request` revoke and the reads run as the proved owner on either face; `name-bind`, any other revoke and the admission operations are the operator's and are served on the loopback face under the exchange capability only, with the proved subject as the audit id. The body never carries a granter. The engine now serves the `name-read` the host contract already declared, scoped to the owner's own binding. `cotal service-endpoint approve|refuse|proposal|operation|name|name-bind` drives the route as the signed-in user: a decision reads the proposal, with the name binding that read carries, and decides at those revisions. Without the flag nothing changes: the engine stays off and both routes answer 404.
- 1321eb8: Own-broker service caller issuance. `cotal up` retains the system-account signing seed in the root's secret store, beside the seed-free trust record, at space creation and at `--rotate-sys` (the successor's seed replaces the retired account's). An auth service started with `--service-endpoints` composes the caller payload bootstrap from that record when it names the trust record's system account and the seed derives it: each bootstrap mints one 60 s VARZ-only observer credential, and the seed never leaves the broker-owning auth service process; the machine daemon, participant clients, connectors, bundles and sandboxes never hold it. A root with no retained seed opens the engine and door without caller issuance and says why; a record for another account refuses the start. `@cotal-ai/workspace` exports `retainSystemSigningSeed`, `readSystemSigningSeed` and `systemSigningSeedKey`.

### Patch Changes

- Updated dependencies [624e71f]
- Updated dependencies [ec7dbfc]
- Updated dependencies [352bbe7]
- Updated dependencies [030fba8]
- Updated dependencies [9c193e5]
- Updated dependencies [d03c223]
- Updated dependencies [a5b5731]
- Updated dependencies [1321eb8]
  - @cotal-ai/core@0.97.0
  - @cotal-ai/workspace@0.97.0

## 0.96.1

### Patch Changes

- @cotal-ai/core@0.96.1
  - @cotal-ai/workspace@0.96.1

## 0.96.0

### Patch Changes

- Updated dependencies [083205e]
  - @cotal-ai/core@0.96.0
  - @cotal-ai/workspace@0.96.0

## 0.95.2

### Patch Changes

- 393870a: Usage telemetry at `regular` now carries a failure's error text: `errorMessage` with quoted values, URLs, email addresses, IP addresses, paths and token-shaped runs masked, and `errorStack` with at most 12 frames whose paths are cut down to their part inside `node_modules`. docs/telemetry.md lists the masking rules and notes that the intake derives a country from the request address without storing it.
- @cotal-ai/core@0.95.2
  - @cotal-ai/workspace@0.95.2

## 0.95.1

### Patch Changes

- @cotal-ai/core@0.95.1
  - @cotal-ai/workspace@0.95.1

## 0.95.0

### Minor Changes

- b7acdcc: Add anonymous, opt-out usage telemetry to the `cotal` CLI. Each command sends one small event as it exits (command name, outcome, exit code, duration, version, OS, architecture, Node major, CI flag; at the default `regular` level also the registered subcommand, flag names, the typed error code, whether stdout is a terminal, the shell and terminal program names, plus one install summary per UTC day). It never sends arguments, flag values, paths, mesh, space, agent or user names, environment values, error text or message content. `cotal telemetry` shows the level in force, its source, the random install id and the intake URL; `cotal telemetry off|minimal|regular` sets it. `DO_NOT_TRACK=1` and `COTAL_TELEMETRY_DISABLED=1` force it off, `COTAL_TELEMETRY` names a level, and `COTAL_TELEMETRY_URL` points a self-hosted intake. A one-time notice prints on the first interactive run. The settings live in `<home>/telemetry.json`; `@cotal-ai/workspace` gains its reader and writers.

### Patch Changes

- Updated dependencies [b7acdcc]
  - @cotal-ai/workspace@0.95.0
  - @cotal-ai/core@0.95.0

## 0.94.7

### Patch Changes

- @cotal-ai/core@0.94.7
  - @cotal-ai/workspace@0.94.7

## 0.94.6

### Patch Changes

- ba9155a: A controller stack whose manager stop has no terminal receipt can be unblocked. When a manager is killed before it answers a stop request, every later bare `up` and `down` refused `LIFECYCLE_BLOCKED` and no command cleared it. `cotal down --abandon-stop <request-id> --yes` now abandons that request once the manager and the `down` that sent it have both exited: it removes the request, the stop reservation and any `--with-agents` shutdown intent that stop armed, records the manager `failed`, and stops the rest of the stack with a `STOP_ABANDONED` warning, because whether the manager stopped its agents' seats is not confirmed. The refusal's remedy names the command with its request ID.
- Updated dependencies [ba9155a]
- Updated dependencies [520c66b]
  - @cotal-ai/workspace@0.94.6
  - @cotal-ai/core@0.94.6

## 0.94.5

### Patch Changes

- 2ff5fc8: `cotal completion install` no longer replaces a shell startup file its owner made read-only. It writes its stub, leaves the startup file unchanged, and fails, exit 5, naming the line to add yourself. `cotal completion uninstall` refuses such a file, exit 2, and changes nothing.
- 4b64fe7: A manager that refuses a stop request after `cotal down` stopped waiting no longer blocks the stack. The manager refuses because the `down` that published the request has exited, and it keeps running. The next bare `up` or `down` now reads that `refused` receipt, removes the request, releases the stop reservation and returns the manager's record to `running`. `down` then stops the manager, and `up` reuses it.
- Updated dependencies [4b64fe7]
  - @cotal-ai/workspace@0.94.5
  - @cotal-ai/core@0.94.5

## 0.94.4

### Patch Changes

- 464413c: A manager stop that completes after `cotal down` stopped waiting no longer blocks the stack. The next bare `up` or `down` reads the stop's own receipts, records the manager `stopped` when it recorded the stop completed and its process is gone, releases the stop reservation, and continues. A stop with no completed receipt still refuses `LIFECYCLE_BLOCKED`.
- Updated dependencies [464413c]
  - @cotal-ai/workspace@0.94.4
  - @cotal-ai/core@0.94.4

## 0.94.3

### Patch Changes

- @cotal-ai/core@0.94.3
  - @cotal-ai/workspace@0.94.3

## 0.94.2

### Patch Changes

- 454cb0e: Include the human-only approval, review link and unchanged-request retry instructions inside the structured pending result as well as its text. Native clients that show the model only structured content must still receive the instructions to wait for the person and never approve or poll on their behalf. Issuance remains blocked by the authority until the person's recorded decision.
  
  Explain expiry without incorrectly claiming the person never approved: an approved request can also expire before its connection is issued. A fresh request still needs fresh approval.
  
  Exercise native connection, exact recovery, capability attenuation and completed workflows through an isolated approval authority and fixture-person decision, including pre-approval transcript exclusion. Register the live approval controls in the smoke gate.
- @cotal-ai/core@0.94.2
  - @cotal-ai/workspace@0.94.2

## 0.94.1

### Patch Changes

- bb95f28: Add `cotal daemon serve` and `cotal daemon status` on Linux. `serve` runs the local machine daemon in the foreground and serves an owner-only status endpoint at `$XDG_RUNTIME_DIR/cotal/daemon.sock`. `status` reads its state, version, process ID and uptime over that endpoint. Both commands refuse a runtime directory that is not owned by the current user or is not mode 0700. The status client also checks socket ownership and mode 0600. The server never removes a pre-existing socket-path entry and drops connections from other users. A socket left by a killed daemon makes the next `serve` refuse with `CONFLICT` and a manual recovery. This release does not sign in, start a Manager or install a system service.
- @cotal-ai/core@0.94.1
  - @cotal-ai/workspace@0.94.1

## 0.94.0

### Patch Changes

- Updated dependencies [1caaf63]
  - @cotal-ai/core@0.94.0
  - @cotal-ai/workspace@0.94.0

## 0.93.0

### Minor Changes

- e27c44c: A new Claude app conversation identity now needs a person's approval before anything is issued.
  
  `cotal app-identity provision` sends a new request only to a signed-in mesh whose authority advertises connection approval v1. Until the person approves it in the authority's signed-in web page, provision answers `{"ok":false,"pending":true,"requestId","approval":{"id","url","expiresAt"},"proposed"}` with no credential, secret or path, and nothing is issued. Provisioning again sends the same saved request and secret. Once approved, the grant is exactly what the person approved, which can differ from the request. A denial or an expiry drops the request, and the next provision asks again. A model's tool arguments or a client flag never approve one.
  
  A mesh with static credentials, an open mesh, and a signed-in mesh whose authority this machine holds have no approval page, so provision now refuses on them instead of opening an identity. A host without connection approval is refused before any authenticated request, including one without a selection. Identities issued before this change keep working: a saved signed-in identity resumes exactly, and `retire` still removes a static identity an earlier version opened. A request an earlier version saved but never got issued needs the person's decision like a new one, in provision and in recovery.
  
  Provision accepts `--require-approval`. Approval is required with or without it. A caller passes it so that an earlier CLI, which opened identities without approval, refuses the unknown flag before doing anything.
  
  Every identity still sends and receives direct messages and publishes its own activity on its own event channel. A request without a selection proposes nothing beyond those.
  
  Core exports the approval types `ConversationProposal`, `ConversationApprovalPending`, `ConversationApprovalDecision` and `ConversationPending`, the constant `EMPTY_CONVERSATION_SELECTION`, and the parsers `checkConversationProposal`, `checkConversationApprovedSelection`, `checkConversationApprovalPending`, `checkConversationApprovalDecision`, `checkConversationPendingAnswer` and `conversationApprovalRefusal`.
- 69b0538: A signed-in native Claude Code conversation can now ask for channels, a role and capabilities within the person's own grant.
  
  `cotal_connect` in a native Code session takes proposed `channels` (read, or read and post), a `role` and `capabilities` (`spawn`, `run`). The person must review, edit and approve the permissions in Cotal before a new connection is issued. The approved set must stay within their current access, and the returned grant must match that approved set, not the proposal. Unsupported or refused requests never fall back to baseline or broader access. A remote mesh must advertise selection v1 and connection approval v1. The authority may refuse a capability it does not support; endpoint selection is unavailable in v1.
  
  A connection is offered the tools its own grant can use: spawn, despawn and the persona tools with `spawn`, `cotal_run` with `run`, and `cotal_reconnect`. Manager calls exchange the conversation's own secret for a manager-call view. A conversation is not a managed seat, so a self-despawn refuses instead of stopping the app, and `cotal_yield` is not offered.
  
  Core exports `conversationSelection`, `checkConversationSelection` and `conversationGrant`. The gateway gains `NATIVE_GATEWAY_TOOLS`, `GatewayOptions.tools`, `GatewayOptions.selection` and `GatewayConnection.tools`. `cotal app-identity provision` takes `--selection <json>`. The hosted gateway's tool set is unchanged.
- 6703917: Connect personal native Claude conversations to signed-in meshes with separate identities, real lifecycle and own-event publication, durable request recovery, and exact-lifecycle retirement. Bind native wake readers to their conversation while retaining immediate idle and busy-boundary delivery. Capture lifecycle metadata through ordinary command hooks so the native connection does not depend on intercepting the built-in guard's protected events. Keep notification presentation off protected notes and skill output while retaining native sender attribution.

### Patch Changes

- 2a56547: Recover a signed-in native Claude conversation whose identity retirement is still pending. Disconnect, every routed tool and reconnect now report one disconnected state with the mesh's retirement phase and the available retry, instead of advising a reconnect that the same conversation then refused. Reconnecting retries the pending retirement and connects with a new identity once the mesh confirms it, including after the plugin server restarts. After each signed-in connection, the plugin retires the same mesh's saved conversation identities whose plugin server process no longer exists, through the new `cotal app-identity reap` plumbing. It runs in the background, so a connection never waits for it, and it keeps any identity whose server process still exists and retains any retirement that does not finish. The same conversation from another plugin server reuses a saved identity only once the server that held it no longer exists, so a live server keeps its identity even when its process start time reads differently, as macOS `ps` does across time zones and locales.
- Updated dependencies [e27c44c]
- Updated dependencies [69b0538]
- Updated dependencies [6703917]
  - @cotal-ai/core@0.93.0
  - @cotal-ai/workspace@0.93.0

## 0.92.2

### Patch Changes

- d454988: A user-auth seat's bearer command now names the CLI entry file that the `cotal` bin link resolved to, instead of the link. Before, an install that replaced the link with a launcher Node cannot load cut every running seat off the mesh at its next bearer refresh. Running the get.cotal.ai installer over an `npm i -g` install is one such install: it writes a shell script over `~/.local/bin/cotal`.
- 736207e: `cotal spawn --foreground` on a remote user-auth mesh with no sign-in now exits 2 with `AUTH_REQUIRED`, before any request is sent. Before, it was reported as an unknown outcome (`OPERATION_UNKNOWN`, exit 3), which told a script the agent might have been provisioned. Any failure after the provisioning request, an endpoint 401 or 403 included, is still an unknown outcome.
- Updated dependencies [43a5715]
- Updated dependencies [736207e]
  - @cotal-ai/core@0.92.2
  - @cotal-ai/workspace@0.92.2

## 0.92.1

### Patch Changes

- 5a0b741: A broker probe now reports `auth-required` when the broker's greeting asked for auth and the connection was then reset during the handshake. On Windows that reset can discard the broker's authorization error, so `cotal who` against a running auth broker with credentials it rejects said the mesh was not up and suggested unregistering it. The verdict is marked as inferred: it changes the message, but it never removes a registry record and does not verify a `cotal meshes add` registration.
- Updated dependencies [5a0b741]
  - @cotal-ai/core@0.92.1
  - @cotal-ai/workspace@0.92.1

## 0.92.0

### Minor Changes

- 88cc5a1: Fix the backup and restore journey. A full restore now starts: the delivery daemon binds the fanout and reader durables a restore recreates at their recorded start sequence, and still refuses a durable that differs in any other setting. When a delivery daemon that `up` launched exits, the error quotes the failure the daemon logged and no longer blames a lost lease, and a failure on a root that holds a restore or preserved cut never suggests `clean store`. A restore with no preserved cut refuses before it takes the maintenance lock and leaves no state, and `up --restore` refuses the same way instead of reporting an unknown outcome. `up` refuses to take over a space name whose root holds a maintenance journal, whose root or journal cannot be read, or whose recorded root is not an absolute path, and says when it takes over another root's dead registration. A recorded root matches only by the folder it resolves to on disk, so a path that names this root only as text, through a link behind an unreadable folder, keeps its name. A root counts as gone only when it no longer exists or is not a directory, and a readable root with no maintenance journal also gives up its name. These refusals end `refused` with exit 2 on both the controller stack and the retained launcher, with the reason and the next step, where they used to end as an unknown outcome with exit 3. Restore failures, `cotal status` and the recover and cleanup refusals show the `restore-<uuid>` attempt id and the next step for its state. A detached `up` from the machine home names `cotal down --preserve-state`, which is the stop that works there. `backup create` refuses before any claim with the reason and next step, and a destination that already exists is a `CONFLICT` refusal. `backup verify` names the file that is missing, undeclared or does not match its declared size and SHA-256.
- 88cc5a1: `cotal chat` answers by principal. `/reply` answers the latest direct message or role task the session received: it addresses the sender's principal and quotes the message id, with no name lookup, and after the reply is stored the recipient stays that principal. A transcript sender, a `/who` row, an `/inbox` or `/history` line and a recipient choice show the principal beside a display name that another principal in the session carries; `--plain` names those principals once when a name becomes shared. A typed DM target that parses as a principal `<owner>.<actor>`, from `@` or a `--stdio` `dm`, goes to that principal whether or not it is present or was heard from, and is never matched against display names, so no display name can capture it. A peer whose display name parses as a principal is reached by its principal or `/reply`, and typing the session's own principal refuses with `USAGE_INVALID`. A display name that more than one principal carries among the present peers and the heard senders now refuses and lists them, where before a present peer with that name took the message.
- 88cc5a1: A Linear account with no record now refuses with `TARGET_NOT_FOUND` and the `cotal linear account add` route, in `linear account show` and when a `linear` service starts. The service refuses in its launch plan, so no child is started and no failed process exit is reported. A record that exists but cannot be read is still `DEPENDENCY_UNAVAILABLE`. The service checks the account in the Cotal home of the process that starts it, and refuses with `UNSUPPORTED` before a child when `COTAL_HOME` is unset and the definition's `envRefs` set `HOME` (on Windows, `LOCALAPPDATA` or `USERPROFILE`), because the child could read another home. A service adapter's launch hook now receives the definition's `envRefs` names, never their values. The endpoint name is checked when the service starts.

  `cotal update --check` and the version read in `cotal update` run npm with a temporary cache that is removed afterwards, no log files and no npm update notifier, so they leave nothing in npm's cache, log directory or notifier stamp. From a source checkout, the `update --self` hint says it installs a separate global copy.

  `service add --preset` offers no `--no-<option>` flag for a boolean option whose schema admits only true, so the web preset no longer lists `--no-read-only`. An absent `web` preset names `cotal ext add @cotal-ai/web` in its remedy. A background `service start` ends with the `service logs` command for the new instance. Re-adding an existing definition names the remove-and-add route, and an `ext remove` blocked by service instances names each one. A managed dashboard logs an endpoint error or warning by its class, the error's name and code, and never its message.

- 88cc5a1: Settle a crashed or failed controller stack from process evidence instead of wedging its root. A bare `up` or `down` now takes the root's maintenance lock, records a member whose pid and start time are gone as failed, settles an earlier `up` or `down` that never recorded its outcome, and continues with an `OPERATION_SETTLED` warning. A live member is kept; a member whose process cannot be established, or one with an unconfirmed stop, refuses `LIFECYCLE_BLOCKED` with the exact `service status` command. Another holder of the lock is a known refusal that names its pid.

  A manager stop that was published and never confirmed keeps its record `stopping` under that request, also after the process exits. After a `down` that ends this way, the next bare `up` or `down` refuses it and names the instance and the request. `service start`, `restart`, `stop` and `remove` refuse it too, a start before any readiness probe or record write, and its exit is never settled as a crash, also when an earlier release left the record `unknown`. A request file that does not read as its launch's own is reported as an unknown publication. An `up` that redefines a member journals the replacement's instance and launch request before it retires the old instance, and the new definition's revision before the launch, so the next bare `up` or `down` after an interrupted redefinition adopts that replacement and refuses any other record.

  `down` is idempotent: a member already gone is recorded as stopped without loading its adapter or credential. `down --dry-run` exits 0 and lists members in stop order. When the manager is live but the broker is not, `down` refuses before any stop and names `cotal up --space <space>`, from a managed seat's shell too. A foreground `up` releases its terminal when another command stops the stack.

  A first `up` binds the recorded broker address before launching, and a busy port refuses `CONFLICT` naming the address and bind error. A member that exits before readiness is recorded as failed with its exit code and log command. `space create` prepares a controller root again after a completed stop and `space forget`, so the remedy a refused `up` names works.

  `ps` on a `--no-manager` stack refuses with a plain message. `status` shows a controller stack's members instead of legacy process rows and offers `cotal up --root <root>` when the stack does not answer. A legacy component name on a controller stack names its `stack-` member. The broker stop refusal names its dependants. `reset space` names the path that fails its scope check, and its receipt lists each path once. The manager's delivery-aware marker is written owner-only whatever the umask, never through a symlink and only into a file the user owns.

### Patch Changes

- 88cc5a1: Name the next step when an auth command has no space to act on or a grant cannot apply there.

  - On a static or open space, `cotal auth grants`, `grant` and `revoke` and their `cotal actor` spellings refuse with `UNSUPPORTED` and say that actor grants apply only to a space started with `cotal up --user-auth`. On any other space the refusal still points to the machine and root that hold its ledger, and a refused revoke says nothing was revoked instead of "no inert grant was written".
  - With no space to resolve, the auth grant commands and `cotal auth mint` refuse with a next step, such as `cotal up`. `cotal doctor auth` in a folder whose root holds no space adds a remedy to its partial result: run it in a space's root, which `cotal space` lists.
  - Bare `cotal auth` fills its Next lines with the `--space` you gave or the space it resolves, and points to `cotal space` when there is none, instead of printing an unfilled `--space <space>`.
  - The `cotal doctor` help line describes the report it prints, instead of promising it ends in `healthy` or a next command.

- c0f79e7: `cotal chat` and `cotal watch` now show a working peer as "working · progress unknown": chat in its `/who` roster and recipient picker, watch in its roster table. `cotal who`, `cotal ps` and the console already did. A `working` presence says the seat claims to be busy, not that its work is advancing, and neither view observes the peer's last reply to say more.
- 88cc5a1: When the reader of `cotal chat --plain` or `--stdio` output closes it, input ends, the session closes and the command exits with that close's status instead of the closed-pipe exit 0. `cotal watch`, `service logs --follow` and the service journal follow now run their own shutdown on a closed output before the process exits. Elsewhere a closed stdout still exits quietly, and it now keeps an exit status the command already set. `--plain` prints its close line once. A send, join or channel mode outside the session's grant refuses with `PERMISSION_DENIED` before anything reaches the broker, so a `--stdio` join outside the read list is a refusal instead of an unknown outcome, and a session opened on no channel says to open a new session on the channel instead of showing a broker subject. A channel sender now counts as a heard sender: a DM to a name only a channel sender carries reaches that principal, and a name a channel sender shares with another principal refuses and lists them. Chat message times show in local time, with the date when it is not today, as `history` shows them. The chat header opens with `Mesh:`. The `--stdio` requests and records are documented.
- 97e3bf9: A bare `cotal down` of a running legacy stack reads each process record it stops in place, as the stopped-stack check does. A record that check leaves unread, such as one behind a link, a directory or an oversized file, now refuses `LIFECYCLE_BLOCKED` before the first stop and names where reading stopped. Before, the stop read a record through a link into another root and signalled that root's process.
- 88cc5a1: On a static-auth root, `cotal endpoint invoke` of an endpoint other than the manager is refused by the broker, because the operator's own credential requests the manager only. That refusal now names the paired caller file that makes the call, `cotal auth mint <name> --endpoint <endpoint> --space <space> --out <private-file>`, to pass with `--creds`. It names the space the call resolved and any `--server` it was given, so the caller is issued for the space that refused even when another space is current. The remedy appears when the call and the endpoint's whole surface are untargeted synchronous ephemeral commands with no instance pin, scatter, cast, wait or admin flag. `cotal endpoint init` ends with the `ep check` command for the contract it created, quoted for the shell, instead of a `<directory>` placeholder.
- 957b2a8: `cotal help --all` fits a 40-column terminal again. The `doctor` summary lists the credential states as separate words, so the line wraps between them.
- e893458: `cotal down --preserve-state` on a stack with no manager, such as one started with `--no-manager`, now refuses `TARGET_UNAVAILABLE` (exit 2) before it stops anything, and names `cotal up` to start the manager first. It used to stop the delivery daemon, wait about 20 seconds on a manager that never ran, end with an unknown outcome and leave the broker running. A machine-home `up --no-manager` summary names both steps.
- 88cc5a1: `up --server` now refuses an address that is not one `nats://` or `tls://` URL with a host before anything is written, so a typo no longer pins the folder to it. On a controller root, an address the broker service cannot use, such as a DNS name or a wildcard, refuses before the stack journal is written.

  `space delete` refuses while the space's own stack still runs on this machine, before any broker connection, and names `cotal down` and then `cotal reset store` or `cotal clean store --force`. Its dry run shows that refusal as a warning, and its receipt no longer prints an empty "Already absent" table.

  `reset store` and `reset space` now work after a normal `down` of a controller stack. They take the broker address, store and mode from the prepared record and stack journal, which both stay, so a later `up` starts the stack again. Every reset refusal names one reason and the command that clears it. `reset store --dry-run` exits 0 and opens with a verdict saying the apply is offered or why it would refuse. A passing `reset space --dry-run` names its apply as Next.

- 88cc5a1: Show the identity provider's reason when it refuses an elevated view. On a user-auth mesh, `history clear` without scope `admin` and a legacy `team remove --dry-run` whose deployer view is refused still fail with `PERMISSION_DENIED`, and their remedy is now the provider's sentence: the view, the scope the grant lacks and the whole-row re-grant that adds it.
- 239d1c7: Run `cotal down` again in a folder whose stack is already stopped, and it says so instead of refusing.

  - A second bare `cotal down` reports that the folder's stack is not running and names `cotal up`, with outcome `no-op` and exit 0. It needs no `--yes` and writes nothing. `--dry-run`, `--json` and `--plain` show the same. A controller stack counts as stopped after its own completed `down`, with no member or other service instance of its space running. That check reads no process record under the root; those are read only as the next bullets describe. A legacy root counts as stopped when no registration or top-level `*.pid` record remains and it still holds the broker configuration a start rendered there, or a space prepared there.
  - Without that evidence a legacy root still refuses, now with one next step: `TARGET_NOT_FOUND` when nothing shows a stack there, `CONFLICT` naming the spaces when several registrations name the root, and `CONFLICT` pointing to `cotal status` when a process record remains with no registration.
  - Before it reports the no-op, `down` reads every record a local-process descriptor names under the root, an installed extension's included, at any path under `.cotal` and for any space a record's name holds. One whose process may still run, that cannot be read or attributed, or whose space part decodes to no space refuses `LIFECYCLE_BLOCKED`. Nothing outside the root's `.cotal` is read: a link on a record's path refuses at the link, unread, as does a record that is not a regular file, is larger than a process record, cannot be opened, or changes while it is read. Each is named once, where reading stopped. A template whose `{space}` normalizes away is read as the one path it names. The refusal names each record with its path and pid, and its next step lists the pids and paths to check. Nothing is stopped, adopted or removed.
  - `--with-agents` on a stopped stack refuses `LIFECYCLE_BLOCKED` and says to start it first. Its preview, `cotal down --dry-run --with-agents`, shows the no-op.
  - Outside a terminal, a bare `down` that would stop a running controller stack still requires `--yes`. The refusal is now one line and its remedy, without the command help.

- 36800cf: `cotal spawn --foreground` refuses an actor whose foreground material another session holds, or that already has a grant, with `CONFLICT` and exit 2. Since the command-line redesign it reported that refusal as an unconfirmed outcome with exit 3, though nothing had been launched or issued.
- a27663e: A delegated seat command (`COTAL_MANAGED_HANDOFF_FILE` with `cotal spawn --config <persona-file> … --expect-owner … --expect-lifecycle-uid …`, as `delegatedSeatCommand` builds it) is accepted again. Since the command-line redesign, `cotal` took the handoff file before checking spawn's arguments, so the check no longer saw the variable and refused `--config` as "reserved for persisted internal launch callers". Without a handoff, `--expect-owner` and `--expect-lifecycle-uid` are refused first, naming `COTAL_MANAGED_HANDOFF_FILE`. `cotal spawn --help` now says `--creds` and `--on` apply to any managed launch, not only `--detach`, and that `--runtime` and `--allow-stale` are refused in favour of `cotal team deploy <file>`.
- 07c0c26: Bare `cotal status` shows the selected space's delivery responder again. Since the command-line redesign it showed it only in `--verbose`, or on this folder's own delivery process row, so an operator on a manager host away from the broker's folder could not see that spawn, retirement and join were blocked. The selected-space section now has a `Delivery responder` row that reads bound, not bound, or not bound with a dead daemon's record still holding the lease, as the verbose section does. The section now also appears for a broker named with `--server` when nothing on this machine is registered.
- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [1db940e]
- Updated dependencies [239d1c7]
- Updated dependencies [f276a46]
- Updated dependencies [c935e28]
- Updated dependencies [588a5a7]
- Updated dependencies [b3441b1]
- Updated dependencies [03d9e7b]
  - @cotal-ai/core@0.92.0
  - @cotal-ai/workspace@0.92.0

## 0.91.0

### Minor Changes

- 5c85ef3: Apply the new terminal screens to status, help, settings, setup receipts and inventories. Add compact action guidance, command shorthands, named agent details and the live observer. Group guarded manager maintenance and channel metadata operations under their new command names.

  Validate the public recipient and agent-target arguments before installation or catalog preparation.

  Support explicit message file/stdin input, channel mentions and direct replies with non-echoing structured storage receipts. Show broker-derived channel membership without treating it as access or task progress.

  Consolidate workflow reads, file-based launches, offline language tools and own-seat turn handling under run/r with explicit source and outcome labels.

  Add account-provider selection, private device-approval guidance, structured sign-out receipts and a non-installing update availability report.

  Expose native managed-launch readiness and original request/goal attribution, verified self stop,
  hard despawn and manager supervision flags. Add non-echoing native terminal-input receipts,
  authorized endpoint contract/invocation reports, the full read-only watch view family, partial
  recorded team reads and account/actor authority reports. Keep unestablished live state explicit.

  Share protected owner-private local record access between endpoint references and service
  definitions. Add case-safe per-space service definition inventory, guided/file import, policy
  reports and guarded local removal, keeping existing process observations distinct from owned
  instances and serving readiness.

  Resolve saved endpoint targets through the canonical describe/invoke namespace. Pin the local
  reference revision through native calls, disclose the resolved target and preserve exact instance
  selection without broader-caller or class-queue fallback.

  Read authorized native endpoint registrations with explicit bounded-lag enumeration, leader-read
  coordinates and partial results for unreadable or omitted keys. Keep registration, reported status,
  process ownership and current serving responses distinct.

  Add the guarded history-clear screen with default-cancel scope review, explicit scripted confirmation,
  offline dry-run and per-stream native purge receipts. Preserve acknowledged partial work and unknown
  submissions without retrying destructive requests.

  Expose digest-verified action metadata to clients and add native endpoint action following with
  --wait. Retain original requests and accepted goal identity, use accepting-instance reconciliation
  and emit explicit bounded goal stream records without resubmitting an unknown action.

  Apply the shared report treatment to classified failures and expose safe original-request, accepted-
  goal and responder attribution without copying raw argument or native-detail objects into reports.

  Make spawn --file select a persona on its execution host, with the native shared manifest schema
  providing the team-deploy refusal. Add non-launching offline preview reports and a protected explicit
  foreground enrollment-file input without changing native launch fields or adding wire authority.

  Add a Linux process-service driver with machine/boot and process-creation ownership, exact
  instance selection, explicit multi-instance launch, bounded readiness/log reads and guarded
  stop/restart/removal. Distinguish owned process presence and HTTP reachability from endpoint
  serving, retain uncertain launch receipts and never fall back to PID-only or remote controls.

  Add ownership-aware completion installation, refresh and removal with finite JSON/plain receipts.
  Keep custom and modified shell material, preserve the stable offline dispatcher and refresh only
  existing recorded stubs through the current-generation updater without adding startup wiring.

  Add offline endpoint contract scaffolding and checking through the installed native cluster/schema
  compilers. Create files exclusively, derive digests from schemas and keep handler execution,
  serving authority and opaque attribute/event semantics separate from local validation.

  Expose native ephemeral endpoint casts with pre-publication journal refusal and non-execution
  receipts. Keep original request/binding attribution, broker denial and unknown outcomes distinct.

  Expose target-bound account signer export under auth signer with required protected output,
  inspected same-account replacement, public-only receipts and no operator-root or caller issuance.
  Share protected workstation file access across the credential, endpoint and service frontends.

  Add protected, explicitly unverified handle metadata inspection without signatures, redemption or
  caller issuance. Resolve literal nested help and scoped aliases through declared metadata while
  keeping help offline and provider imports behind validated execution.

  Move static credential minting into auth mint through a registered implementation action, with
  one shared flag grammar and public-only JSON/plain receipts. Keep source-root authority/profile
  checks, native provisioning and expiry metadata, use create-only default labels and explicitly
  report a reused nkey's new out-of-band lifecycle instead of claiming its old inbox was retained.
  Reject the top-level mint spelling before effects and keep explicit exports out of managed state.
  Name both roots when the selected root and current folder disagree about the signing authority.

  Expose one-shot native endpoint class scatter with frozen-set reconciliation, attributed member
  results and every native anomaly bucket. Keep pinned/targeted/journaled calls off this route,
  preserve classified mixed/unknown outcomes and retain useful result data in finite failure reports.

  Add exact-manager persona list/show/create with native ownership checks and bounded complete-file
  merging. Refuse unsupported metadata before submission, retain the actual responder/request and
  separate a confirmed save from a denied or unknown optional announcement without retrying it.

  Expose exact-target endpoint deregistration through the existing native guard as a registered
  operator action. Require a reviewed full class/instance, preserve TLS and selected static authority,
  refuse unsupported auth fallback, keep dry-run offline and report native deletion revisions or
  uncertainty without retry. Turn the old default-instance spelling into a pre-effect migration refusal.

  Add finite private-backup creation receipts after native cleanup, read-only manifest inspection
  and size/SHA-256 verification without staging or restore claims. Expose exact-attempt recovery
  and healthy fallback cleanup with default-cancel review, offline plans, revision rechecks and
  native owner/identity guards. Keep confirmed publication and incomplete cleanup distinct.

  Add public-only JSON/plain feedback receipts with bounded response metadata, explicit unknown
  submission outcomes and no redirect or retry. Accept protected key-file input, refuse raw keys on
  argv and keep submitted bodies, contact values, credentials and response text off diagnostic output.

  Move credential diagnosis and native static daemon repair onto shared JSON/plain reports. Add
  nonmutating observation intent at the existing local migration boundaries, retain acknowledged
  path moves/re-signs separately from adoption, keep prior broker refusals visible and avoid live
  agent or open-mode claims from absent/local credential files. Never expose secret fingerprints or
  raw credential/audit parser diagnostics in the new reports.

  Evolve workstation local-process providers with a versioned service ABI, closed bounded option
  schemas and package-bound cached declaration fingerprints. Validate definitions without provider
  imports, then route explicit adapter launches through the creation-pinned direct-process
  controller. Retain adapter provenance, exact native readiness coordinates and unknown hook
  outcomes. Check declared capabilities and keep service launch intents behind extension-removal
  guards without introducing wire grants, manager impact bypasses or implicit dependencies.

  Add declarative service presets with schema-derived parsing, scoped help/completion and guided
  creation. Validate declared protected path references without reading contents. Expose the native
  feedback-intake preset through the shared controller, using the guarded same-binary re-exec and
  existing intake implementation. Correlate post-listen startup with the exact child/launch,
  preserve TLS and private append-only storage, keep credentials on file references and refuse
  the former top-level intake launcher before effects. Separate controller-only providers from
  legacy PID inventory and retain startup/data receipts without claiming endpoint serving.

  Expose the independent delivery preset through its own registered local-process provider, using
  shared workspace custody metadata instead of an implementation import. Retain the native scoped
  store, SYS account scan, singleton lease and TLS checks, refuse legacy custody adoption and
  publish startup only after native readiness. Share private child-bound startup receipts and
  public-only target resolution between native adapters, while preserving the workstation path
  context without inheriting arbitrary credential or agent identity environment values.

  Expose caller-scoped manager stop-impact observations through the native status contract. Reuse
  its actual runtime seat policy, retain owner filtering and show pending lifecycle/retirement work
  without treating an observation as stop authority, a reservation or completed cleanup.

  Put manager gate repair and retained-seat maintenance on shared JSON/plain reports and default-
  cancel confirmations. Preserve the registered target/TLS policy, classify uncertain submitted
  effects without replay and separate native gate/custody receipts from serving or cleanup claims.

  Apply scoped grammar/help and shared account, inventory and native-request reports to Linear.
  Keep native MCP isError results distinct from unknown execution, bound human output without
  truncating JSON and preserve its existing serving/caller authority during the pending transitions.

  Give existing native Linear caller issuance a private create-only output preflight and shared
  receipts. Preserve original identity/lifecycle and uncertain provisioning/publication without
  replay, broader caller substitution, managed-launch claims or environment-export onboarding.

  Keep direct-service supervisor assignment distinct from unperformed OS discovery in instance
  and preview reports; a recorded none does not claim external supervision is absent.

  Prepare private, request/process-bound native stop handoffs and immutable phase observations.
  Keep cleanup unverified and existing reservations untouched; manager service control is not
  activated by these primitives alone.

  Expose the manager embedding's own registration/policy observation without exporting credentials,
  URLs or grants. Keep it distinct from fresh serving evidence and wire caller authorization.

  Provide a public-only native manager identity callback before endpoint construction and expose
  its actual per-process UID in status. This supplies launch-correlation data without treating
  identity metadata as serving readiness, ownership authority or a generic caller grant.

  Prepare private native identity bindings before endpoint construction. Preserve dotted endpoint
  class names under the native validator, keep epochs out of pre-serving identity data and require
  a separate attributed response before any serving or process-control inference.

  Add the native manager service preset with pre-endpoint identity binding, post-start signal-ready
  receipt and invoking-caller readiness/impact observations. Show the full native seat consequences
  before default-cancel confirmation and bind the unchanged scope to the live native reservation.
  Require immutable accepted/returned evidence plus original process exit before a stopped record;
  retain unknown requests without force kill or restart, and leave cleanup unverified. Keep generic
  and legacy signal paths from bypassing this boundary. The child never publishes its console URL.
  Foreground, OS-supervised and non-Linux manager service operation remain unsupported.

  Add the prepared native auth-service preset with shared daemon inputs, exclusive real-child PID
  custody and a private post-initialization startup receipt. Keep discovery capability and key
  material native and private. Refuse existing custody, remote brokers and TLS-required targets
  instead of reclaiming a daemon, weakening transport or generating new issuer material. Keep
  foreground/OS-service operation unsupported.

  Add the Linear service preset over the existing account, native static registration and renewal
  implementation. Bind its explicit root/registered transport and publish a private handler-
  initialization phase only after shutdown handlers exist. Keep process/initialization evidence
  separate from broker flush, fresh endpoint response and native deregistration completion. Refuse
  unsupported issuer/foreground/OS-service modes without substituting authority.

  Show checked installed preset metadata and declared readiness/foreground/instance/stop capabilities
  in service inventory. Keep unavailable or mismatched metadata partial with explicit warnings;
  metadata validation is not application readiness or OS-install support.

  Prepare full-instance/definition/host-bound supervisor receipts and non-echoing recorded-unit
  file observations. Keep loaded OS state/autostart unchecked, preserve missing/modified receipts,
  and refuse direct process controls or removal beside a recorded supervisor. OS installation and
  native unit control remain unimplemented; no unit is created or enabled by these readers.

  Claim the managed manager child's real native PID custody exclusively before endpoint startup,
  without adopting a contender or treating a starting record as readiness. Settle the same process
  and retain owner-bound release after native start; keep legacy entry behavior separate.

  Add bounded same-host status reads for unchanged recorded systemd user units. Report physical
  fragment, native states, invocation and exact process/launcher attribution without unit or
  environment bodies; keep missing/ambiguous/drop-in observations partial. Status does not reload,
  start/stop a unit, infer endpoint readiness or prove effective autostart.

  Prepare a built-in direct-process unit boot entry with complete controller/definition/instance
  validation before extension overlays, repair or package materialization. Require the recorded
  native invocation before same-PID process replacement, refuse managed-spawn handoffs and retain
  unknown starting evidence without retry. This does not install units or prove execution/readiness.

  Declare auth and Linear foreground service lifetime through the shared owned-child controller
  and native shutdown handlers. Print lifetime/output policy before launch, retain manager's native
  impact requirement, and prevent native service child boot from repairing connector packages.
  Process exit still does not prove endpoint, descendant, registration or authority cleanup.

  Route recorded systemd service logs through bounded native journal reads/following pinned to the
  original unit invocation, boot and UID. Preserve native cursors/timestamps and binary JSON, report
  record/query/diagnostic gaps, close only the reader on interruption, and refuse missing invocation
  evidence without substituting a direct-child file. Journal retention and cleanup stay unestablished.

  Expose the service install/uninstall paths with the same exact definition/instance
  selection and a typed unsupported boundary where native OS control is missing. Never route them
  through the old manager-only installer, allocate a stopped record or change autostart on refusal.

  Expose auth redeem with closed per-mode input and the selected native auth target. Refuse
  unsupported conferring-handle redemption before reading the file or spending authority, rather
  than substituting agent enrollment, session redemption or unverified artifact parsing.

  Move the dashboard package from its public command to an owned service preset with explicit
  protected static credentials and read-only intent. Preserve native HTTP/cookie/origin behavior,
  registered TLS, exclusive PID custody and private full-launch bootstrap records; publish only
  process initialization and non-secret reference paths. Refuse unsupported user-auth/open/OS
  routes without operator identity or mutation-transport fallback. Hide obsolete cached web commands
  and refuse them with an explicit matching-update remedy before loading code or repairing installs.
  Keep legacy process observations separate and migrate setup, tool hints and dashboard guides.

  Add auth mint --endpoint with closed channels/expiry/private-output inputs and the shared static
  signing-authority checks. Resolve a live digest-verified untargeted synchronous ephemeral surface,
  then use the native agent provisioner for its exact additional command rows and lifecycle footprint.
  Refuse targeted/journaled/action scopes without omitting rows. Publish a create-only non-secret
  issuance intent before native footprint work, block blind replay, preserve private output checks
  and report temporary provisioner close separately. Do not add spawn/run/admin authority, user-auth
  issuance, arbitrary raw-file caller derivation, managed launch or environment-export onboarding.

  Expose exact auth retire grammar with a typed unsupported boundary until a caller-owned native
  serve-gate retirement instrument exists; never borrow manager identity or use host loopback doors
  as a substitute. Prepend native journal reader output-close handling before the binary's global
  EPIPE exit; final stream output and reader cleanup remain observations, not assumptions.

  Show endpoint caller scope in the shared receipt: actual caller/lifecycle, described owner and
  responder, native expiry, explicit channels and bounded command rows with a JSON-preserving
  omission count. Label the local issuance request separately from native provisioning evidence.

  Consume paired native standalone endpoint caller files through registered static targets and saved
  references. Verify signatures against current validated issuer pins, matching user keys/time windows,
  native permission projections and principal tags before broker admission. Retain TLS and private
  snapshots; refuse arbitrary/profile/versioned/targeted/instance/scatter/admin/action authority without
  operator fallback, binding repair or unknown-effect replay. Show public caller binding and described
  file-scope limits in shared reports. Share the local intent contract with issuance and validate
  explicit dashboard credentials against the selected issuer before PID custody or initialization.

  Declare the endpoint watch/session/work and invocation handle paths with closed mode
  inputs and typed unsupported boundaries while native declaration/auth-slot adapters are absent.
  Refuse before broker/file access or subscription, cursor, session, lease, commit or redemption;
  never infer a generic subject, remote execution, verified attenuation or broader caller authority.

  Route one named down target through the existing owned-service stop controller and retain its
  native identity, confirmation, reservation and manager-impact policy. Keep down-labelled finite
  receipts, full-instance selection, offline preview and saved-definition completion. Refuse
  multi-service sets before effects until whole-set preflight exists, reject named agent-reap flags
  with the explicit manager-service remedy, and never fall back to a legacy component PID. Reject
  new receipt/acknowledgement flags on the bare-stack/manifest paths.

  Expose the existing direct endpoint/workflow stream definitions through one pure native config
  factory consumed by bootstrap. Retain creation order, options, retention-floor checks, independent
  ownership census and existing contract/authority hardening; do not add schema mutations or schema
  apply.

  Add a pure conservative diff for that native stream subset. Preserve not-observed, denied,
  not-found-without-authoritative-absence and target-mismatch states; compare only explicit fields,
  retain uninspected defaults and never emit creation/migration actions or enable apply. Add no
  full-space schema observation, authority policy or privileged reconciliation.

  Share native message/registry, contract, authority/session, issued/admission, membership and artifact
  creation inputs with a read-only resource catalog, retaining the existing TTL source, native guards
  and independent inventories. Keep SDK defaults, complete canonical policy, seeds/default delivery
  and reconciliation authority unestablished.

  Add a narrowed native stream-info facade and internal resource observer with structured SDK
  error classification, no message matching, credential substitution or authoritative absence.
  Share declared-field comparison with the endpoint subset; keep native KV/object verification
  required, expose uninspected fields and always disable apply.

  Share native registry seed ordering and profile-default patches with explicit no-write initialization
  definitions. Preserve seed-before-profile precedence and existing explicit delivery classes. Keep
  validation, strict revision observations and guarded application separate; do not infer a profile,
  expose patch bodies in diagnostics or claim legacy seeding gained revision safety.

  Share pure native contract, authority/session, issued/admission and artifact config checks between
  existing creators and schema comparison. Retain the guarded shadow/legacy-cap migrations outside
  readers, never run TTL write canaries during diffing, suppress raw native failure text and distinguish
  uncompared fields, unconfirmed checks and invariant matches from complete canonicality or authority.

  Add bounded read-only initialization observation over an existing selected registry handle. Validate
  native profile/patch inputs before key reads; retain revisions and tombstones and keep missing,
  denied, unavailable, malformed, mismatched and unvisited rows distinct. Preserve private values,
  explicit deadline/non-cancellation and incomplete field-policy labels. No bucket open/create,
  credential fallback, revision-guarded write plan or apply authority is introduced.

  Prepare a read-only existing-static schema inspection adapter with upfront native input validation,
  strict registered root/server/TLS selection, validated current full trust and one native temporary
  provisioner identity. Keep native mode/floor and registry read failures, private observations and
  local reader closure explicit. Do not expose mutation ports, substitute other authority, promote
  reported server metadata to account proof or connect an incomplete apply/public command path.

  Share the existing pure primary/Limits/no-global-eviction authority-store check through core for
  schema inspection and native lifecycle binding. Preserve the auth module's sibling import surface,
  existing checks and error class/text. Move no lifecycle/gate operation, connection, grant or repair
  into core, and keep complete field policy and apply authority separate.

  Attribute the first failed native primary/no-eviction invariant to structured field names from the
  same ordered check. Keep native diagnostic text private to its existing bind error, preserve its
  class/message and avoid parsing or echoing exception strings in schema reports. Field attribution
  is not full canonical policy, current binding, write authority or a completed migration.

  Prepare explicit registered open-mode schema inspection alongside static mode. Select the mode
  before connection, preserve registered TLS, load/mint no open-mode signer or identity and require
  the reported broker authentication mode to match. Keep user-auth unsupported, never retry an auth
  refusal anonymously, and retain private reads and disabled apply without public command wiring.

  Compare extra observed direct-stream fields with the existing first-party baseline, without
  normalizing absent settings from desired values or copying private SDK defaults. Classify
  nondefault undeclared/unmodeled settings as blocked and expose field names without their values.
  Reuse reserved NATS metadata policy; do not add KV/object expansion, full policy or apply.

  Prepare a public-only schema inspection projection and shared terminal view without connecting an
  incomplete public/apply path. Show target/profile, non-atomic resource/key observations, revisions
  and safe policy-field attribution. Omit raw configs, registry/patch contents, unknown field names
  and native diagnostics; retain unproven absence, incomplete policy and disabled apply labels.

  Add one bounded native NATS current-connection identity query and the temporary provisioner's
  self-only `$SYS.REQ.USER.INFO` publish grant, documented in the ownership matrix/profile summary.
  Require matching public user/account/server before static schema reads without system credentials,
  arbitrary-user queries or authority fallback. Ignore response permissions/expiry as ceiling or
  lifecycle evidence and keep apply/absence authority disabled; explicit open does not invent an
  identity. This is prepared source, not a native conformance or deployment claim.

  Compare native store subjects and explicit public KV/object creation options with their documented
  wire fields, including TTL/marker units, storage, history, limits and hardening. Do not fill SDK
  defaults or invoke constructors. Block unexpanded options, expose their count rather than values
  and keep full field/runtime/revision/apply policy separate.

  Compare observed existing registry rows using native seed-before-profile precedence, a closed
  known-field policy and private revision-pinned candidates. Preserve explicit delivery choices,
  block unknown fields and unreadable/deleted/missing rows, and expose only comparison states,
  changed field names and observed revisions. Do not turn a candidate into write authority or
  change legacy seeding; add no guarded application or public stack/update path.

  Bound the resource observer by one shared deadline, preserve unvisited rows and surface the
  budget separately from policy comparison. Deadline expiry is not request cancellation or
  authoritative absence; the caller still owns connection closure.

  Extend observed-extra-field policy to native KV/object backing streams using shared first-party
  baselines and scalar public KV input defaults, not private builders or missing-field filling.
  Retain native artifact direct-read tolerance and valid smaller TTL duplicate windows. Unknown
  or nondefault fields remain blocked, and runtime/full-schema/apply authority stay separate.

  Name only the existing TTL-enforcement, stock legacy artifact-cap and contract-shadow guard
  families in reconciliation reports. Share native constants/hardening fields, block other drift
  and unknown settings, and keep guard-required metadata separate from an accepted migration.
  Inspection runs no canary, state guard, creator, update or readback.

  Route multi-name down through whole-set owned-service selection, process-role preflight, stable
  definition reservations, explicit default-cancel confirmation and complete native-impact recheck
  before the first stop. Keep per-effect native guards, input-order execution and one attributed
  receipt. Stop on failure, retain unattempted members and never claim atomic rollback or cleanup.
  Dry-run imports no provider and reserves/stops nothing; duplicate names and multi-name instance
  selectors refuse. Bare-stack and manifest migration remain separate.

  Include selected-space owned service definitions/instances on the shared status screen and JSON
  result. Keep legacy pidfile rows separately labeled. Show full identities, process observations,
  historical readiness and supervisor-record evidence without endpoint or OS-state promotion;
  unavailable record families make the report partial rather than empty. Read no provider code
  and control no service. Recheck each held definition again immediately before its set-stop effect.

  Keep whole-set reservation/preflight and release errors in the attributed down receipt. Attempt
  all acquired-hold releases without claiming verified lock cleanup or erasing completed stops.
  Owned-service status warnings retain classified cause codes without native diagnostic bodies.

  Share desired native resource creation configurations across the first-party stream baseline,
  public scalar KV defaults, explicit options and hardening. Reject unexpanded inputs and include
  hardening at creation rather than adopting and updating an existing bucket. Keep creation input
  construction separate from mutation authority, existing-store repair and broker-store custody.

  Make up background by default with an explicit --foreground mode and --detach as the accepted
  background spelling. Reject conflicting intent before seed/effects, preserve each recovery
  request's recorded mode, and document the supervising-unit/container migration. This retains
  the native launch path.

  Extend the background-up systemd advisory to the exact native invocation/main PID, naming the
  unit and --foreground remedy without mistaking inherited terminal metadata for main-process
  ownership. Preserve inherited recovery-lock release when new mode validation refuses early.

  Connect setup's explicit start/detach flow after saved preparation. Validate script detachment
  before effects, keep configure-only and default-cancel Start decisions separate, and retain one
  finite setup envelope around the shared native managed-join observer. Local startup uses the
  prepared root and original CLI, pins the follow-on request to its recorded manager and never
  promotes command exit into readiness. Preserve safe failure/request/coordinator coordinates,
  saved preparation and unknown outcomes without retrying, rolling back or replacing a manager.
  Allow self-hosted setup startup to select one manager with --on before preparation writes;
  retain that request in receipts and next-step hints. Local setup retains its own manager
  pin and refuses an external selection.

  Show the resolved mesh in shared rich/plain report headers, including ps and failures,
  without re-resolving selection or changing JSON envelopes. Keep mesh context on live
  watch and history rows and membership snapshots.

  Route named Linux reset space through reviewed native local identity cleanup with
  provider-declared key inventory, full local trust validation, unchanged filesystem scope,
  stopped-custody checks and default-cancel confirmation. Restrict secret and raw deletions
  to the reviewed remaining tree, retain returned per-path receipts on partial/unknown outcomes,
  and remove only the unchanged eligible local registration after checking cleanup. Preserve
  personas, service definitions, packages, account logins and remote data; refuse unsupported
  provider, shared-root, foreign-material, TLS-first, remote and non-Linux targets.

  Add bounded all-new agent and mixed channel/agent team deployment on static/open
  meshes through an attributed, exact-manager native launch path. Persist one full intent
  before effects, create new live channel cards through a separate scoped create-only
  writer, then launch agents through the pinned manager. Sync each channel submission
  and returned revision, each original launch request, each accepted allocation before
  goal following, and each identity-matched joined result before continuing. Match both
  step families before saving the full receipt. Retain unknown phases and partial channel
  creates, allocations and joins without replay or rollback; expose them through team
  show/inventory and keep them behind down/reset custody guards. Refuse user-auth inline
  launch, reapply and unsupported manager/runtime selection rather than reusing the
  unsafe legacy writer.

  Extend the native manager slots read with an explicit bounded name query and optional
  retired rows at cluster revision 30. Preserve default nonretired listing, exact manager
  ownership and ordered slot/head observations so teardown can distinguish native terminal
  and cleanup facts from a stop acknowledgement or a missing live-map row.

  Route static agent-only team removal through the original manager and exact recorded
  incarnations, with native impact preview, default-cancel confirmation, root maintenance
  locking, synced original stop markers and matched retired slot/head plus cleanup receipts.
  Retain partial and unknown per-agent outcomes without replay. Keep original creation and
  removal history, and release only a fully receipt-matched deployment's known additive
  blocker in boot/down/reset/deploy guards. Mixed/channel, open/user-auth and legacy removal
  remain unsupported. Show accepted allocations without joined receipts in human deploy
  output as well as structured output.

  Add explicit static-space online handle signature inspection over native leader-served signer
  and issuer-namespaced revocation records. Reuse one protected file snapshot for verification
  and metadata; check raw signatures, issuer scope, parent links and containment without claiming
  presenter binding, holder currency or use authorization. Require current spec/status pairs and
  explicitly unrevoked sturdy handles, preserve offline unverified output by default, and never
  redeem a handle or persist/print the ephemeral reader credential. Refuse unsupported open/user
  authority instead of substituting a signer; report reader-close uncertainty separately.

  Add the independent executable-endpoint service preset for selected Linux static-auth roots.
  Compile and pin local contracts without handler execution, publish native contract artifacts,
  and register through scoped native serve issuance. Run bounded no-shell JSON handlers with a
  separate fixed argv and empty environment, retaining native schema validation, deadlines,
  process/pipe cleanup uncertainty and no effect replay. Distinguish initialized process evidence
  from current endpoint health, renew through the original issuer, pin native deregistration to
  the original revision, and block reuse of unsettled full local service instances.

  Correct reproduced source-build blockers in native registry-reader construction, protected
  record imports, scoped help validation, optional observations and typed terminal reports.
  Bind initialization reads through the public native KV API rather than private handle fields.

  Avoid creating a control directory or catalog lock for a no-account observation, while keeping
  malformed cache refusals and serialized refresh/application for existing signed-in accounts.

  Create a missing extension config root privately before its first lock so a group-writable
  umask does not make Cotal's own directory block completion installation. Keep existing
  permissions and the completion writer's protected-ancestor refusal unchanged.

  Classify local catalog-preparation cache and missing-login failures as pre-effect refusals,
  not unknown remote operations. Keep cache paths and recovery guidance without parser excerpts
  or cached values, and preserve existing-account refresh/application serialization.

  Point unknown-space refusals at the canonical space inventory instead of a removed command,
  and describe missing registration without claiming that its broker is down.

- 5c85ef3: Add canonical backup restore through the existing guarded restoration and activation path. Return one finite rich, plain or JSON receipt, keep checkpoint progress off JSON stdout, and reconcile connectors as startup does. Restore follows the artifact's selection or an explicit registry-only narrowing, preserves native trust and stopped-cut guards, and never claims per-seat joins. Controller-owned stacks still require their preservation route before they can be restored.
- 5c85ef3: Add `cotal chat [<channel>]`, a live session under its own identity in the terminal view, as `--plain` lines, or as the `--stdio` NDJSON participant protocol. The command resolves the mesh once and admits the session by that target's recorded auth mode only: a routing identity on an open mesh, a manager-admitted session on a static-auth mesh, and an auth-service session under the signed-in person's `cli` grant on a user-auth mesh. It never falls back to another mode. A named channel is the session's initial channel, and on an authenticated mesh its whole read and post list. Before admission the command reads the channel registry on the resolved mesh through the one-shot connection and read `cotal send` uses, and says whether the channel is registered, unregistered or could not be read; it never creates the channel. `--name` sets the display label, which defaults to the OS login and host with a short suffix. The terminal view refuses without a terminal and names `--plain` and `--stdio`; `--stdio` refuses with `--plain`, and the command declares no `--json`. `--kind endpoint` is accepted and changes nothing, since every admission presents the session as an endpoint; `--kind agent` and any other kind refuse as a usage error. `--role`, `--link`, `--token`, `--creds` and `--lifecycle-uid` are declared and refuse as unsupported until an admission supports them. Signals are held from before admission until the front end handles them, so a session admitted during an interrupt is closed at once and keeps the signal's exit status. A session that ends exits 0 when its close was confirmed, 4 when its retirement was requested and not confirmed, and 3 when the outcome is unknown. Completion offers registered spaces and the target mesh's declared channels. The workspace exports `connectTargetOrThrow`, the connect half of `connectOrThrow` for a target the caller already resolved. The flag inventory and the capability census gain the command's rows and the manager's two chat-session commands.
- 5c85ef3: The command line resolves, validates and explains a command before it does anything. A usage error (an unknown command, an unknown flag, a missing value, or a first word a command does not declare as a subcommand) now exits 1 before the built-in connectors are seeded or any configuration is written. Before, every command but help reconciled the connector store first, so a mistyped flag installed the connectors and only then printed the refusal.

  - Bare `cotal` names the selected space, lists the common commands and points a machine with no selected space to `cotal setup`. It starts nothing.
  - `cotal help [command] [subcommand] [--all]` prints the command list or one command's or subcommand's help; `--help` and `-h` print the same. `cotal version` prints the version, as do `--version` and `-V`. Breaking: `-v` no longer prints the version and is refused; it is reserved for `--verbose`.
  - Commands can declare aliases, subcommands with their own aliases, structured outputs and examples. This release adds `sp` (spawn), `a` (attach), `s` (status), `r` (run), `x` (ext), `h` (history) and `cotal ext rm`. A word is never matched by prefix. The registry refuses a name or alias another command already claims, and `cotal ext add` refuses an extension whose name or alias an installed extension claims, naming both.
  - Completion resolves an alias as dispatch does.

- 5c85ef3: `cotal completion` reports which shells have the completion stub: for each shell, whether the stub is installed, whether it matches the script this version prints, the stub file, and where `completion install` wired it in (the startup file holding its install line, or fish's completions directory). `--json` writes the report as one document and `--plain` as plain text. A stub or startup file it cannot read is reported with a warning, and the run is `partial` and exits 4. `cotal completion script <shell>` prints the stub as raw shell code.

  Breaking: `cotal completion <shell>` is replaced by `cotal completion script <shell>`. The old form exits 1 with nothing on stdout, so a hand-written `source <(cotal completion bash)` loads nothing, and names its replacement on stderr. Stubs installed by `cotal completion install` keep working unchanged. See the upgrade notes for the line to write instead.

  A usage error now prints the command's help on stderr with the reason, so a refused command writes nothing on stdout. `completion install` reads an install line only when it is a line of its own, not one that ends in a carriage return, ignores a relative `XDG_CONFIG_HOME`, and refuses PowerShell and unknown shells as usage errors. It reads the startup file before writing anything, so an unreadable one, a missing directory for it or a relative `ZDOTDIR` is refused with nothing changed, and a line it cannot add after writing the stub fails with exit 5, naming the stub. `writeResult` in `@cotal-ai/workspace` can report a partial read.

- 5c85ef3: Add `cotal config` for personal preferences: `harness`, `persona`, `detach-key`, `color` and `editor`. Bare `config` and `config get <key>` show the value each key resolves to, where it came from and the values it outranks; `config set` and `config unset` change your defaults, or your values for one space with `--space` (`harness` and `persona` only). All four forms take `--json` and `--plain`.

  - One resolver decides each key: an explicit flag, the persona's pin, the named variable (`COTAL_DEFAULT_AGENT`, `COTAL_DEFAULT_PERSONA`, `COTAL_DETACH_KEY`, `FORCE_COLOR` then `NO_COLOR`, `VISUAL` then `EDITOR`), your value for the space, your own value, then the default. `spawn` (both paths), `attach`, `personas edit` and color all read through it, so a saved harness reaches a detached spawn as the caller's default and still yields to a persona pin.
  - Preferences are saved in `preferences.json` in the configuration directory, private to their owner and versioned. A write holds a lock, refuses with `CONFLICT` when the file changed after it was read, and replaces the file atomically. A file that does not validate stops every command except help and completion, naming the file; nothing resets it.
  - `@cotal-ai/workspace` exports the preferences store and resolver, and `writeResult` can report a `no-op`.

- 9e5f904: On a controller-owned stack, `down --preserve-state`, `backup create`, `backup restore` and `up --restore` now refuse `UNSUPPORTED` (exit 2) while validating, before the confirmation, the connector seed, any write or any manager request, in every stack mode. The remedy names plain `cotal down`, which keeps the stack's store, channels and history for the next `cotal up`. Preserve, backup and restore of a controller-owned stack return in a later release. A root without a stack journal keeps its preserve, backup and restore.
- 5c85ef3: Record a `process-exit` receipt on a service instance that a generic stop signalled and saw exit. Stack journals accept `preserve` and `resume` operations bound to one maintenance attempt. Restore listener proofs gain a controller variant tied to one broker instance, launch request and pinned process; both bind paths refuse it until controller custody is recorded. Service adapters gain a typed, closed launch-attempt context that no adapter reads yet. Older readers refuse records that carry the new fields.
- 5c85ef3: Maintenance journals can now record controller custody: the cut's original members and their per-role stop receipts, preserved-exit stop attempts, the resume's started members, a private commit-token handoff record (path, inode and digest, never the token), and an alternate-target restore's broker reconfiguration. The readers are closed, so each new field must match the cut's custody. Listener proofs bind only in the variant that matches custody, and a controller proof also needs a live running check from the caller. Stack resume reports `process-exit` evidence when a member carries its own stop receipt. Older readers refuse journals that carry these fields.
- 5c85ef3: `down --preserve-state`, bare `up`, `backup restore` and `up --restore` gain a controller-owned route, described below. This release refuses that preserve, backup and restore before any effect; the route returns in a later release.

  The preserve first runs the scope check bare `down` runs, so another live service instance in the space, a legacy pidfile process or a shared broker address refuses before any effect, and a retry of a committed cut checks again before any further stop. It then proves, with no effect, that the stack's manager instance serves the preserved-exit stop contract; an older manager refuses before any stop. It stops the manager with a preserved-exit request that retains its agents, then auth and the broker, and records each member's own stop receipt in the cut. A preserved manager, and one launched for a resume that has not committed, still answers `status` as a counted read, so the preview and resume readiness can attribute it.

  Bare `up` resumes a ready cut through its recorded members. Each start is journaled before it is made, a member whose earlier launch is unproven holds, and after the manager commits only the manager starts again, once its exit is receipted, with the commit token as a protected file.

  A controller restore keeps the broker definition for the preserved store's own path. For another `--store-dir` it journals and then writes an attempt-owned broker configuration and points the definition at it; the broker starts as a new journaled instance and the cut's old broker record is removed once the restore is active. Rollback returns the definition to the original configuration as a new revision before the store, and any unattributed revision holds. Backup and restore also require the broker configuration to match the cut launch's recorded digest. A settled active controller restore no longer fences controller `down` or `up`, including `up --no-manager`, or the broker and manager services; `down` and `up` name it in their receipts. While any other maintenance journal is held, the manager service launches only a resume or restore attempt's own journaled manager start, as the broker service does, and a broker or manager `service restart` whose start would be refused refuses before it stops anything. `down --preserve-state` and `team boot` still refuse an active restore and now say why: a new cut needs the restore journal retired with `backup cleanup-fallback`, and a team boot never resumes a stack whose manager already ran.

  On a controller root, backup, reset store and reset space count a stack member as running unless its process is gone with its own stop receipt. `@cotal-ai/core` exports `brokerJetStreamBlock`.

- 5c85ef3: Boot fresh static-auth and open manifest environments through the service controller, seed their declared channels, and pin the manifest launch spec to the stack's own manager. Resume an eligible stopped static, open or user-auth stack only from its recorded broker inputs, completed stop evidence and never-attempted manager. User-auth preparation keeps explicit login and grants. Render one receipt without an additive ownership ledger, and support foreground stack lifetime through the guarded native stop path. Keep unresolved attempts blocked. Report a known partially running user stack as partial when the manager is withheld, even when the other members were reused rather than launched by this call.
- 5c85ef3: `cotal endpoint describe --refresh` refuses as unsupported and sends nothing. The CLI keeps no resolved contract between calls, so every describe already resolves and fetches the contracts again and there is no cache for the flag to bypass. The usage lines of `cotal spawn` and `cotal status` write their optional names as `[<persona>]` and `[<agent>]`.

  Breaking: `endpoint describe --refresh` exits with `UNSUPPORTED` instead of running a plain describe. Drop the flag.

- 5c85ef3: Bare `cotal ext` (and `ext list`) writes one structured document with `--json` and a plain report with `--plain`: `result.root` is the install prefix and `result.items` the installed extensions. This replaces one JSON line per extension. `--json` and `--plain` on the other `ext` subcommands are refused with `USAGE_INVALID`, and `ext root` stays a raw path.

  A subcommand can declare its own structured outputs (`Subcommand.outputs` in `@cotal-ai/core`). The kernel reports a form by the 0 to 5 exit table only when that form declares a JSON output, and help prints each form's own `structured output` line, so `ext add`, `ext remove` and `ext seed` keep exiting 1 on any failure.

  Add `cotal docs [<page>]`, the installed version's own protocol and CLI docs, offline: bare `docs` lists the pages, a page prints its Markdown, `--search <query>` shows the best-matching sections, and `--refresh` also tries the version-pinned copy on docs.cotal.ai and says which copy it served. `@cotal-ai/connector-core` exports the docs reads it uses (`docsIndex`, `readDocsPage`, `searchDocs`, `capSection`) through a new `./docs` subpath, so the bundle loads only when `docs` runs.

- 5c85ef3: `cotal history [<channel>]` reads the newest retained messages in the selected space within the identity's read grant, newest last. `--limit` bounds the read (default 50, at most 1000); `--since` (a time, an age or a stream sequence), `--from` and `--grep` filter that window, and `--dms` adds DM history for an identity that may read it. The result names the chat stream's per-sender retention limit and each sender at it, so a short history is never shown as complete, and each channel's replay policy for new members. `--follow` keeps listening; with `--json` it writes one stream record per line, a snapshot, then one event per message, a gap after a reconnect, and an end record. A channel the identity may not read is refused with `PERMISSION_DENIED`, and a part that could not be read makes the run `partial` (exit 4). `history clear` purges the whole selected space after a confirmation, or with `--yes` in a script. Extra channel names and read filters are refused before a purge; `--dms` remains an explicit extension.

  `CotalEndpoint.multiChannelHistory` now also returns each message's stream sequence, `chatRetention()` reports the chat stream's per-sender and age limits with each sender's retained count per channel, and `channelReplayPolicy(channel)` reads a channel's effective replay policy from the registry.

  `--since` rejects ages outside the supported date range and sequences that cannot be represented without rounding, before connecting. They are usage errors, not unknown outcomes or silently rounded cursors.

  `CotalEndpoint.channelHistoryPage` reads a newest window through a lifecycle-pinned, single-channel CHAT consumer. Native user-auth history uses that grant without enrolling the human CLI actor in delivery or publishing an ACL mirror. Concurrent readers wait for broker cleanup within bounded read budgets and never delete the shared consumer by name.

  A connected history read that times out or is cut short reports `OPERATION_FAILED` (exit 5) with its target, not an unknown mutation outcome. Permission and usage refusals keep their existing codes.

- 5c85ef3: The `manager` service preset takes `--roster <file>` and runs with `cotal service start <name> --foreground`. The roster is an absolute path to a file only its owner or root can write. The native manager child parses it before startup and boots its agents at each launch, as `supervise --roster` does; a resumed manager takes none. A foreground manager stops through the same request-bound native stop as `cotal service stop`, keeping its agents, when the CLI receives SIGINT or SIGTERM, and exits 130 or 143.
- 5c85ef3: Deprecate the daemon entries `supervise`, `deliver`, `auth-service` and `feedback-intake`. Each keeps its existing flags for units, scripts and containers written for earlier releases, help and completion no longer list them, and every run prints one stderr line naming its service preset (`manager`, `delivery`, `auth-service`, `feedback-intake`) and the release that removes it, `1.0.0` for all four. `deliver pending` warns the same way and names `cotal pending <agent>`. Stdout, behavior and exit codes are unchanged. The top-level `feedback-intake` entry runs again with its existing flags instead of refusing. `up` now starts its manager, delivery daemon and auth service through hidden twins of `supervise`, `deliver` and `auth-service` with the same flags and runner and no warning, so only a unit, script or container someone can change prints it. The process checks that recognise a running manager or delivery daemon accept the twins' command lines too.

  Background `cotal up` that is the main process of a systemd unit now names that unit and the `--foreground` remedy on every route it takes, including the controller-owned stack and a refresh of a running stack. It still changes no mode and no unit. A foreground run, a dry run and `up -f` print nothing.

  The `solo` container in `deploy/` runs `spawn scout --foreground`. `docs/UPGRADING.md` gains the persisted-caller section: the command mapping, the deprecated entries and their removal release, the literal `up --foreground` replacement for systemd and launchd callers, the owned-unit and downgrade notes, and the container change.

- 5c85ef3: The manager contract moves to revision 33. While preserved, `status.stopImpact` reports the preservation attempt and inventory digest. A preserved-exit stop request names that binding with `withAgents: false`, and the manager accepts it only when fully preserved and quiescent, returning `preserved-exit-returned`. The open-space local receipt keeps its earlier shape. Each serving manager child writes a protected served-contract file before its serving receipt, so a controller can prove which contract that exact instance serves. New launches pass the resume commit token as a protected file named by path and digest; the deprecated `supervise --resume-commit-token` input stays accepted. The native manager child takes only the file form. The broker service admits the maintenance work a controller-custody attempt records, and a controller resume names its broker with `--name`. Core exports `recompileContractClosure`.
- 5c85ef3: Native service stop requests, previews and results can carry a preserved-exit binding (the maintenance attempt and inventory digest) for an agent-retaining manager stop. A preserved request requires `withAgents: false`, its receipts are read against the same key list, and the controller accepts `preserved-exit-returned` only for a preserved request and `returned` only for an ordinary one. No command submits a preserved stop yet, and ordinary stops are unchanged.
- 5c85ef3: `cotal ps`, `cotal models` and `cotal runtimes` write one structured document with `--json` and a plain report with `--plain`, and exit by the structured outcome table. A read that could not read part of what it was asked for, such as a manager that did not answer a census, is `partial` and exits 4, with a warning naming each part it could not read. A mesh a structured command cannot resolve or reach is refused before any request with a stable code (`TARGET_NOT_FOUND`, `TARGET_UNAVAILABLE`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `DEPENDENCY_UNAVAILABLE` and others) and exits 2, and under `--json` that refusal is one envelope. The user-auth provider names why it could not issue credentials (signed out, service unavailable, refused), so that refusal carries the right code. `cotal version --json` with an unreadable extensions manifest is now `partial` and exits 4. A connector's `listModels` can return `unavailable` with a reason when its install has no catalog to list; the manager then reports it `supported: false` instead of a failed read, and OpenCode 2.x does so instead of failing `cotal models`. An installed connector the manager cannot load makes `cotal models` partial with its load error, and a home folder reached through a symlink is no longer read as a project with a stopped mesh.

  Breaking: `cotal ps --json` writes one envelope whose `result.items` are the manager rows, instead of one row per line. An incomplete manager census exits 4 instead of 1, and a mesh `ps` or `models` cannot reach exits 2 instead of 1. The human reports of `ps`, `models` and `runtimes` are tables, and `ps --wide` prints one record per seat. See the upgrade notes.

- 5c85ef3: Read commands no longer install or refresh the built-in connectors and the web dashboard before they run. A command or subcommand declares that it only reads with `reads` (a new optional field on `Command` and `Subcommand` in `@cotal-ai/core`), and the dispatcher skips the seed for it: `status`, `ps`, `who`, `whoami`, `models`, `runtimes`, `history`, `docs`, `endpoints`, `describe`, bare `space` and `space show`, bare `config` and `config get`, and bare `ext`, `ext list` and `ext root`. Installed extension commands keep the declaration through caching and lazy dispatch, including bare reads. Every other command still seeds first, so the first such command after an upgrade refreshes what is installed. The CLI never imports a built-in installed at another version than its own; it names the package and `cotal ext seed` instead. On a fresh machine `status` points at `cotal setup` for the connectors.

  Breaking: a read run right after an install, such as `cotal ext list`, no longer installs the built-ins. Run `cotal ext seed`, `cotal setup` or any command that is not a read. See the upgrade notes.

- 5c85ef3: Reconcile unsettled team removals from original revision-bound card observations and exact native incarnation retirement receipts, without repeating submitted deletes or stops. Bind new card intents to their registry stream, retain superseded or inconclusive members as blockers, and never continue members that were not submitted. Preserve unknown results when original stream or lifecycle evidence is unavailable.
- 5c85ef3: `cotal setup` takes four inputs: the destination (`--destination local|self-hosted`), the application (`--harness`), the project folder (`--project`) and the space (`--space`). On a terminal it asks for each one no flag gave, shows the answers before it writes, and offers Save, Change and Cancel; Cloud is listed as in development and cannot be chosen. Without a terminal, or with `--yes`, `--no-input` or `--json`, every input is a flag and a missing one is `USAGE_INVALID` before anything is written; `--destination cloud` is `UNSUPPORTED`. A local space is prepared as `cotal space create` prepares it; a self-hosted space is one registered here whose root is the project, or one `--connection-file` registers. Setup seeds the default persona into the project's `.cotal/agents`, records the application as the space's `harness` preference, runs that application's own setup actions, and writes one envelope with `--json` listing every file it wrote. A rerun with the same answers is a no-op. An application whose executable is not on PATH leaves the rest saved and exits 4. `--configure-only` is accepted and is the default. `recordPreparedSpace` in `@cotal-ai/workspace` returns the file it wrote, and `meshFile` names a space's registry file.

  Breaking: `cotal setup --yes` without the four inputs is refused, setup sets up one application rather than every detected connector, and a repeat setup no longer prints a status card (`cotal status` reports the same state). See the upgrade notes.

- 5c85ef3: `cotal setup` sets up the runtimes your agents run in. On a terminal it asks which runtimes to set up after the application question: `pty` is built in and always set up, and each official runtime (`tmux`, `cmux`, `orca`, `herdr`) and each installed third-party runtime shows whether it is set up and whether its host tool is on PATH. Installed ones and ones whose tool was found start selected. A script names each runtime with `--runtime <name>`, repeatable; without it a script sets up no runtime beyond `pty`. An unknown name is `USAGE_INVALID` and an official runtime whose host tool is not on PATH is `DEPENDENCY_UNAVAILABLE`, both before anything is written.

  Setup installs each chosen runtime as `cotal ext add` does, at the running cotal's version, then asks its provider whether it answers, as `cotal runtimes` reports. A chosen runtime whose host tool is missing is not installed, and one that does not install or answer leaves the rest saved and the result `partial` (exit 4). Setup never removes a runtime left out; `cotal ext remove` does. `result.runtimes` lists each runtime with its package, its host tool, whether it was chosen and whether setup found it set up, added it or left it out. With `--json` or `--plain` the install progress goes to stderr.

  `cotal ext add` of a `@cotal-ai/*` package named without a version now installs the running cotal's version instead of the registry's newest, which could be a release the binary does not match. A version or tag you name is installed as given.

- 5c85ef3: `cotal space add` and `cotal space forget` register and forget spaces on the structured output contract.

  - `cotal space add <name> --server <url>` registers a space that runs elsewhere, with the trust under `--root`. `cotal space add --file <bundle.json>` registers a user-auth space from a connection bundle, and `--from <https url>` fetches its discovery document on a terminal. Every check runs before anything is written, and each refusal carries its code: `CONFLICT` for a registered name or a broker that enforces another mode, `TARGET_UNAVAILABLE` for a broker that does not answer, `DEPENDENCY_UNAVAILABLE` for missing trust, `UNSUPPORTED` for an address credentials may not cross. On a terminal it shows what it will trust and asks; `--yes` skips that question. It never changes the selection. `--force` replaces only a registration added by hand. With no `--root`, a home folder reached through a symlink is refused like the home folder itself instead of being recorded as the root.
  - `cotal space forget <name>` removes a registration this machine keeps, and keeps the root's files. It refuses a space this machine is running, including one whose controller stack has a member that may still run, and a space a catalog lists. A stack member that is gone without its stop receipt does not block, and the result warns that it was never stopped cleanly. Forgetting the selected space clears the selection.
  - A registration check from `@cotal-ai/workspace` can carry its refusal code, and `preflightCode` is exported.

- 5c85ef3: `cotal space create <name> [--root <dir>]` prepares a space to start on this machine.

  - It records the name and root, and makes `<root>/.cotal/`, so `cotal up` in that root starts the space under that name and drops the prepared record. It starts nothing and keeps the selection. It refuses with `CONFLICT` a name that is registered or prepared, a folder that is already a space's root, and the home folder.
  - `cotal space` lists prepared spaces under their own heading, and `cotal space show`, `cotal use` and `cotal space forget` accept one. `cotal space add` refuses a prepared name.
  - A command that targets a prepared space refuses with `TARGET_UNAVAILABLE`, naming the root to start it in, before anything dials an address. `cotal up --space <name>` from another folder refuses before it writes anything.
  - `@cotal-ai/workspace` keeps prepared spaces in their own store under `~/.cotal/prepared`, apart from the mesh registry, and target resolution reports one with the `not-started` code.

- 5c85ef3: Add `cotal space` and `cotal space show [<name>]`, and put `cotal use` on the structured output contract. `space` lists the registered spaces with each broker's state, server, mode, origin and root, and never dials a discovered space; `space show` gives one in full, the selected one by default, without its credential paths. Both take `--json` and `--plain`, and their rows match `cotal status --json`.

  - `cotal use <space>` selects any registered space without checking its broker, refuses a name that is not registered with `TARGET_NOT_FOUND` (exit 2), reports a repeat as a `no-op`, and bare `cotal use` reports the selection. A selection that names no registration is reported with a `SELECTION_NOT_REGISTERED` warning.
  - A command run without `--space` targets the selection: when its broker is down it refuses with `TARGET_UNAVAILABLE`, and a selection that names a space no longer registered refuses with `TARGET_NOT_FOUND`. Neither falls back to another mesh.
  - `@cotal-ai/workspace` exports `brokerAnswers`, and a `MeshTargetError` for a dangling selection carries `selected: true`.

- 5c85ef3: `cotal status` writes one structured document with `--json` and a plain report with `--plain`, and exits by the structured outcome table. The report keeps its order (this machine, extensions, this folder, the recorded meshes, the selected mesh) and ends with the hints. Only the selected mesh is checked unless `--all` asks for every recorded one, and a part status cannot read is named on its row and makes the run `partial`. That includes a persona catalog, the current-mesh pointer (an empty one included), the mesh registry directory and each of its records: the readable records are still listed. `@cotal-ai/workspace` adds `readMeshRegistry`, `readCurrent` and `MeshRegistryError` for those reads.

  Breaking: bare `status` exits 4 when it could not read part of what it reports, instead of 0. The recorded meshes other than the selected one read `not checked` without `--all`. The report lists no roster, and `--components` is refused with `--json`, `--plain` or `--all`. See the upgrade notes.

- 5c85ef3: Commands share one structured output contract, and every command takes `--no-color` and `--no-input`.

  - `cotal version --json` (or `-j`) writes one JSON document on stdout: `schemaVersion` 1, the command, a `null` target, the outcome, completeness, the result (the version and each installed extension's), and warnings. A usage error under `--json` is one `refused` document with code `USAGE_INVALID` and a remedy, and the help it names stays off stdout. A command with no JSON output refuses `--json` as an unknown option.
  - A command that declares a JSON output exits by its outcome: 0 for ok or no-op, 1 for a usage refusal, 2 for a refusal at a known boundary, 3 when the outcome is unknown, 4 for partial, 5 for failed. An error such a command does not classify is unknown. Other commands keep exiting 1 on any failure.
  - `@cotal-ai/workspace` exports the envelope and NDJSON record types, the stable error codes, the outcome-to-exit table, and `CommandFailure`, which keeps an endpoint's own code and outcome under `error.cause`.
  - `--no-color` turns color off for that run, including the setup prompts and the console, whatever `FORCE_COLOR` says; the programs it starts are no longer forced into color by `FORCE_COLOR`. `--no-input` means no prompt, editor or browser: a prompt behaves as it does without a terminal, `cotal web` prints its link without opening it, and `cotal personas edit` is refused. `--json` implies `--no-input`. Both flags work before the command word, and after it on any command that does not take its words raw. No command may declare either name: an installed extension command that does is an internal error, and `cotal` exits 1 before running any command.
  - `cotal console` now follows a non-empty `NO_COLOR`, as the rest of the CLI does.

- 5c85ef3: A command picks its space the same way in every surface, and says what to do when it cannot.

  - With no `--space`, `--server` or `--creds`, nothing selected and no project in the folder, a command that several running spaces could serve asks which one on a terminal. The answer targets that one run and leaves the selection alone; cancelling exits 0. A script, `--json` and `--no-input` still refuse with `TARGET_AMBIGUOUS`.
  - A refused target, a broker that does not answer and refused credentials carry what to run next in `error.remedy`, apart from `error.message`. The one-line wording elsewhere is unchanged apart from punctuation.
  - `cotal up -f` and `cotal spawn -f` refuse a `--space` that names another space than the manifest's, before anything is written. Before, `--space` replaced the manifest's space.
  - `cotal sync` writes one envelope with `--json` and a plain report with `--plain`. An account whose catalog could not be refreshed is named in a `CATALOG_UNAVAILABLE` warning and makes the result partial (exit 4); when none could be refreshed it refuses with `DEPENDENCY_UNAVAILABLE`.
  - `@cotal-ai/workspace` exports `workspaceErrorParts`, and a `ConnectRefusal` can carry its message and remedy apart.

- 5c85ef3: `@cotal-ai/workspace` adds the shared terminal presentation: one report view model rendered rich (color and state marks) or plain (no ANSI, no marks), tables aligned by display width that become one labeled record per row when the terminal is too narrow, and `writeResult`, which writes one result as the JSON envelope or as its report. `presentationOf` reads `--json` and `--plain` and refuses both at once. Color tokens carry meaning (blue for commands and the selected item, green for done, amber for waiting, red for failed), and a state mark must be accompanied by its word.

  Untrusted text in any report, and every value `oneLine` escapes, now shows bidirectional controls as `\uXXXX` escapes too, so a name cannot reorder what the terminal shows.

- 5c85ef3: Add a read-only auth-provider server preflight and require it before a controller user-auth stack writes state. Validate the first IdP requirement, existing pin and first-enable JWKS through the native provider, without provisioning, pinning or granting authority. Refuse missing or unreachable IdPs with a typed cause and remedy before maintenance or trust creation, and repeat authoritative checks during preparation.
- 5c85ef3: Wire user-mode chat sessions end to end below the command surface. The auth service admits a session per holder hash under the person's own `cli` grant, serves `/chat-session/open`, `/chat-session/bearer` and `/chat-session/retire`, re-checks the session, holder index and pinned grant before and after signing each bearer of at most 900 s, mints the plain agent leaf for a chat principal at connect, and sweeps, retires and compacts sessions. The auth provider implements the three optional chat methods and keeps each session on the route its open resolved; an open may name the IdP and exchange position the caller resolved, and the provider refuses any other. The CLI gains an internal user-mode session factory over a real endpoint.
- 5c85ef3: Add `cotal who` and `cotal whoami`. `who` lists the live roster of the selected space with each participant's status, condition, activity, attention, harness, model and host, and whether a manager runs the seat; `--waiting` keeps rows that are waiting or report a condition and `--all` adds infrastructure endpoints. `whoami` reports the identity the CLI acts under in the selected space and what it may read, post and do, without connecting. Both write one structured document with `--json` and a plain report with `--plain`; a part they could not read makes the run `partial` (exit 4), and a roster the identity may not read is refused with `PERMISSION_DENIED`. `who` watches the roster on every mesh so it can report an unfinished snapshot, a stale roster and a watch error. On a static-auth or user-auth mesh each run's watch consumers stay on the broker for five minutes after it exits. A manager census the identity's grant does not reach, such as a user-auth user's, is labeled with a warning and leaves the run complete.

  For a remote user-auth registration, a cached login remains a login even when the owner and grant cannot be derived on this machine. `whoami` reports the grant as unknown and partial, leaves the owner and principal null, and does not tell that user to sign in again. Human output labels the cached login and its advisory expiry.

  `whoami` also skips dispatcher catalog refresh, so a cached login and an uncached catalog do not make this local identity read contact the IdP.

  Broker addresses in identity reports and shared connection-failure messages omit URL user information, query strings and fragments. Stored connection values and connection behavior are unchanged. An unparseable address is refused by `whoami` without printing it.

  Use a URL placeholder in auth-mismatch recovery instructions rather than a display address with connection data removed.

  Validate display addresses as broker addresses before returning an unchanged value, and escape terminal controls. Preserve bare hosts, IPv6, TLS and WebSocket routes without changing stored or dialed values.

  Classify malformed local registry data as `SCHEMA_INVALID` before any read request, without printing its stored field values. Include the roster suite in the Linux, macOS and Windows platform matrix.

- a9a78ec: Support a genuine auth-local Manager with immutable nonexecuting capability and no Runtime. Add validated public supervise execution mode. NONE refuses model inspection and caller-driven writes, and starts no transcript receiver. Autonomous native control maintenance remains active. Runtime and remote defaults, identity format, authority and managed-seat inventory stay unchanged. Local runtime admission now records identity and capability before later authentication or registration refusal, which can retain those files; malformed records refuse earlier. Invalid supervise arguments refuse before connector seeding.
- 5c85ef3: Add the local persona command family with structured and plain reports, complete agent-file creation, prepared-space catalogs, private editor drafts and conflict-checked local CLI commits. Keep the legacy personas parser available during migration.

### Patch Changes

- 5c85ef3: Make the auth commands agree with each other and classify their refusals.

  - `cotal actor list`, `grant` and `revoke` now resolve their space and root as `cotal auth grants`, `grant` and `revoke` do. With no space to resolve they refuse with `TARGET_NOT_FOUND` instead of assuming `main`, and on a root without the space's user-auth ledger `actor list` refuses with `UNSUPPORTED` instead of reporting no rows.
  - Grant usage is checked before any space or authority is read, under both spellings. A grant or revoke missing `--sub` or `--owner`, or a grant missing an ACL flag without `--full`, refuses with `USAGE_INVALID` (exit 1) and names every missing input in one refusal, where `actor grant` used to end with exit 5 and `auth grant` named one input per run. `actor` also refuses a flag that does not belong to its verb, as `auth` does.
  - `cotal login` against a provider that cannot be reached or stops answering refuses with `DEPENDENCY_UNAVAILABLE` (exit 2) and a `--idp` remedy, instead of printing the raw transport error with exit 1. No session is cached.
  - `cotal doctor auth` reports every credential with no expiry claim as a finding, including an agent credential that `cotal auth mint` wrote without `--expires-in` or `--expires-at`, so that root no longer reads as having no findings. The mint default is unchanged.

- 5c85ef3: Report a targeted stop or attach refused during name resolution as a pre-submission refusal, with the actual responding manager and a remedy. Preserve the inspect error without inventing a native effect outcome; no targeted action was published. Keep failures after submission distinct.
- 5c85ef3: Distinguish a local detach from a terminal session ended by the serving side. Preserve the native end reason through attach and managed spawn, restore the terminal before reporting it, and avoid implying the agent is still running or that a stop completed.
- e9dabc7: `cotal backup` on a broker that hosts several spaces refuses as `CONFLICT` (exit 2) and names the spaces, before any cut preparation. It used to report that preparation did not establish an eligible stopped preserved cut.
- c03f592: Bare `cotal down` on a legacy root now stops the space's service instances through the service controller before it stops the stack, where it used to refuse while any service record existed, a stopped saved service included. Each running instance gets the checks and receipt of `cotal service stop <name> --instance <id> --yes`. An instance already stopped is skipped, and saved definitions stay. Every instance is checked before the first stop: an unreadable record, a retained native attempt, an unsettled request, a process that cannot be observed or a record from another host refuses with nothing stopped, and the remedy names the service and the command to run. `cotal down --dry-run` lists what bare `down` would stop, skip or refuse.
- 5c85ef3: Attribute stream initialization and registration failures to the already-started broker instead of the next unstarted member. Preserve typed JetStream numeric API codes and status without exposing arbitrary broker error descriptions, retrying effects or treating an unknown startup as complete.
- 5c85ef3: Verify the declared broker address against its creation-pinned child's native listener report instead of accepting another host on the same port.
- 5c85ef3: Add a broker service preset for explicitly prepared local configurations, with a direct creation-pinned child, launch-bound native listener reports and a separate exact-process-exit stop receipt. Preserve unknown stops without force-kill or restart.
- 5c85ef3: Keep open broker configuration inside the selected root's control directory even with a custom store. Carry an old journal's explicit existing-store identity through preparation and recheck it before launch instead of recreating a missing path. These checks do not provide atomic protection against an unrelated local process changing the path.
- 5c85ef3: Write the final channel-removal receipt after confirmed terminal steps without copying the attempt-only registry binding into its strict schema. The original intent and observation steps keep that binding. Normal removal and observation-only reconciliation can settle without repeating a delete.
- 5c85ef3: Remove unchanged channel-only deployment cards with revision-conditioned deletes and durable outcome records, while disclosing policy fallback and preserving history, grants and readers.
- 130ae27: `cotal chat --plain` now ends on Ctrl-C, a terminate signal or a hangup, as the CLI reference says: it closes the session once and exits 130, 143 or 129. It used to stop reading input and wait without closing the session. A line typed but not ended is dropped, and a draft waiting for its `y` is reported and not sent. In the terminal view, Ctrl-C and Ctrl-D now work while the recipient picker is open: they leave, or ask first when there is a draft. The picker used to ignore them.
- 5c85ef3: Handle writable output error events as well as failed write callbacks so stdio participant shutdown is not interrupted by an unhandled stream error.
- 5c85ef3: Complete declared flags while the current shell word is `--`. Treat it as an end-of-options marker only after the shell commits that word. Keep aliases, subcommand flag scopes and positional completion. Stop offering options or option values after a committed separator, and stop offering option names as the value of another option.
- 5c85ef3: Start prepared static-auth stacks through recorded service-controller members and stop their exact instances in dependency order with native manager impact and partial-outcome receipts.
- a0d0b89: `cotal down --space <name>` with no service name now refuses with `USAGE_INVALID`, exit 1. Its remedy is a bare `cotal down` from the stack's root, or `cotal service stop <service-name> --space <space>` for one saved service. It used to exit 3 as `OPERATION_UNKNOWN` and point at `cotal down web --space <name>`, which is now a service stop. On a root without a controller stack, `cotal down --yes` now says that `--yes` applies only to a controller stack and that a bare `cotal down` stops this root's stack without it. `--json` and `--plain` on a bare stop say the same in their own refusal. Both still refuse and stop nothing. `cotal ext remove` no longer advises `cotal down <component>` for a running extension process, because a named `down` is a service stop. It names the pid to stop, or the dead process's pidfile to delete. The component-selection code that `down` could no longer reach is removed.
- 01ee17e: `cotal down` with a flag combination it does not accept, such as `--preserve-state --dry-run`, `--preserve-state --with-agents`, `--store-dir` without `--preserve-state`, or `--file` with `--space`, now refuses as a usage error with `USAGE_INVALID`, exit 1, and stops nothing. So does `--session-store` naming a path that cannot be read or is not a directory. `cotal down --preserve-state` in a folder with no recorded stack refuses with `TARGET_NOT_FOUND`, exit 2, and with `TARGET_AMBIGUOUS` when the folder has more than one. Each used to report `Outcome unconfirmed` with `OPERATION_UNKNOWN`, exit 3, although nothing had run.
- b4f985a: `cotal down --dry-run` in a folder with no stack now refuses with `TARGET_NOT_FOUND`, exit 2, and says there is no stack at the folder's root to preview. A root with no `.cotal/` directory, or with no stack registered at it, counts as no stack. It used to refuse with `CONFLICT` and say the local records could not be inspected consistently, which suggested damaged state in a folder that simply held none. A symlinked `.cotal/`, an ambiguous registration and unreadable records still refuse with `CONFLICT`. Source comments in the CLI, delivery and web packages that described per-component `cotal down` stops now describe the stops that exist.
- 5c85ef3: Keep a foreground controller stack alive while it waits for an interrupt, even after startup sockets close. The partial agent-readiness receipt no longer precedes an unintended process exit. Interrupts still use the same guarded whole-stack stop and do not add agent retirement or force killing.
- d079080: Help fits a narrow terminal again. A command's usage line breaks only between options and never between an option and its argument. A usage too wide for the line breaks after its own `|` or compact `|` alternatives first. A group of alternatives too wide for the line takes lines of its own and breaks after its own `|` the same way, so `cotal help send` keeps `--role/-r <role>` together on a 60-column terminal. A compact `|`, such as the one in `<persona.md>|--prompt`, is a break point too: the line ends right after it and no space is added or lost, so `cotal help persona` keeps `--prompt <text>` together on a 40-column terminal. A group that fits, such as `[--json|--plain]`, stays whole. Only a single option with its argument that is wider than the line breaks at its spaces. `cotal help --all` wraps its title and group headings to the terminal. Examples are still never wrapped, so each stays one line to copy.

  A flag whose description would have fewer than 30 columns beside it now has its description on the lines under it. Before, the description stayed beside its flag down to about 22 columns, so `cotal help spawn` wrote lines wider than a 60-column terminal. A report's list of commands, such as a `Next` section, follows the same 30-column rule.

- e0f1384: `cotal up --no-manager` on a legacy stack whose manager is live no longer tells you to run `cotal down manager`, which is now a service stop and refuses. The refusal says this stack has no command that stops only its manager, and names the whole-stack route: `cotal down`, then `cotal up --no-manager --space <space>`. The docs that described per-component stops now say which stack kinds have a manager-only stop, and that a legacy stack has none for its manager, delivery daemon or auth service.
- 5c85ef3: Start a project folder an earlier release created with plain `cotal up` after a normal `down`. A folder with no stack journal that is neither prepared nor registered took the controller route, because an absent prepared root compared equal to the working directory, and then refused with no route back. It now keeps its retained launcher, identity, store and history. A controller `up` checks that the space is prepared or locally started at its root before it writes trust, configuration, a service definition, an instance or the stack journal, so a refusal leaves the folder unchanged and a hand-added registration is a known refusal rather than an unknown outcome. `space create` in a stopped legacy folder names `cotal up` instead of only "another folder".
- 5c85ef3: Validate controller user-auth inputs before the ordinary recovery lock creates maintenance directories. Compare an explicit IdP with the recorded pin even while the broker is running, and refuse conflicts before journal or member refreshes. Repeat the check under the stack lock before preparation.
- 5c85ef3: Follow a managed launch's accepted goal on the caller's authorized class route unless it already selected an instance. Keep the same caller and original goal instead of attempting an unauthorized instance read or resubmitting the launch. Report a native action's missing connector as a proved pre-allocation refusal; post-allocation failures retain their existing outcome rules.
- 3deea9d: Name the mesh before and after more operations. `service stop`, `service restart` and a named service-set stop now begin the impact they show for review with `Mesh: <space>`, as `down` does. The `space delete` and `reset space` previews, the manager gate repair review, the foreground notices of `up`, `team boot` and `service start`, the attach picker's partial-list notice and setup's agent-joined notice name the mesh too. A classified failure raised after a command resolved its space now carries that space in `target.space` and begins with `Mesh: <space>`, even when the failing step named no space. A target that already names a space is kept as it is.
- 5c85ef3: Show the mesh name on more refusals. A `send` refused for an absent or ambiguous recipient or mention now begins with `Mesh: <space>`, and its JSON envelope carries `target.space`. `history clear` now declares its JSON and plain output, so `history clear --dry-run` on a space that is prepared but not started is a standard `TARGET_UNAVAILABLE` refusal with exit 2 and a JSON envelope, where it printed one line and exited 1. The CLI docs and upgrade notes now show `history clear --yes` and `--dry-run` in place of the removed `--force`.
- 5c85ef3: Exclude the native status request's own completed admission from service-stop impact while retaining all other pending work, and use the existing lower control tier for retained-team reads.
- 5c85ef3: Refuse --no-manager on a controller stack whose manager is still running, before changing its journal or any member. Keep the manager's original identity and state rather than silently returning a no-op that labels it unattempted.
- 5c85ef3: Start every npm child of `cotal update`, `cotal ext add` and setup's global install with 022 added to the process umask, and create a missing extension prefix with mode 0755 and its package.json with mode 0644. Under a umask of 0002, npm made group-writable directories, files and bin targets, and its own `--umask` setting still left package directories and bin targets group-writable. A stricter umask keeps its bits, and the previous umask is restored as soon as each spawn call returns.
- 5c85ef3: Write generated open-mode broker configuration with private permissions so controller startup does not reject it under a group-writable umask.
- 5c85ef3: Add the native routing-only open chat adapter with fresh per-opening identity and guarded own-inbox cleanup.
- 5c85ef3: Compose prepared open stacks without delivery credentials, use request-bound child-local manager observations with explicit evidence labels, and compose static mixed-team removal as native agent retirement followed by revision-conditioned channel-card removal.
- 5c85ef3: Create local space control directories privately, refuse unprotected project paths before recording preparation, and honor JSON/plain output for classified stack-start errors.
- 5c85ef3: `cotal up` writes the authenticated broker configuration `server.conf` owner-private (0600), and creates `.cotal` and the broker store owner-private (0700), whatever the umask. Under a group-writable umask the stack's own broker preset no longer refuses the files `up` just made. The broker, auth service and delivery logs are created 0600, and the pid, identity pin and manager marker records `up` writes are created 0600. A private file written in place, through `writeSecretFile` or the new `openPrivateAppend`, is never opened through a symlink: on POSIX a symlink, a non-regular file or a file another user owns is refused with `EPERM` and left unchanged, and a file the user owns is set to 0600 through the descriptor before it is truncated or appended to. Windows keeps a mode-0600 open with no owner check, and its ACL hardening is unchanged. A refused service path now names the option, the path that failed, and its owner and mode, and a group-writable ancestor is named instead of the path below it. The text failure report shows a wrapped cause's detail as one line. The whole-stack failure hints name `cotal service --space <space>`, which lists every member with no definition name needed, in place of a bare `cotal service status`.
- 5c85ef3: The detached manager opens its log, which carries the console URL, through `openPrivateAppend`. A symlink planted at the log name is refused instead of receiving the URL and having its target set to 0600 by path. An earlier version's log the user owns is still set to 0600, now through the open descriptor.
- 5c85ef3: The broker preset's readiness check sets nats-server's ports report to 0600 before reading it. nats-server writes that report under the umask it inherited, so a group-writable umask left it 0664 in the private launch directory. The change goes through a descriptor that follows no symlink and applies only to a regular file the user owns.
- 5c85ef3: Process records never write through a symlink. `@cotal-ai/core` adds `writePrivateRecord` and `createPrivateRecord`, which take `writeSecretFile`'s private open without its Windows ACL step. The manager's delivery-aware marker and a pid identity pin are rewritten with `writePrivateRecord`, so a symlink at either name is refused with `EPERM` and left unchanged. The pid, pin and bridge temporaries `writePidPair` publishes are created with `createPrivateRecord`, exclusively and owner-private, and only the temporaries a call created are removed afterwards.
- 0e40d19: Files written in place under `~/.cotal` or a project's `.cotal` are no longer written through a symlink. The manager's own delivery-aware marker, the `agent-bearer` health file, the onboarding marker, the `setup` log and personas, the web session file and detached log, the feedback store, persona files saved by `saveAgentFile`, the seat custody record, payload, exit record and log, the Claude seat home and plugin marketplace, the Codex host log, the Jcode launch record, the `ext` extensions prefix `package.json`, and the isolated broker's config rewrite and watchdog now refuse a symlink and leave it unchanged. A file rewritten in place is set to `0600` through the open file. `hardenPrivate` on a file now uses the same no-follow descriptor. A directory is still hardened to `0700` by its path, so a symlinked `~/.cotal` or `.cotal` is not refused there. The manager and native service custody no longer chmod their pid records by path, since those are created `0600`. The broker ports report refusal names the report's path, and a failed close no longer hides it.
- 5c85ef3: Expose the recorded process stop receipt in service stop and status results so callers can distinguish a signal-and-exit observation from an already-gone process.
- 5c85ef3: Verify identical retained agent and mixed deployments as no-ops against their original manager and incarnations, with explicit old-policy drift waivers and no restart, adoption or uncertain replay.
- 5c85ef3: Verify an identical settled channel-only deployment as a no-op using its original target, receipt and leader-served create revisions. Reuse its deployment ID without creating another intent, issuing a channel writer or adopting drifted cards.
- 5c85ef3: Make owned services and target selection recoverable and honest. A service start refused before its process exists, such as a manager preset for a space that is prepared and not started, now refuses under the target's own code and records the instance as failed with no process, so a later start, stop, removal or `down` is not blocked by it. Ctrl-D or a closed input at a service confirmation is a clean cancel instead of exit 13 with Node's unsettled-await warning. A project root with no registration whose stack journal recorded a broker is refused as not started and names that broker, so reads such as `whoami`, `ps`, `who` and `endpoints` never dial the default address there; `status` and `status --components` select no space for an unregistered root. Bare `use` no longer runs the connector seed. `service` with no space names `--space` in a separate remedy. Preset help marks required options and path placeholders, a missing required option or preset is named, and schema, path and space mismatches name the field or option. Service stop, restart and `down` report a no-op plainly, skip a confirmation that would stop nothing, name the dependants that block a stack stop, and preview a refused stop with `--dry-run`. `service add` names its next steps. Setup checks `--harness` against the official connectors when none is installed and names a seed step that can run from the binary. The service reference in docs/cli.md now matches the shipped command.
- 5c85ef3: Preserve typed adapter planning refusals and their cause and remedy before child launch instead of hiding them as generic process failures.
- 5c85ef3: Use the controller stack's recorded broker address when restarting after a completed down without --server. Keep explicit address changes subject to the existing journal conflict check.
- 5c85ef3: Add static-mode chat session admission. A static manager serves `chat-session-open` and `chat-session-retire` (cluster revision 34): it draws a `chat_` alias and a fresh nkey identity, provisions the session over the native static activation with a spawn's three channel lists under a spawn's rules, and mints an agent-profile leaf with no role, capabilities, endpoint rows or issuance, expiring within 900 seconds with no renewal. The manager writes the leaf's credential ledger row itself before it leaves the process. The reply carries no credential in the clear: the leaf is sealed to a one-time curve key the caller sends as `sealTo`, bound to the space, the admitting instance and the reply's fields, so a generic invoke, an agent or a browser sees only ciphertext. Retirement runs the static terminal and refuses any alias, instance, uid or actor it did not admit. It marks the credential's ledger row revoked and verifies that the session's principal has no live connection, but a static mesh cannot revoke the leaf itself, so a copy of it still connects until its expiry. The admitting manager retires each session it admitted at that expiry when nothing retired it sooner, retires every session it still holds when it stops without preserving its state, and its startup sweep leaves alone a session it is admitting or holds. Only operator instruments carry the two command rows. An ordinary spawn now refuses names that start with `chat_`. The workspace exports `mintControlInstrument`, which mints a control-caller instrument for a target the caller already resolved. Core adds `sealJson`, `SealRecipient` and `isCurvePublicKey`, one-time sealing over the existing NATS curve keys. The CLI gains the static chat adapter, which opens the sealed reply once and checks every bound field, keeps the leaf in memory, mints every manager call from the target it was opened on, and retires at the admitting manager instance. The CI suite list gains the two new smokes.
- 5c85ef3: Allow ordinary shutdown of a legacy stack after its restore has reached the validated active state for the registered space. Keep pending maintenance transitions, mismatched spaces and all existing root, ownership, sharing and native process guards blocked. Shutdown preserves the restore journal and fallback store.
- 5c85ef3: Classify contradictory up authentication flags as usage refusals with a remedy before project lookup or preparation. Do not report an unknown operation when --user-auth conflicts with --open or --idp is supplied without user auth.
- 0f1a8b6: `cotal up -f` with a manifest whose runtime is installed but not reachable now refuses with `DEPENDENCY_UNAVAILABLE`, exit 2, and says no broker was started. It used to report `Outcome unconfirmed` with `OPERATION_UNKNOWN`, exit 3, although nothing had started.
- 5c85ef3: Refuse conflicting up output and manager-only options as classified usage errors before preparing a project or taking a maintenance lock. Do not leave a new control directory or stale lock when --json/--plain conflict or --no-manager is paired with --runtime or --max-sessions.
- 3beedb8: `cotal up --runtime <name>` refuses a runtime with no installed provider, or one whose provider does not answer, as `DEPENDENCY_UNAVAILABLE` (exit 2) before anything is written or started. For a known runtime the remedy names the `cotal ext add <pkg>` to run. A controller stack used to start its broker and delivery first, then report only that the manager exited before readiness.
- de08d27: `cotal up --space <name>` now refuses with `TARGET_UNAVAILABLE`, exit 2, when that space was prepared in another folder, and with `CONFLICT`, exit 2, in a folder that is already another space's root. Both refusals used to exit 3 as `OPERATION_UNKNOWN`, although neither changes anything. The message names the root, and `error.remedy` gives the next step.
- 5d5a2ab: Make usage errors and prompts behave as documented. Every CLI question, including the typed-name confirmation of `space delete`, the `--plain` removal questions of `channel remove` and `persona remove`, and the `manager` and `login` questions, now treats Ctrl-D on an empty line or a closed input as the cancel Ctrl-C gives, instead of hanging or exiting 13 with Node's unsettled-await warning. `up` refuses an invalid `--max-sessions`, `--max-file-store` or `--restore-only` value, and a restore flag combination it cannot run, as a usage error before anything runs instead of an unconfirmed outcome. `--json`, `-j` and `--plain` may come before the command word, and a leading `--` ends the leading flags. A command that takes its words raw refuses them there. A usage refusal from a command's own checks, from `clean` and from `help` with an unknown subcommand prints the error, its remedy and the command's help, like the parser's own usage errors. `space delete` names a prepared space that is not running and how to start or forget it, its dry run exits 0 when it reads its whole scope, `space forget` no longer calls a stopped space never started, and the `-y` help reads correctly for delete.
- 5c85ef3: Terminal output reads cleanly at any width.

  - On a terminal, long report values and lines, warnings and failures wrap at spaces, each continuation line under the text it continues; a word wider than the line, such as a path, is never split. Output to a pipe or a file is not wrapped.
  - Help, the command list and the entry screen wrap the same way. A usage line breaks only between options, and when the flag names leave their descriptions fewer than 30 columns, each description goes on the lines under its flag.
  - `--plain` writes punctuation in ASCII: `·` and long dashes as `-`, `…` as `...`, `→` and `↳` as `->`, and `§` as `section`. A partial result's line starts with `!`.
  - A table too narrow for the terminal becomes one record per row whose labels are lowercase like every other report's, and a field the row leaves empty is left out. `ps --wide` labels its records the same way.
  - `history --follow` wraps each new message to the terminal, as the window above it is.
  - The `status` membership feed row says how long ago the feed was updated instead of printing its ISO time; `--json` keeps the time.
  - `cotal completion` fills every cell: a shell with no install line says `not wired in`, and PowerShell's file says `none`.
  - The help for `--on` and `ps --slots` says what they do in plain words.

- 5c85ef3: A broker-refused manager call no longer claims a cause the broker did not report. It keeps the refused subject, instance and not-executed outcome. On a user-auth mesh a refused ps or slots read adds the documented admin-scope requirement and points to cotal auth grants. Grants, routing and the refusal itself are unchanged.
- 5c85ef3: Compose prepared plain-loopback user-auth stacks through the existing native auth service, provider readiness and delivery authority. Report first-enable manager startup as a known partial result until the user signs in and is granted; never substitute a static caller. Keep original stack mode, address, exact service instances and unknown-operation holds.
- cb1b5d5: A direct message to an agent the roster shows offline now says so, and says what happens next: the
  message is stored and delivered when that agent reconnects, and a new agent spawned under the same
  name does not receive it. `cotal_dm` adds the notice to its answer, `cotal send -t` prints it as a
  `RECIPIENT_OFFLINE` warning, `cotal chat` adds it to the view and carries `recipientStatusAtSend` in
  its `--stdio` stored result, and `cotal join` and the console print it after the send.
- b30c66b: `cotal doctor auth` without `--space` on a root that holds several spaces refuses with `TARGET_AMBIGUOUS` (exit 2), names the spaces and asks for `--space`. It no longer reports that root's valid inventory as `SCHEMA_INVALID`.
- 9b320fe: Keep a foreground broker outside the terminal's interrupt process group on POSIX. Ctrl-C now reaches the CLI owner first, so it can finish the guarded manager and delivery shutdown before signalling the broker.
- 5c85ef3: Record managed-grant custody and serialize ledger reads, decisions and writes in one synchronous transaction. Bind conditional revocation to the lifecycle and custodian, preserve legacy row reads without adopting them, and define the lease-first optional retirement-only composition. Full recovery authority is not enabled.
- cddf871: Report a manager refusal that happened before anything ran as a refusal. The manager now marks its control refusals `not-executed` when it can show no effect started: admission and permission refusals, a stale target, input or attach into an agent that was replaced or is not running, a runtime with no input, and a spawn or launch refused before the name reserve or a launch file write, such as a missing persona. `cotal spawn --detach`, `stop`, `input` and `attach` then report `refused` with exit 2 and print the manager's reason on one line, naming the agent. A failure after an effect may have started, such as a terminal write the runtime rejected, stays `unknown` with exit 3 and now shows the manager's reason too. A user-mode `ps` or `slots` read the manager refused itself keeps its own reason and no longer gets the admin-scope hint meant for a broker refusal.
- 28ae779: Deliver incoming local-mesh messages through Claude Code's native plugin hooks, including supported Desktop Code sessions, without special launch flags. Surface busy notifications at a main-conversation boundary instead of waiting for the whole turn. Preserve plugin attribution, respect native Stop, and reoffer unread wakes when the local reader restarts. Idle wake notifications display as a compact, expandable Cotal indicator. Setup can use Desktop's bundled Code executable and records Node's absolute path so the app needs neither a separate terminal CLI nor Node on its PATH.

  Refresh existing Claude messaging and skills plugin registrations during updates and ordinary first use after an npm upgrade. Preserve disabled settings and check the resolved payload rather than only the marketplace copy. A missing native runtime refuses the upgrade without accepting a stale generation. Allow an update after configure-only setup when the local project has no manager or broker running. Use provider readiness through the public setup entrypoint, including Desktop-only installations. Probe native executables only at an explicit availability or action boundary, with bounded timeouts, so a broken unrelated Claude command does not block connector registration, seeding or another harness's setup. Report a partial setup if the selected harness loses readiness before an action, rather than silently skipping it.

- 0e7734e: A channel `cotal send` on a static or open mesh no longer leaves a channel-registry consumer on the broker for five minutes. Its channel-policy read now uses one Direct Get, as the transient endpoint and `cotal channel` already do. A user-auth send keeps its scan, because a user bearer has no Direct Get row.
- 5263954: Prepare or start another space without running `cotal setup` again.

  - `cotal space create` and an `up` that starts or refreshes a local space write the `default` persona into the space's `.cotal/agents` when it has none, as setup does. A persona you edited is left as it is. `space create --json` and a controller `up --json` list the write under `result.written`.
  - `cotal setup` also saves the application as your own `harness` preference when you have none, so a space you prepare later uses it. A value you already set stays.
  - With the default persona missing, `cotal status`, `cotal spawn` and `cotal app-identity` name the command that writes it: `cotal up` in the root of a space this machine started, or `cotal persona create default` for any other space. An invalid default points to `cotal persona show default`.
  - The `cotal space` listing suggests `cotal space create` and `cotal space add` for another space.
  - `cotal up` with no `--space` in the folder of a running open space runs that space again. It used to resolve the default space and refuse. A folder whose stack and registrations name several spaces refuses with `CONFLICT` and asks for `--space`. The refusal for another space in a space's own folder names `cotal up --space <name>` instead of telling you to drop a flag.

- 5c85ef3: Redact broker URL secrets in status reports and component facts without changing saved connection values. Report unsafe stored display addresses as unknown.
- 33a40d5: Name the account of a space catalog that failed to refresh in the default `cotal status` report. `status --verbose` still lists every signed-in account with its refresh state.
- e95cca8: `cotal status` reports the dashboard as installed when an installed extension provides the `web` service preset. It looked for the retired `web` command, so it said `not installed` even after `cotal ext add @cotal-ai/web`.
- 964aaea: `cotal status` and `cotal status --components` read a service-run dashboard's address from its own session record. A dashboard started with `cotal service start` writes that record beside its service startup receipt and never writes `web.session`, so status found no bound address and graded a live dashboard `refused`. The holder of `web.pid` now picks the record: the web service instance whose recorded process is that PID names its own session record, and any other holder is read from `web.session`. Neither record is read in place of the other. The components row names the instance as `service instance <id>`.
- c550cf3: Read and write Cotal's local records on Windows, so `cotal up`, `status` and `down` run there. Local records such as the stack journal, service records and deployment attempts now use the access-list model Cotal already uses for private files on Windows. A store directory Cotal creates gets the private access list, and a record is written like a private secret. Reading a record or checking its path there does not check a POSIX owner or mode and does not refuse a link: a symlink or junction is followed. Size limits, the record schema, the regular-file check and the refusal of a link inside a record store's own directories still apply. On Windows, `cotal ext add` and the setup seed now record a service receipt, `cotal status` reads the deployment-attempt inventory, the `down --dry-run` and `team deploy` previews read their records, and `cotal ext remove` accepts the service namespace without a POSIX owner. Starting a process service there still refuses, because the process driver needs Linux machine and boot identity. Linux and macOS are unchanged.
- 1eacf50: `cotal setup` and `cotal ext seed` work on Windows again. Adding an extension that declares service adapters or presets, such as the web dashboard, read its package metadata through protected file access, which Windows does not have in this release, so the seed refused `UNSUPPORTED` and no connector was set up. On Windows such an extension is now added with no service receipt, `ext add` says that its services cannot run on this platform, and any use of those services refuses `UNSUPPORTED`. Linux and macOS are unchanged.
- 5c85ef3: Accept group write on a protected directory, or on a declared service adapter path, when the account database proves the group is the caller's user private group, the Debian and Ubuntu default under umask 0002. On Linux, `getent` must show that the group is the caller's primary group, lists no other member and is no other account's primary group, and `getfacl` must show no extended ACL on the entry. The account list counts only when `/etc/nsswitch.conf` names `files` and `systemd` alone for passwd and group, so a directory source such as LDAP or SSSD refuses. Each read is bounded, and only a proven group is remembered for the life of the process. World write, a foreign owner, a symlink, an extended ACL and an unavailable proof still refuse, and a credential file stays owner-only. A refusal now names the offending path, the reason and a `chmod` remedy, and says what kind of path was checked instead of calling every path a credential reference. The installer sets `umask 022` before it creates anything.
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [d079080]
- Updated dependencies [5c85ef3]
- Updated dependencies [3deea9d]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [0e40d19]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5d5a2ab]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [5c85ef3]
- Updated dependencies [ef78ab0]
- Updated dependencies [a263632]
- Updated dependencies [5c85ef3]
- Updated dependencies [28ae779]
- Updated dependencies [bb14d28]
- Updated dependencies [15c96da]
- Updated dependencies [964aaea]
- Updated dependencies [c550cf3]
- Updated dependencies [1eacf50]
- Updated dependencies [5c85ef3]
  - @cotal-ai/core@0.91.0
  - @cotal-ai/workspace@0.91.0

## 0.90.1

### Patch Changes

- @cotal-ai/core@0.90.1
- @cotal-ai/workspace@0.90.1

## 0.90.0

### Patch Changes

- Updated dependencies [88ab21e]
- Updated dependencies [b928aaa]
  - @cotal-ai/core@0.90.0
  - @cotal-ai/workspace@0.90.0

## 0.89.0

### Patch Changes

- 504be1d: Render a broker's TLS mismatch as a concise join refusal with operator guidance instead of a raw connection stack. Keep the TLS requirement and refuse plaintext connections.
- Updated dependencies [dc458a4]
- Updated dependencies [bab4ca8]
- Updated dependencies [2905ae9]
  - @cotal-ai/core@0.89.0
  - @cotal-ai/workspace@0.89.0

## 0.88.0

### Minor Changes

- 8e7a71c: Allow harness-less interactive joins on required-events spaces using the signed-in cli actor and native bearer renewal. Keep required event publishing on harness-hosting launches and preserve user-auth credential and channel boundaries.

### Patch Changes

- Updated dependencies [fc923a5]
- Updated dependencies [cb09213]
- Updated dependencies [a3ae00f]
  - @cotal-ai/workspace@0.88.0
  - @cotal-ai/core@0.88.0

## 0.87.0

### Patch Changes

- d83f478: A `cotal` command started with a few hundred KB of argv, such as `cotal send dm <name> "<480 KB text>"`, no longer exits 13 before it runs. The CLI loaded Ink and its wasm layout engine at startup for every command, and on macOS that engine's init never finished with an argv that large. Ink and the console UI now load only when `cotal console` runs.
- 6b1e309: `cotal join` under a provisioned credential now prints each channel post once. Such a join holds a durable delivery backstop for its channel, so every post reached it twice under the same message id, once on the live channel subscription and once from the backstop, and the join printed both. It now deduplicates by message id as the protocol requires of a receiver, acks the second copy, and never treats an empty id as a key.
- 70aa27b: A repair `cotal up` after a crash now restores the manager and the delivery daemon in one run. A
  manager or delivery daemon that is killed, or a daemon that exits because its broker went away,
  cannot release its lease, and a replacement started inside the lease TTL used to lose the create and
  make `up` exit 1. The new manager now waits out a lease row that names its workspace root and a pid
  that is not running on the host, and `up` waits out a delivery lease held by the credential the
  folder gave its previous daemon while no daemon is recorded running. The wait never writes the
  lease: a row that is written again during it has a live holder and is refused, and a row held by
  anyone else is refused at once as before.
- e6bb48f: `cotal send`, `cotal endpoints`, `cotal personas list --running`, `cotal channels list` and the name check in `cotal spawn` no longer leave consumers on the broker. Each one opened a transient endpoint that watched the presence bucket and the channel registry, and the operator credential cannot delete those consumers, so every command left one consumer on each bucket for five minutes. Five shells sending in a loop reached the broker's limit of 1000 consumers per stream, and further sends failed with `maximum consumers limit reached`. With a static or open-mesh credential the transient endpoint now reads both buckets once with a batched Direct Get and binds no consumer. `cotal channels list` reads the registry the same way through the new `directGet` option of `readChannelRegistry`. `@cotal-ai/core` adds the `readOnce` endpoint option and `lastKvEntries`, and the `operator` profile gains the Direct Get row on both buckets. On a user-auth mesh these commands still run on the user's bearer and keep their consumers.
- Updated dependencies [e84b6c6]
- Updated dependencies [c06cf5b]
- Updated dependencies [af82e8d]
- Updated dependencies [0f92fa4]
- Updated dependencies [5d686ff]
- Updated dependencies [970bf2d]
- Updated dependencies [9755079]
- Updated dependencies [70aa27b]
- Updated dependencies [e6bb48f]
  - @cotal-ai/core@0.87.0
  - @cotal-ai/workspace@0.87.0

## 0.86.0

### Minor Changes

- 31dccc4: A Claude app conversation can join a local mesh. `serveGatewayStdio(host, options)` in `@cotal-ai/connector-core` serves the remote gateway's tools over stdio, so a local MCP server offers the same `cotal_connect`, `cotal_wait` and routed tools as the hosted connector without importing an MCP SDK. The hidden `cotal app-identity` plumbing command opens one conversation's own identity on the selected mesh: it answers `taken` for a live name, takes its channels and role from the mesh's default persona, provisions the identity's own delivery durables on a mesh with static credentials, and writes the credential to a 0600 file that never appears on stdout. `cotal app-identity retire --dir` removes the identity's broker footprint and then that file, and each provision retires what a host that exited without retiring left behind. A mesh that uses per-user sign-in is refused. The Claude Code plugin's server now serves those tools to a session Cotal did not launch, in place of `cotal_how_to_join`, and joins only when the conversation calls `cotal_connect`. `cotal setup` records the CLI's own argv beside the plugin, so that server runs the CLI by absolute path; a connector's install action receives it as `ConnectorSetupInput` from `@cotal-ai/core`. Started with `--desktop`, the same server suits Claude Desktop, whose working directory is no project. Without `--space`, provision sweeps the registry first, as `cotal spawn` does, so a recorded mesh whose broker is down no longer makes the choice ambiguous. A conversation in a Claude Code session is woken when a message arrives: the plugin declares a monitor, each local server writes the connection id of each wake to a private socket of its own, and the monitor turns each valid id into a fixed event line, so no socket text reaches the model. `GatewayOptions.wake` in `@cotal-ai/connector-core` is the hook for this: it signals a connection once until it is read, never while a `cotal_wait` holds it, and again when a client starts listening, and `cotal_connect` says whether the client will be woken. `GATEWAY_INSTRUCTIONS` now tells a conversation how to keep listening when asked, and is exported in two parts, `GATEWAY_CONNECTING` and `GATEWAY_LISTENING`. Claude Code runs the `cotal` plugin in place from the copy `cotal setup` materializes under `~/.cotal/claude-plugin`, and before this change neither a repeat `cotal setup` nor `cotal update` rewrote that copy, so after an upgrade plain sessions kept starting the old server, hooks and monitor. A setup provider can now declare `refresh` (`ConnectorSetupProvider.refresh` in `@cotal-ai/core`), which brings what it installed to this release and installs nothing new; a repeat `cotal setup` and `cotal update` run it, and `cotal update` fails when the refresh fails. The copy's version is now the release plus a digest of its files, and `cotal status` reports the plugin as current or stale against it, in place of only whether it is installed. `cotal setup` always runs `claude plugin marketplace update` after adding the marketplace, since Claude Code 2.1.295 answers a repeat add with wording the old check did not match. On macOS and Windows, where Claude Desktop is installed, `cotal setup` adds a `cotal` server to Desktop's `claude_desktop_config.json` that runs the same server with `--desktop`, keeps every other entry, refuses a file that is not valid JSON, and the refresh keeps the entry current; `cotal status` reports it.

### Patch Changes

- 1dd5baf: A control command run without `--space` now probes the registered brokers once per resolve. Before this, the control resolver probed every non-catalog record for its mode check, and the connect helper probed them all again before it chose the target; `cotal update`'s manager continuity check added a third round of probes. Each round could wait out the confirming timeout on a record that did not answer, and a broker that started or stopped between rounds could leave the mode check and the connect resolving different targets. `ConnectFlags` now carries the sweep's `offline` set, and `resolveControlTarget`, `resolveTargetOrThrow`, `connectOrThrow`, `connectUserControlOrThrow` and their exiting forms read it instead of sweeping again. A named `--space` still skips the sweep.
- 990148a: Keep the manager's delivery-aware marker, shutdown intent and spare capability when `cotal down` does not stop every selected component. The manager stop no longer removes them itself: `down` removes them after its all-stopped gate, and the `cotal up` teardowns and the delivery cutover preflight remove them after their own stop.
- 24212bc: `cotal backup create`, restore and quarantine now fail after 15 seconds when their isolated bootstrap broker stays alive but never accepts connections. The reachability wait recomputed its bound on every pass, so only the 30-minute operation deadline ended it.
- 8d97d8a: Callers can name a manager instance wherever a user-auth mesh with several live managers for one owner asks them to. `cotal models` and every hosted `cotal run` verb take `--on <instance>`, and MCP `cotal_run` and `cotal_personas` take an `instance` argument under the same rules as `cotal_spawn`'s. A `cotal` command run from a managed seat's shell now selects the manager that launched the seat (`COTAL_MANAGER_INSTANCE`), as the seat's tools already did, unless `--on` names another. The ambiguity refusal still refuses, and now lists the owner's live manager instance ids and names the caller's own remedy: `--on <instanceId>` for the CLI, the `instance` argument for an agent's tools. Before, it named `--manager-instance`, which only `cotal agent-bearer` takes, so none of these callers could answer it.
- 958e6cb: `cotal_roster`, `cotal ps`, `cotal status`, `cotal endpoints`, `cotal console` and `cotal join` print each peer's condition code and activity on one line and at most 200 characters. A control character or Unicode line separator shows as a `\uXXXX` escape, so a peer can no longer split its row into what reads as a second roster entry, pass terminal control bytes through, or flood every row with a 4000-character activity. The rule is `presenceText` in `@cotal-ai/core`, and `oneLine` moved there from `@cotal-ai/workspace`, which still re-exports it.
- ee42687: The seed reconcile reads a built-in's `package.json` once per check. `installedExtensionPackage` returns the installed version and declared `main` from that one read, with the error policy `installedExtensionVersion` already had, and the entry-file check takes `main` from it. The check used to parse the file a second time and treat any failure of that read as a missing entry file, so a permission error there made `cotal ext seed --repair` silently reinstall the built-in, or report a torn install while the entry file existed. A read failure now surfaces as the error it is.
- d4a745f: Smoke comments and check labels in core, cli and manager name the function, branch or SPEC section they point at instead of a line number that drifts with every edit above it. No behavior changes.
- d5103e3: `cotal up` proves a surviving restore or ordinary-resume listener with one shared check. The two attempt kinds used to carry separate copies of the same ownership proof, so a check tightened in one could silently miss the other. Each kind now supplies only its own journal match and store path.
- 1eaf6e3: `cotal status --components` now names the HTTP status when the web dashboard's address answers `/api/meta` with a status outside 2xx, such as `HTTP 401`. It used to read the body first, so a plain-text or empty refusal printed `http not answered`. The status row and `cotal web --detach` now send one shared readiness request from `@cotal-ai/workspace` and read its answer the same way. That request no longer follows a redirect, so the readiness header goes only to the recorded address and a 3xx answer is reported as its status, such as `HTTP 302`, where both used to follow it and accept the identity the redirect target answered with.
- Updated dependencies [598d0dd]
- Updated dependencies [be2c0d8]
- Updated dependencies [140c0d4]
- Updated dependencies [1d92ef7]
- Updated dependencies [91663dc]
- Updated dependencies [31dccc4]
- Updated dependencies [15043fa]
- Updated dependencies [1dd5baf]
- Updated dependencies [1fd3cb4]
- Updated dependencies [fba88b0]
- Updated dependencies [b7f4af7]
- Updated dependencies [7a2c574]
- Updated dependencies [664e9df]
- Updated dependencies [8d97d8a]
- Updated dependencies [830d66b]
- Updated dependencies [516c8f6]
- Updated dependencies [00f631a]
- Updated dependencies [ab30526]
- Updated dependencies [df063ef]
- Updated dependencies [958e6cb]
- Updated dependencies [ee42687]
- Updated dependencies [d4a745f]
- Updated dependencies [3c0a830]
- Updated dependencies [4f49cea]
- Updated dependencies [6d5462d]
- Updated dependencies [c2e7648]
- Updated dependencies [12344fb]
- Updated dependencies [1eaf6e3]
- Updated dependencies [3b93aa2]
  - @cotal-ai/core@0.86.0
  - @cotal-ai/workspace@0.86.0

## 0.85.0

### Patch Changes

- Updated dependencies [6e10d50]
- Updated dependencies [ff09b5c]
- Updated dependencies [7840cea]
- Updated dependencies [d5e7a87]
  - @cotal-ai/core@0.85.0
  - @cotal-ai/workspace@0.85.0

## 0.84.0

### Patch Changes

- 6d48a0b: Load Claude Code's native MCP sources by default alongside Cotal and declared overrides. Preserve explicit per-spawn sharing restrictions, carried-session isolation, native policy and narrow environment forwarding.
- 4f16c65: Show separate bash and native zsh snippets in the completion usage banner instead of directing zsh users to the bash script.
- Updated dependencies [6d48a0b]
- Updated dependencies [b4c8812]
- Updated dependencies [9229264]
  - @cotal-ai/core@0.84.0
  - @cotal-ai/workspace@0.84.0

## 0.83.0

### Minor Changes

- d663fa4: Allocate a fresh numbered actor for implicit foreground user-auth launches without replacing an existing session or grant. Preserve explicit names, enrollments and managed handoffs, and retry only typed name collisions. Refuse backward connector-store migration even with force or reset, remove unsafe downgrade advice, and make the shell installer identify PATH shadowing and use its absolute installed launcher in next steps.

### Patch Changes

- Updated dependencies [d663fa4]
  - @cotal-ai/core@0.83.0
  - @cotal-ai/workspace@0.83.0

## 0.82.2

### Patch Changes

- 135ea80: Keep software updates independent of account catalogue refreshes, so an expired remote login cannot block update before its local manager continuity checks.
  - @cotal-ai/core@0.82.2
  - @cotal-ai/workspace@0.82.2

## 0.82.1

### Patch Changes

- b526a5e: Stop local Windows managers and delivery daemons through an authenticated process-bound cleanup request, so immediate restart can acquire leases released by the previous generation. Keep identity checks, stop reservations and the existing one-shot agent-reap policy. Refuse older Windows daemons without this capability instead of force-terminating them without cleanup.
- Updated dependencies [9061234]
- Updated dependencies [423d250]
- Updated dependencies [b526a5e]
  - @cotal-ai/workspace@0.82.1
  - @cotal-ai/core@0.82.1

## 0.82.0

### Patch Changes

- ddbe799: `cotal up --detach` and `cotal up -f` now exit 1 when the control plane does not come up on a first boot. Both printed `! control plane degraded: ...` and then exited 0, so a script or unit read success over a mesh with no manager or delivery daemon, while a refresh over the same failure already exited 1.
- 49cb75f: `cotal up -f` and `cotal spawn -f` now check `--server` against the rules a manifest's `broker.servers` already follows. A `--server` URL with embedded credentials used to pass: `up -f --dry-run` printed it whole in the plan, and `spawn -f` dialed it and printed it in its reach error. It is now refused with `--server entry 1 must not embed credentials`, a message that does not repeat the value. An invalid `--server` URL is refused the same way, and so is a value that names no URL: `--server ""` used to fall back to the default broker, and a blank or comma-only `--server` or `broker.servers` failed with a bare `Invalid URL`. Both now get `names no server URL`.
- 2df06bd: A bare re-run of `cotal up` now finds this folder's own mesh when its first boot ran on an auto-selected port. The re-run started from the default URL, missed the record, picked another free port, and was refused with `space "<space>" is already in use by a mesh at <url>`, so a refresh or repair needed `--server` by hand. With no `--server`, `cotal up` now starts from the URL this root recorded for the space, and `--host` keeps that URL's port.
- 11690b1: `cotal update` no longer refuses its running-manager continuity check when the selected mesh is one this machine runs and it is stopped. A mesh selected with `--space` or by running inside its project, where no `cotal supervise` process on this machine may be serving that space and whose recorded broker address refuses the connection because nothing listens there, has no running manager to preserve, so the update now reconciles the connectors and extensions. This covers a local user-auth mesh too, which used to refuse on its stopped auth service first. Before this, `cotal down` followed by `cotal update`, the only way past a `legacy` manager verdict, refused with "no mesh running at ... run `cotal up` there to restart" and left every extension at the old version. Anything short of that proof still refuses: a mesh registered with `cotal meshes add`, a `--server` override, a `cotal supervise` process still running from any folder whose command line names that space or no space, or an address where anything accepts the connection or the dial does not finish in time.
- Updated dependencies [4f52881]
- Updated dependencies [6afa12f]
- Updated dependencies [7c6c109]
- Updated dependencies [9a93a58]
  - @cotal-ai/core@0.82.0
  - @cotal-ai/workspace@0.82.0

## 0.81.1

### Patch Changes

- aa1e223: `cotal spawn -f` now reports a deploy with a failed agent launch as partial. When any launch fails, the summary opens with `! partial deploy onto "<space>"` and names the failed agents, and the command exits 1, as `down -f` does for a partial teardown. The ledger is still written for the channels and agents this run did create. It used to print `✓ deployed onto "<space>"` and exit 0 after the failure line. A launch that settles uncertain is listed as pending and does not change the exit status.
  - @cotal-ai/core@0.81.1
  - @cotal-ai/workspace@0.81.1

## 0.81.0

### Patch Changes

- 400b8b8: `cotal down --preserve-state` now refuses a presence row whose `card.id` differs from the key it was
  read under, with `presence record <subject> is malformed`. A participant may write any value under its
  own key, so a forged `card.id` naming the manager let a live participant pass the unmanaged-endpoints
  check, and one naming a retained seat made the lost-manager finish report that seat as still live.
- 21fe24c: A foreground `cotal spawn` on a static-auth mesh now retires the agent's broker footprint when it fails after provisioning. A failed provisioner stop, secret write or creds file write used to exit with the agent's DM and DLV durables and its read-ACL row left on the broker, with nothing left to remove them. The spawn now records the agent's identity and creds path before it provisions, and the same retirement that follows a failed launch runs before the error is reported.
- Updated dependencies [c166107]
  - @cotal-ai/core@0.81.0
  - @cotal-ai/workspace@0.81.0

## 0.80.0

### Patch Changes

- 5799f17: An empty `--subscribe`, `--allow-subscribe` or `--allow-publish` value on `cotal spawn`, and an empty `--allow-subscribe` or `--allow-publish` on `cotal mint`, is now an empty list. It used to read as an absent flag, so `cotal spawn <persona> --subscribe ""` launched with the persona's channels and `cotal mint <name> --allow-publish ""` granted the agent file's post list. Only an absent flag defers to the persona now.
- 6946457: `cotal spawn -f` now records an agent whose launch settles uncertain in the run's ledger and lists it as pending. Such an agent neither joined the mesh nor exited within the readiness window, and the manager keeps managing it. It used to print as a failed launch with no ledger row, so `cotal down -f` never stopped it. An agent that exits on launch is still a failure with no ledger row.
- 200d74c: Stop the spawned nats-server when `cotal up` cannot write `.cotal/nats.pid`, in both the foreground and the detached launch. `up` now exits with the write error and no broker left running, and leaves whatever is at the pid path in place.
- cf25442: Preserve delivery credentials when a required whole-stack shutdown stop fails. Remove them only after all required stops succeed, without changing selective delivery teardown.
- Updated dependencies [5417401]
- Updated dependencies [71e6311]
- Updated dependencies [3614fdd]
- Updated dependencies [e00402f]
- Updated dependencies [80f66fd]
- Updated dependencies [0835254]
  - @cotal-ai/core@0.80.0
  - @cotal-ai/workspace@0.80.0

## 0.79.0

### Patch Changes

- d5947c2: `cotal completion` now skips the connector-seeding boot gate alongside `__complete` and `help`. Sourcing completion in shell startup profiles no longer acquires the operator-global reconcile lock or rewrites `stamp.json`, and running `cotal completion <shell>` from a development checkout no longer fails on the source checkout guard.
- 4c2379d: `cotal console` and `cotal join` now print a seat's harness-reported condition and its ages the way `cotal endpoints` and `cotal status` do. The console roster, NEEDS YOU rail and detail pane, the `--plain` line stream, and the `cotal join` presence lines, `Present:` line and `/who` show `waiting (rate_limit for 40m) · unchanged for 5s · active 40m ago` and the activity's `(set <age> ago)` instead of a bare `waiting`. The roster and each NEEDS YOU card put the status and these facts on rows of their own under the seat's name, wrapped to the pane's width at any terminal size, so neither a long name nor a narrow terminal cuts them and they no longer push the activity out of view. A seat that needs more rows than a short terminal leaves its pane takes the title's row and is cut at the bottom, keeping its name row, and Enter opens its detail pane with every fact. The console's ages use the shared compact format, so a heartbeat nine hours old reads `9h` rather than `540m`, and an age floors rather than rounds.
- 92bd2ed: `cotal spawn` with `COTAL_ENROLLMENT_URL` or `COTAL_ENROLLMENT_FILE` against a registered remote user-mode mesh whose record pins no exchange URL now refuses before it redeems the enrollment, with the same "records no exchange endpoint" sentence and re-registration step the provisioning path gives. It used to spend the one-time enrollment and then refuse with "the enrollment's authServiceUrl does not match the registered mesh exchange", which hid the missing pin.
- 9c9569e: The delivery cutover preflight now checks the delivery-aware marker against the manager pid it attributed, without reading the manager pidfile a second time, and its stop signals only that pid. A delivery-aware manager that exits while `cotal up` runs the preflight is no longer reported as an old Plane-3-hosting manager, and a manager that replaces the record meanwhile is no longer stopped in place of the one the preflight judged. `cotal status` and the `cotal up --runtime` reuse warning check the marker against the pid from their own record read.
- 50747b1: A manager or delivery start that refuses a record it cannot attribute now names the pidfile it read. The cutover preflight, `spawn -f`, the delivery start and `service install` used to resolve the record's spelling a second time while formatting the refusal, so a record that moved between its space-keyed and pre-upgrade names in between was misnamed, and one that appeared beside the record that was read replaced the refusal and its `NEXT:` step with an ambiguous-record error. `readProcessRecord` in `@cotal-ai/workspace` now returns the path it read on every `ProcessRecord`, and `service status --json` reports that file as `manager.path`. The config and CLI pages describe both.
- 36b03b0: The persona catalog directory is now built in one place, `personaDir` in `@cotal-ai/core`. `agentFilePath` and `listPersonaCatalog` build on it, `@cotal-ai/workspace` keeps exporting it under the same name, and `cotal status` and `cotal personas` use it in place of their own copies, so the directory spawn loads personas from and the directory those surfaces name cannot drift apart.
- 5e9a618: An installed extension whose `package.json` is not JSON or has no `version` is no longer reported as not installed or with a bare JSON parse error. `installedExtensionVersion` throws `CorruptExtensionPackageError`, which names the package and its `package.json`, so loading the extension, `cotal status` and the `cotal setup` card report the damaged file. `cotal ext seed --repair` reinstalls a seeded built-in in that state, including after a corrupt extensions manifest was rebuilt.
- db962ae: The manager and delivery daemon records are now read and attributed by one reader, `readProcessRecord` in `@cotal-ai/workspace`, which takes the record path and the component's attribution predicate and returns the state with the pid, content and command line behind it. The rule that a live pid is demoted to foreign only when its command line was read and is not the component's now lives in one place, and the delivery verdict keeps the command line it was decided on, as the manager's already did. No states or messages change.
- 4aafb0d: A manager call that fails with a thrown envelope error now returns the error's code and details, the same as a refusal that arrives as a reply. The CLI's control calls, `cotal spawn -f` and the connector's manager tools each converted the thrown error by hand and dropped the code, and two of them also dropped the details and the lifecycle-blocked suffix. A `cotal attach` reconnect therefore kept retrying a `permission-denied` or `not-found` raised on the caller side, such as a broker refusal, instead of stopping on it. Core now exports `controlReplyFromThrown`, and each caller keeps its own message.
- 92590e8: The web dashboard's pidfile name is now one `WEB_PIDFILE` constant in `@cotal-ai/workspace`. The dashboard declares its record with it, and the `cotal status` `Web process` row, `cotal status --components`, the `cotal setup` card and the `cotal clean all` crash-residue sweep read it from there. They used to spell `web.pid` by hand, so renaming the dashboard's record would still typecheck while those readers reported a running dashboard as down or absent and `clean all` left its pidfile behind. The file is still `.cotal/web.pid`.
- Updated dependencies [50747b1]
- Updated dependencies [fbc3e2d]
- Updated dependencies [c535d98]
- Updated dependencies [36b03b0]
- Updated dependencies [2bd492c]
- Updated dependencies [5e9a618]
- Updated dependencies [7cb89f9]
- Updated dependencies [db962ae]
- Updated dependencies [4aafb0d]
- Updated dependencies [92590e8]
- Updated dependencies [c03f2af]
- Updated dependencies [79ace0f]
  - @cotal-ai/workspace@0.79.0
  - @cotal-ai/core@0.79.0

## 0.78.1

### Patch Changes

- @cotal-ai/core@0.78.1
- @cotal-ai/workspace@0.78.1

## 0.78.0

### Patch Changes

- a7f39aa: `cotal meshes add --from` and the manual-registration policy refresh now refuse a fetched discovery document that is not JSON with the URL and the content type that answered, for example a catch-all route serving `/.well-known/cotal-mesh` as `200 text/html`. They used to print the `--user-auth-file` sentence, which named neither and told the operator to re-export a file. JSON served under any content type is still accepted, and `--user-auth-file` keeps its sentence.
- 56f1d7f: `cotal meshes add --from` now fetches the discovery document through the same pinned fetch the registration policy refresh uses for that document. The fetch gives up after 5 s instead of 10 s, and a refused redirect prints the pinned-fetch refusal, so registration and the later refresh judge one URL alike.
- f26e86f: `cotal meshes add --from` checks for a terminal once, before it asks to fetch the discovery document. A second copy of the same check ran before the fetched pins were shown and could never refuse, because the first had already passed in the same process. Both copies loaded the prompt module with a dynamic import although the command already imports it. Behavior is unchanged.
- 1d8a7d4: `cotal clean store|all`, `cotal backup create` and `cotal meshes rm` now treat a process record as stopped only when it is absent, empty, or names a pid the kernel reports gone. Before, they read any record not proven alive as stopped, so a garbled record, an extension removal reservation, or a pid whose liveness the kernel would not report let `clean` delete the JetStream store and space identity, `backup` snapshot a store that could still be written, and `meshes rm` drop the record of a running broker, while `cotal down` refused the same records. `cotal status` now shows such a pid as `liveness unknown (<pid>)` instead of `stale pidfile`.
- 05b7166: `cotal down --preserve-state` now checks each presence row once, where it is read, for a card with a non-empty string `id` and a string `name`, and refuses the cut as malformed when one fails. A deleted key is still the only row it reads as absent. Before, a participant that wrote `null`, `false`, `0` or `""` under its own presence key was skipped as if its key were deleted, so the cut preserved state while that participant was live, and a card with no `name` was named `undefined (<id>)` in the unmanaged-endpoints refusal.
- 40283af: The `cotal up` root pin no longer takes an auth-mode argument. It already pinned the same way for auth and `--open` meshes and never read the argument, but every caller still worked out the mesh's auth mode to pass it, and the `-f` path parsed `broker.auth` only for that. Behavior is unchanged.
- bea10f9: `cotal up -f <manifest> --idp <url>` now applies the flag to the effective manifest, so the `--dry-run` plan names the IdP the launch pins. Before, the plan named the manifest's `broker.idp` while the launch used the flag. The flag and `broker.idp` now get the URL rules the launch applies to the IdP: a value that is not https (or http on a loopback IP literal), or that carries credentials, a query or a fragment, is refused before the plan prints. Before, such a value passed the dry run and the launch refused it.
- e98c2ae: `cotal up` now waits for a manager it starts to come up before it reports it. A refresh used to print `✓ restored in the background: manager (pid N)` and exit 0 the moment it had spawned the process, so a manager that refused at boot and exited seconds later, for example while a crashed predecessor's lease had not expired, read as restored. A manager that exits before it comes up, or whose pidfile another `cotal supervise` takes over first, is now reported as a degraded control plane naming its log, and a refresh exits nonzero.
- 196a575: A static reconciliation sweep that stops before it plans any alias (its provisioner credential or connection fails, or a slot row cannot be read) now reports `state: failed` in the manager `status` response with the reason in `lastSweep.error`, and `cotal status --components` prints it. Before, it read as an idle sweep that found nothing, and the reason was only in the manager log. The manager cluster document moves to revision 27 for the changed `status` output. Each `cotal status --components` row now stays on one line: a control character in a reported reason, such as a newline in a stored row's field name, prints as a `\uXXXX` escape.
- Updated dependencies [a7f39aa]
- Updated dependencies [981b567]
- Updated dependencies [8344353]
- Updated dependencies [f9a71ce]
- Updated dependencies [b9499b3]
- Updated dependencies [c2d8362]
- Updated dependencies [70fb24e]
- Updated dependencies [de3c0f7]
- Updated dependencies [a32e955]
- Updated dependencies [7d13389]
  - @cotal-ai/workspace@0.78.0
  - @cotal-ai/core@0.78.0

## 0.77.1

### Patch Changes

- @cotal-ai/core@0.77.1
- @cotal-ai/workspace@0.77.1

## 0.77.0

### Patch Changes

- Updated dependencies [6861390]
- Updated dependencies [7d1b600]
  - @cotal-ai/core@0.77.0
  - @cotal-ai/workspace@0.77.0

## 0.76.0

### Minor Changes

- 15d10c9: Refuse competing patched same-host consuming sessions without replacing their logical inbox owner. Preserve live control listeners and existing foreground actor material. Make fresh local foreground grants and departure cleanup generation-aware. This containment does not fence other hosts, broker URL aliases or older clients.

### Patch Changes

- a96b21e: The CLI now decides whether a durable `cotal` is on PATH with the shared `resolveOnPath`, in one place. Before, `cotalOnPath()` kept its own scan that counted a directory named `cotal` as installed, so with such a directory on PATH, or with `.` on PATH in a folder holding a `cotal/` checkout, every hint printed a bare `cotal ...` the shell could not run and `npx cotal-ai setup` skipped the global-install offer. On Windows it now follows `PATHEXT` like every other PATH lookup. The recovery hint for an older binary no longer names npx's transient `cotal` shim when `.` is on PATH.
- 58a725f: A detached `cotal spawn <persona> --resume <id> --on <instance>` without `--agent` now carries the session for the harness the target manager launches. The CLI used to pick the connector from `--agent` or its own `COTAL_DEFAULT_AGENT` alone, so a persona with `agent: claude` spawned by a caller whose default named another connector carried nothing, and a persona without a pin carried a Claude transcript to a manager whose own default then refused it. The CLI now asks the manager's new `resolve-agent` command, which loads the persona with the same visibility check as `spawn` and answers with the same flag, pin, caller default and manager default order. `resolve-agent` is minted beside `spawn` in the spawn capability and the operator instruments, and the manager cluster document moves to revision 26. With `--agent` the CLI does not ask, so a manager that does not serve the command still takes that form.
- 8845edd: A static-auth foreground `cotal spawn` now deletes the agent's broker durables and read-ACL row when it exits even if its creds file cannot be removed. The retirement used to stop at a failed file removal (a read-only creds directory, a directory in the file's place), so the agent's `dm_` and `dlv_` durables and ACL row stayed on the broker and the removal error escaped the spawn. The secret delete, the file removal and the broker teardown now each run, and every failed step is reported in one line.
- df7bec5: A foreground `cotal spawn` now resolves its `--share-tools` selection before it provisions the agent. A selection naming a server the config does not declare used to refuse after provisioning and outside the launch rollback, so the refusal left what provisioning had created behind, such as a remote user-mode spawn's actor-token and sentinel-creds files. The refusal text is unchanged. The spawn also reads the cotal config once, so the model policy and the launch use the same file contents.
- bb3cfa1: A manifest `broker.idp` that embeds credentials (`https://user:pass@host/...` or the token form `https://token@host/...`) is now refused with `broker.idp must not embed credentials`, the same rule `broker.servers` already followed. It used to pass validation, and `cotal up -f --dry-run` printed the credential in its plan line. The refusal names the field and never repeats the value.
- aa60e40: `cotal service status` now refuses a service unit or launchd agent that records its mesh but no absolute root, with the uninstall-and-reinstall remedy. Before, `--json` reported a unit with no root as installed with no root and no manager record, the human output crashed with `Cannot read properties of undefined (reading 'state')`, and a recorded root that was not an absolute path read the manager pidfile relative to the current directory. An installed status now always carries its unit, root and manager record.
- dec97c3: Foreground `cotal up` and `cotal up --detach` now run the steps between spawning nats-server and serving it through one sequence: `.cotal/nats.pid`, readiness, the broker version read and the server name check of a resumed or restored listener. A foreground `up` whose broker is below the 2.12 floor used to exit with the broker still running and `.cotal/nats.pid` recorded but no mesh entry. It now stops the broker and removes the pidfile, as `--detach` did. A foreground resume after `cotal down --preserve-state` now refuses a spawned listener that reports a foreign NATS server name, which only `--detach` checked before. A foreground `up` whose broker never answers now removes `.cotal/nats.pid` itself. `up --detach` now writes `.cotal/nats.pid` as soon as the broker spawns, as foreground `up` does, so `cotal down` can stop a broker whose `up` died before it was ready. When any of these failures stops a broker that ignores SIGTERM, `up` now sends SIGKILL and removes the pidfile only once the broker has exited, where both modes used to exit with it still holding the port.
- 3a9cb31: The `useMesh()` header comment, which ships in the CLI's `dist/console/mesh.js`, no longer says the `MeshView` model lives in `@cotal-ai/core`. It now points at `../view/mesh-view.ts` in the CLI package, where the class is defined. No runtime change.
- 7829cbb: `cotal status` and the `cotal setup` card now share one test for whether the web extension is installed: a package in the extensions manifest that provides `web` and is on disk. A manifest entry whose package directory is gone no longer reads `installed` in status while the card reads `not installed`. A web package record that cannot be read is no longer reported as not installed: status names the error on its `Web extension` row and still prints the `Web process` row, and the setup card names it on its web row, also while the dashboard is listening. `loadExtensionsManifest` and `installedExtensionVersion` now treat only a missing file as absent, so an extensions or package directory that cannot be searched throws its permission error instead of reading as no extensions or not installed.
- 42b28aa: `cotal status --components` now names a `web.session` that exists but cannot be read, for example after an ownership or mode change: the web row reads `refused · web.session unreadable: <error>`. The reader used to treat every read error as no record, so a live dashboard read `refused · probe refused (no bound address recorded)`, and the `Web process` row and the `cotal setup` card read `down`. Those two rows now name the unreadable record as well. Only a missing, empty or partial `web.session` still reads as no record. `cotal web --detach` prints the launch link from the record that proved the dashboard ready instead of reading `web.session` again, so a read error after that point cannot report a failed start over a running dashboard.
- Updated dependencies [58a725f]
- Updated dependencies [7829cbb]
- Updated dependencies [8e0876b]
- Updated dependencies [d85ca1a]
- Updated dependencies [20c93a1]
- Updated dependencies [715928c]
- Updated dependencies [a4b0467]
- Updated dependencies [08d92b7]
- Updated dependencies [35fdda8]
- Updated dependencies [7b34e9a]
- Updated dependencies [d153172]
- Updated dependencies [15d10c9]
- Updated dependencies [0eb8eff]
- Updated dependencies [ba76f78]
- Updated dependencies [f2a4bde]
- Updated dependencies [8be669e]
- Updated dependencies [42b28aa]
- Updated dependencies [720dbc3]
  - @cotal-ai/core@0.76.0
  - @cotal-ai/workspace@0.76.0

## 0.75.0

### Patch Changes

- 5a537d6: The comment in `cotal ext remove`'s process description, which ships in the CLI's compiled output, now states the labelling rule in three lines: only a pid proven dead is called a "stale pidfile", because that label is advice to delete the record, while unattributable content and indeterminate liveness are named as such. It replaces three blocks that narrated earlier revisions and said "three labels" above code with four. No runtime change.
- de17bdb: `cotal service uninstall` on macOS removes the launchd agent that `cotal service install` wrote. The plist records its mesh and root as `<!-- cotal-mesh: <mesh> -->` comments, and the reader kept the closing ` -->`, so `service status` reported the mesh and root with that suffix and `service uninstall --mesh <mesh>` always refused with a remedy that could not work. Each platform's unit now writes and reads its provenance header through one comment syntax, so the reader strips exactly what the writer added. Linux units are unchanged.
- e3612f1: `cotal status` now names an ambiguous process record on that component's row and prints the rest of the report. When a root held both a current record such as `manager.<hex>.pid` and its pre-upgrade name such as `manager.pid`, which a manager that crashed before the upgrade leaves behind, `status` printed `✗ both … exist … ambiguous process record; remove the stale one` and exited 1 before the remaining process rows, Recorded Meshes and Selected Mesh. `status --components` stopped the same way at the first component. The folder row now reads `pidfile unreadable` with that error, the component row reads `refused`, and the other rows still print.
- Updated dependencies [6286d29]
- Updated dependencies [ed0785d]
- Updated dependencies [625659e]
- Updated dependencies [0c924f4]
- Updated dependencies [b48a740]
- Updated dependencies [597fa25]
- Updated dependencies [cb3a177]
- Updated dependencies [5f5196f]
- Updated dependencies [d269d1d]
  - @cotal-ai/core@0.75.0
  - @cotal-ai/workspace@0.75.0

## 0.74.0

### Patch Changes

- 05fc104: A manifest whose `broker.idp` does not parse as a URL is refused without quoting the value. The refusal printed whatever was typed into that field, so a mistyped IdP URL that carried a token, such as `<token>@idp.example/api/auth`, printed the token. It now reads `broker.idp is not a valid URL (Better Auth: <origin>/api/auth)`, located at `broker.idp`, and applies to `cotal topology view -f`, `cotal up -f` and `cotal spawn -f`.
- Updated dependencies [f3e6f95]
- Updated dependencies [328d59b]
- Updated dependencies [ac251fd]
- Updated dependencies [e3498d9]
  - @cotal-ai/core@0.74.0
  - @cotal-ai/workspace@0.74.0

## 0.73.0

### Minor Changes

- 8182b64: The IdP URL, the pinned JWKS URL, the space-catalog link and `cotal sync`'s account binding now share one plain-http rule: `https://`, or `http://` on a loopback IP literal, decided by core's `isLoopbackLiteral`. Before, each spelled its own host list, so `cotal login --idp http://127.0.0.2/api/auth` and `http://[::ffff:127.0.0.1]/api/auth` were refused, `http://localhost/api/auth` signed in but dropped its same-origin catalog link, and the JWKS pin accepted any scheme on `127.0.0.1` or `localhost`, such as `ftp:` or `ws:`. Every loopback literal now passes and `localhost` is refused everywhere, because a hosts entry would choose the IdP and the keys the callout trusts. A mesh with an IdP pinned on `localhost` must move its pin to `127.0.0.1`; see the upgrading guide.

### Patch Changes

- 6b3f7b0: `cotal ext list --json` (and bare `cotal ext --json`) prints one JSON object per installed extension per line, so a script no longer has to strip the table's header and footer and split `pkg@version` itself. A row carries `pkg`, `version`, `spec` (what `ext add` was given), `seeded` (`true` when the built-in seed installed the entry) and `provides` (the `kind:name` refs the table shows). An empty prefix prints nothing and exits 0. `ext add`, `remove`, `root` and `seed` refuse `--json`, and the table is unchanged.
- d1cb0ed: The up-resume-render-lock live smoke no longer removes the root maintenance lock on its own line in teardown. The root lives inside the suite's scratch directory, so the recursive scratch removal on the next line already deletes the lock. The line's `catch` swallowed any error from resolving the root or removing the file, while a missing lock never reached it. Shipped behaviour is unchanged.
- Updated dependencies [9873985]
  - @cotal-ai/core@0.73.0
  - @cotal-ai/workspace@0.73.0

## 0.72.1

### Patch Changes

- Updated dependencies [07fe6b3]
  - @cotal-ai/core@0.72.1
  - @cotal-ai/workspace@0.72.1

## 0.72.0

### Patch Changes

- Updated dependencies [c5a45ab]
- Updated dependencies [18e7e91]
  - @cotal-ai/core@0.72.0
  - @cotal-ai/workspace@0.72.0

## 0.71.0

### Patch Changes

- ac59932: Ctrl-C on a foreground `cotal up --user-auth`, and a broker that exits under it, now stop the user-auth service with the same stop `cotal down auth` uses. Before, that teardown took no stop reservation and never escalated past SIGTERM: a concurrent `cotal down auth` signalled the same process without seeing the stop in progress, and a service that did not exit on SIGTERM survived the teardown with its record kept. The teardown now holds the reservation and sends SIGKILL after the 15-second grace.
- b9daf53: A whitespace-only `model` or `variant` is now refused everywhere a launch selector enters: a persona file's `model:`/`variant:` when it loads or is saved, `cotal spawn --model`, a manifest agent's `model`/`variant`, and every launch the manager admits, including a direct `Manager.startAgent` call. Before, the same blank value was dropped by the manager, rendered into the harness command and environment by the `claude`, `codex` and `opencode` connectors, and refused only by `jcode`, so one persona launched differently depending on who started it. The manager no longer coerces a blank model to absent, and the `jcode` connector no longer carries its own blank-variant check.
- Updated dependencies [b9daf53]
- Updated dependencies [3518435]
- Updated dependencies [726a750]
- Updated dependencies [518351a]
  - @cotal-ai/core@0.71.0
  - @cotal-ai/workspace@0.71.0

## 0.70.2

### Patch Changes

- 9f8b184: The `up-multi-space-render` live smoke no longer imports `tmpdir` from `node:os`. The import was never used: the suite's scratch comes from `makeScratch`, which checks its ancestry. Shipped behaviour is unchanged.
  - @cotal-ai/core@0.70.2
  - @cotal-ai/workspace@0.70.2

## 0.70.1

### Patch Changes

- 9c99ee5: The `clearChannel` doc comment now tells callers to pass a `channel-purger` cred. It named a `manager` cred, a profile that `mintCreds` no longer accepts. The comments on `seedChannelRegistry`, the `purger` profile and `cotal channels` now name the creds those paths use. No behavior changes.
- aca82ef: A broker URL refused for embedded credentials no longer prints the URL's user part. In the NATS token form `nats://<token>@host:4222` that part is the token, so `cotal meshes add`, enrollment-bundle registration in `cotal spawn` and a manifest's `broker.servers` printed the secret they were refusing. A `broker.servers` entry that does not parse as a URL is no longer quoted either. The manifest refusals now name the entry by its position in the list.
- 2cec5c6: `cotal down delivery`, and a bare `cotal down`, now remove the delivery daemon's per-space credential at `.cotal/space.<key>/delivery.creds` once the daemon is confirmed stopped. `down` used to remove only the flat pre-segmentation `.cotal/delivery.creds`, which a current `cotal up` never writes, so the standing credential of a stopped daemon stayed on disk. `down` now stops the daemon through the same stop as the foreground `up` teardown, which drops both spellings through the secret store.
- 66a0f19: `@cotal-ai/core` now exports `runAgentBearer`, the one runner for an auth provider's agent bearer argv: it owns the 30-second default bound, the 64 KiB output limit and the failure sentence, and returns the printed line. The CLI's foreground preflight, the manager's local and remote enrollment preflights and the connector's bearer refresh and manager calls all run through it instead of carrying their own copy. The CLI still scrubs the enrollment variables from the child environment it passes, and the connector still refuses an empty line.
- 923937f: The source-checkout refusal of the operator-global seed store now names `COTAL_SKIP_CONNECTOR_SEED=1` as the way to run other commands without seeding, and says that isolating `XDG_CONFIG_HOME` alone does not lift it. It used to name only `XDG_CONFIG_HOME`, and a sandboxed `XDG_CONFIG_HOME` is still refused, so the remedy on the line could not be followed. The refusal still does not advertise `COTAL_ALLOW_CHECKOUT_SEED`. The CLI reference, configuration and setup internals pages say the same, and the CLI reference notes that a skipped seed leaves a fresh config with no built-in connectors.
- ed1e171: Every `.cotal/setup.log` entry is one timestamped line. A control character or Unicode line separator in a logged path or error message is written as a `\uXXXX` escape, so a newline in a project path can no longer split one entry into a second line that reads as an entry setup never wrote. The escaping rule is now one exported helper, `oneLine`, shared with the provenance lines. `openSetupLog` no longer takes a working directory it never read; the log always lives in the resolved project `.cotal/`.
- 8ffb5f5: The up-resume-render-lock live smoke no longer defines `tryLock()`, a lock-acquiring helper that nothing called. The comment on its read-only control now names the risk of an independent acquire directly instead of pointing at that helper. Shipped behaviour is unchanged.
- Updated dependencies [9c99ee5]
- Updated dependencies [da6dba0]
- Updated dependencies [032522a]
- Updated dependencies [5c6c92d]
- Updated dependencies [6d81d61]
- Updated dependencies [66a0f19]
- Updated dependencies [2be1384]
- Updated dependencies [25237f0]
- Updated dependencies [6bd6099]
- Updated dependencies [ed1e171]
  - @cotal-ai/core@0.70.1
  - @cotal-ai/workspace@0.70.1

## 0.70.0

### Patch Changes

- f4d4b8a: The manager and delivery start refusals now quote the record their verdict was made on instead of reading the pidfile a second time. A manager or daemon removes its record when it exits, so a record that disappeared between the two reads turned the refusal and its `NEXT:` step into a bare `ENOENT`, and a record replaced in between was quoted although the verdict had read different content. This covers the delivery cutover preflight, the delivery daemon's own refusal in `cotal up`, and the manager start refusal in `cotal spawn -f`. A record that is not a pid is now reported as such, quoted on one line, in the cutover preflight and the delivery daemon refusal, which used to say the kernel had answered for a pid it was never asked about.
- 7254e32: `cotal service status` and `cotal service install` now judge the manager record through the same reader as `cotal up`, called with the root the unit records, instead of a private copy of it. `service status` therefore reports the command line of a live recorded pid: `--json` gives the manager's `command` next to its `state` and `pid`, and the human row names the pid and, for a pid that another program has reused, what that program runs.
- 8249f3f: `cotal service install` builds the manager's environment from one list that both platforms render. On macOS it no longer writes a `cotal-manager@<key>.env` file nobody reads; the plist's `EnvironmentVariables` carry the same variables as before. On Linux the unit is unchanged, and every value in its `EnvironmentFile` is now double-quoted the way `PATH` already was, so each one reaches the manager verbatim.
- 5a2a370: `cotal status` no longer exits 1 when the manager's delivery-aware marker cannot be read. The marker is read only for a live manager, and a failed read is named on the manager row as `delivery-aware marker unreadable` with the error, so the recorded meshes, the selected mesh and the `--components` pass still print. `cotal up` and the delivery preflight still refuse a marker they cannot read.
- c8d6114: The `cotal status` `Web process` row and the `cotal setup` status card now read the selected mesh's dashboard from its own records: the address it recorded in `web.session` once it was listening, while the PID in its `web.pid` is alive. They used to report the dashboard up whenever anything accepted a connection on port 7799 and printed `http://cotal.localhost:7799/` regardless, so a dashboard started with `--port` read as down and an unrelated program on 7799 read as the dashboard. A `web.pid` that cannot be read is named on the row, and the rest of the output still prints.
- 60328b2: Source comments that sent readers to docs pages retired in the docs restructure now name the current pages. The `MeshView` header points at `docs/mesh-view.md`, and the console space picker and the web dashboard's Agent Detail frame point at `docs/watch-a-mesh.md`. These comments ship in the built packages, and `docs/protocol-view.md` and `docs/web.md` no longer exist.
- 0ec35c2: A manager's endpoint reply now becomes a `ControlReply` through one core function, `controlReplyFrom`, which `cotal spawn -f`, the CLI's other manager calls (`cotal spawn --detach`, `stop`, `attach` and the rest) and `cotal_spawn` all use. Before, each caller copied the conversion and kept different fields. `cotal spawn -f` dropped the error code, the lifecycle-blocked details and their rendered `[lifecycle …]` facts, and the acceptance an uncertain launch keeps, so it could tell an `uncertain` launch from a `failed` one only by its text. `cotal spawn --detach` dropped that acceptance too, and a `stop` or `attach` whose name lookup was refused dropped the rendered facts. A refusal now carries the same code, details, facts and data whichever caller it reaches.
- 723eb53: `cotal ext add` refuses a package whose `package.json` declares no `version`, or an empty one, and rolls the add back. It used to record such a package as `0.0.0` (or with an empty version), and every later load then reported it as in the manifest but not installed, which a re-add repeated.
- 7986785: The connector and the CLI now print every peer with one label, from the new `peerLabel` in `@cotal-ai/core`: `name/role`, or the bare name for a peer with no role, with any line break or bracket shown as a space. Before, `cotal console` dropped a role equal to the name and its roster pane showed the name alone, the console's managed-agent row and the spawn line printed `name (role)`, and only message attribution sanitized the role, so `cotal_roster`, the orientation card, the ambiguous-DM candidate list, `cotal endpoints`, `cotal status` and `cotal ps` printed a role holding `]` or a newline verbatim. The DM target check that refuses a pasted label compares against the same label.
- 668f6b0: The web dashboard's `web.session` record and its `x-cotal-readiness` header now have one definition, in `@cotal-ai/workspace`: the file name, the record's fields, the one reader, and the header name. The dashboard writes and reads the record through it and `cotal status` reads it there. Renaming the file, a field or the header on the dashboard side used to typecheck cleanly while `cotal status --components` read the live dashboard as `refused` and the `Web process` row read `down`; now it is a compile error on both sides.
- Updated dependencies [392bfeb]
- Updated dependencies [66df6c0]
- Updated dependencies [0ec35c2]
- Updated dependencies [015f805]
- Updated dependencies [2cbfe9c]
- Updated dependencies [1b11c4e]
- Updated dependencies [c088c5c]
- Updated dependencies [b413e2a]
- Updated dependencies [7986785]
- Updated dependencies [12bfc34]
- Updated dependencies [4dcfa0b]
- Updated dependencies [fd07b1e]
- Updated dependencies [8dc360c]
- Updated dependencies [cce8dad]
- Updated dependencies [c7e0c0a]
- Updated dependencies [2639a13]
- Updated dependencies [668f6b0]
- Updated dependencies [15b7920]
  - @cotal-ai/workspace@0.70.0
  - @cotal-ai/core@0.70.0

## 0.69.0

### Minor Changes

- 8c01391: The manager carries an agent's MCP server selection as a list instead of the `--share-tools` flag string. The CLI parses `--share-tools` once and sends the list, so the `spawn` operation's `shareTools` input is now an array of server names and the manager cluster document moves to revision 22. A `supervise --roster` entry's `share-tools:` list is used as written, so a declared server named `none`, or one whose name contains a comma, now loads and is shared instead of refusing the roster. Preserved-state inventories are written as `cotal-manager-resume/v2`; a v1 inventory from an earlier release still resumes.

### Patch Changes

- f5cb8e1: Applying a space catalog (`cotal sync` and the lazy catalog refresh) now reads the mesh registry a fixed number of times instead of once or twice per catalog row. Each row reads only its own record file just before writing it, so a registration that `cotal meshes add` or `cotal up` records while the catalog applies still wins its collision check, and the records and the removals each share one legacy-file sweep, so the time spent under the catalog lock grows linearly with the registry. The workspace package adds `readMesh`, which reads one space's record file, and `recordMeshes` and `removeMeshes`, the batch forms of `recordMesh` and `removeMesh`.
- 5aa48ce: Bare `cotal down`, and Ctrl-C on a foreground `cotal up`, no longer print `left 0 managed agents running (no longer managed):` and the `cotal down --with-agents` hint when the manager had no managed agents. The spare report now prints only when the pre-stop inventory names at least one agent.
- 809a594: The `down-target` smoke now waits for its planted legacy manager to report that its SIGTERM handler is installed before `cotal down` signals it, with a 20 second bound. A fixed 100ms delay stood in for that readiness, so on a loaded host the manager could die to Node's default SIGTERM action before its handler existed, leave its planted agent running, and fail the `--with-agents` and historical-destructive cells without `down` being at fault. Shipped behaviour is unchanged.
- c4bfba2: A foreground user-mode `cotal spawn` whose auth preflight fails now attempts every rollback step even when one fails, so a failed file removal no longer skips the deprovision of the agent's durables and ACL row. The `agent auth preflight failed` refusal keeps its cause and appends each step that failed, whatever value the step rejected with. The remote arm appends a failed removal instead of replacing the cause, a managed handoff's fixed refusal names the failed steps without their errors, and both arms' exit cleanup runs every step and reports what it left behind.
- 02c0a2d: `cotal meshes add --mode user --from <https url>` now fetches the `/.well-known/cotal-mesh` discovery document under the address it is given, as its help says. Passing the mesh's address, such as `https://auth.example`, previously fetched that URL as is, so a host serving its site there failed with the file-oriented "user-auth bundle is not JSON" refusal. A URL that already ends in `/.well-known/cotal-mesh` is fetched as given, and the consent prompt now shows the full URL it will fetch instead of only the origin. The derivation is shared with the manual-registration policy refresh through the new `discoveryDocumentUrl` export of `@cotal-ai/workspace`.
- 3a1716d: Every manager stop the CLI makes now runs the stop `cotal down` runs. Ctrl-C on a foreground `cotal up`, the teardown after its broker exits, the leftover-manager stop before `cotal up -f` and the delivery cutover preflight used a second stop that took no stop reservation, skipped the spare-capability check and gave up after 2s, leaving a wedged manager running with its record kept. They now hold the reservation, so a stop while another `cotal down` is stopping the manager is refused and leaves that stop's `--with-agents` policy in place, verify the spare capability before signalling, and send `SIGKILL` to a manager still running 15s after `SIGTERM`. Ctrl-C stops the manager first and, when that stop fails, signals nothing else and leaves the stack running. A pre-pin manager record whose pid now runs a process that is not a manager is removed without a signal on every path, `cotal down` included. The workspace exports `stopReservationPath`, the one spelling of a pidfile's stop reservation.
- 06429be: `cotal status` and `cotal endpoints` now date a presence row the way `cotal_roster` does. Both print how long the status has stood, such as `unchanged for 40m`, and the age of the activity, such as `(set 9h ago)`, and neither prints an age for a stamp that is not a finite number: `activeAt: "nope"` printed `active NaNd ago`, a `null` condition start printed an age counted from 1970, and `1e400` printed `active 0s ago`. Core exports `presenceAges`, which decides which facts a row dates, and `formatAge`, the one compact age formatter, so the CLI and the connector no longer keep separate copies.
- adab793: Resolve an agent's read list through one core function, `resolveReadAcl`, at every site: the persona loader, the session config, the manager launch, foreground `cotal spawn` and its user-mode grant, `cotal mint` and the manifest persona merge. An explicit empty `allowSubscribe` now reads `subscribe` everywhere, as an omitted one does. Before, the session refused a persona the loader had accepted. The manager also granted and recorded an empty read list while the provisioner recorded `subscribe`.
- e0ad25c: A foreground `cotal spawn` through a remote user-mode mesh's advertised agent-provisioning endpoint, against a record that pins no exchange URL, is now refused before the provisioning request is sent. It used to request the grant, write the agent's actor token and sentinel credential under `.cotal/auth/creds/`, and then exit on the missing exchange URL with both files still on disk. `docs/cli.md` now says when that refusal happens.
- b584718: `cotal status` and `cotal setup` now decide whether a connector's `requires` executables are present with the same PATH resolver as the manager and manifest preflights. A `requires` entry written as a path is checked as given instead of being joined under every PATH directory, so an absolute path or `./tool` is no longer reported as missing and `bin/tool` under a PATH directory is no longer reported as ready. The shared resolver now skips a directory that matches on PATH, as exec does, so a directory named like a harness no longer counts as that harness or hides the real binary later on PATH.
- 0c5b205: `cotal run start`, `resume`, `ps`, `journal` and `answer` now re-describe and re-issue an unpinned manager call that a sibling manager refused before running it, up to the same 16 attempts the CLI's manager commands use. Before, one such refusal ended the command, so in a space with two managers about half of these calls failed with a refusal saying the command was not run. A hosted run's own manager calls now use that bound too instead of 8. The repair is one core helper, `invokeRepairingSplit`, which the CLI and the runtime both call.
- 98d2b41: Resolve a spawn's harness through one shared rule. Foreground `cotal spawn`, the detached `--resume` carry and the manager's `start` now all call `resolveAgentType` in `@cotal-ai/workspace` (`--agent`, then the persona's `agent:` pin, then a detached caller's default, then `COTAL_DEFAULT_AGENT`, then the product default). The foreground path no longer spells the product default as its own literal, so it can no longer pick a different harness than a detached spawn of the same persona. Behavior is unchanged while the product default stays `claude`.
- 6540a32: The architecture and control-surface pages, which ship in the bundled docs, and several source comments described spawn auto-numbering as `reviewer-2`. They now spell the series with `_` (`reviewer_2`, `reviewer_3`), the separator the manager and `cotal spawn` use. The control-surface spawn accept example shows `reviewer_2` as both the allocated name and the user-mode actor. No behavior changes.
- 5195d74: A foreground `cotal spawn` whose persona reference is a path that does not exist now names the file it opened. It used to say the persona was missing from the mesh's `.cotal/agents` directory, which a path reference never reads. A bare catalog name is still refused with that directory and the mesh it came from. `docs/cli.md` now says how a path reference resolves.
- cbbde1d: A first `cotal up` no longer prints `✓ restored in the background: manager (pid N)`. The line came from the control-plane helper that every launch shares, so the detached, foreground and resume launches claimed a restore whenever they started their manager. Only a refresh of a running mesh prints it now, when it starts a manager that was missing.
- 02a989a: Foreground `cotal up` and `cotal up --detach` now run the steps after their listener is ready through one function: the space setup, the user-auth service, the mesh record, the transport policy and the control plane. When the space setup of a fresh foreground boot failed, for example on a channel seed with an invalid `replayWindow`, `up` exited 1 but left its nats-server running on the port with `.cotal/nats.pid` in place and no mesh record for `cotal down` to find. It now stops the listener and removes the pid file, as `--detach` already did. A foreground TLS boot also writes its broker policy after the mesh is recorded, in the same order as `--detach`.
- Updated dependencies [f5cb8e1]
- Updated dependencies [2d45766]
- Updated dependencies [03a7405]
- Updated dependencies [a256e2f]
- Updated dependencies [3f3d04a]
- Updated dependencies [4500563]
- Updated dependencies [5eb1e24]
- Updated dependencies [69232cd]
- Updated dependencies [02c0a2d]
- Updated dependencies [93716c3]
- Updated dependencies [3a1716d]
- Updated dependencies [9772fd4]
- Updated dependencies [06429be]
- Updated dependencies [adab793]
- Updated dependencies [d29d4d3]
- Updated dependencies [539266a]
- Updated dependencies [b584718]
- Updated dependencies [0c5b205]
- Updated dependencies [98d2b41]
  - @cotal-ai/workspace@0.69.0
  - @cotal-ai/core@0.69.0

## 0.68.0

### Patch Changes

- 218006f: A bearer command that fails without printing a sentence of its own now reports its cause. The agent auth preflight in `cotal spawn` and in the manager, and a running agent's bearer refresh, reported such a failure with Node's `Command failed` line, which repeated the whole bearer argv (exchange URL or state dir, space, owner, actor, token file and health file) and never said whether the child timed out, was killed or exited. The error now says the bearer command timed out after its limit, was killed by a named signal, or exited with a named code and printed nothing. A failure the command explains on stderr is still reported with that sentence. `bearerCommandFailure` in `@cotal-ai/core` builds the error.
- a31363d: A broker URL refused during registration now names where it came from. `cotal meshes add --user-auth-file` or `--from` reports a bad server in the bundle as the bundle's server, and the enrollment bootstrap (`COTAL_ENROLLMENT_URL` with `cotal spawn --space`) reports it as the enrollment bundle's server. Both used to blame `--server`, a flag neither command was given. A typed `--server` is still reported as `--server`.
- 2dfb9b9: The `up-multi-space-render`, `up-per-space-membership` and `up-resume-render-lock` live smokes now start `cotal` as `node --import tsx` instead of through the `.bin/tsx` shim. The shim runs the CLI in a second process and relays only SIGINT and SIGTERM, so the suites' SIGKILL escalation ended the wrapper and left the real `cotal up` running as an orphan. The spawned child is now the CLI itself, so the SIGKILL reaches it. Shipped behaviour is unchanged.
- a5256fd: Ctrl-C on a foreground `cotal up`, and a broker that exits under it, now stop the delivery daemon with the same stop `cotal down delivery` uses. Before, that teardown took no stop reservation and never escalated past SIGTERM: a concurrent `cotal down delivery` could not see the stop in progress, and a daemon that did not exit on SIGTERM survived the teardown while `up` went on to stop the broker. The teardown now holds the reservation, sends SIGKILL after the 15-second grace, and removes the daemon's credential only once its death is confirmed. If the broker exits while the Ctrl-C teardown is running, `up` waits for that teardown to finish before it exits. `cotal down delivery` now clears a record whose pid belongs to another program without signalling it, as the `up` teardown already did. A local process descriptor can carry `isOwnCommand` for that check; an installed extension's descriptor is cached as data and is refused if it declares one.
- 2014b03: `cotal setup` now builds each connector setup step with the input that action's type declares, so the compiler checks which input reaches the `connector`, `skills` and `mcpServers` actions. The step builder used to pick the input by action name behind two casts, which let a swapped or missing input compile and reach the provider only when someone ran `cotal setup`.
- 237c813: `cotal_spawn` now returns an uncertain launch as a pending result instead of a tool error. A worker that has not joined the mesh within its readiness window is still managed and may yet join, so the result names the allocated agent, its id and its manager, and says to watch the roster, because spawning again starts a second agent. A launch that exits stays an error. The goal follower keeps the acceptance as the reply data of any terminal other than `succeeded`, and `ControlReply` carries the endpoint error code, so the tool keys on the `uncertain` code rather than on the message. A pinned-model spawn that settles uncertain reports its recorded pin the same way.
- e6b48bf: `cotal status --components` now presents the dashboard's readiness nonce from `web.session` when it probes `/api/meta`, so a live dashboard at its recorded address grades `web serving`. The probe used to ask anonymously, the dashboard's auth gate refused it with 401, and the row could only read `not-serving · http identity mismatch`.
- Updated dependencies [6141e7b]
- Updated dependencies [4120c97]
- Updated dependencies [218006f]
- Updated dependencies [681c5b0]
- Updated dependencies [585fdb2]
- Updated dependencies [a5256fd]
- Updated dependencies [0d806ae]
- Updated dependencies [9b439e8]
- Updated dependencies [41a7e66]
- Updated dependencies [f018376]
- Updated dependencies [6a1789b]
- Updated dependencies [237c813]
  - @cotal-ai/core@0.68.0
  - @cotal-ai/workspace@0.68.0

## 0.67.0

### Minor Changes

- f389576: `cotal spawn --resume <id> --detach --on <instance>` carries a Claude session held on the operator's host to a manager on another host, as `docs/design/resume-transfer.md` lays out. The CLI finds the transcript with the connector's new `resumeTranscript` locator and writes it into a JetStream Object Store bucket owned by the target instance, in chunks sized to the broker's `max_payload`, as a chain that an interrupted carry continues. The manager's new operator-only `transcript-receive` command stages it, removes the broker object, and issues a one-time `resumeClaim` that `spawn` consumes; a re-run of the same bytes moves none. The seat forks the transcript in a seat-private Claude home that authenticates with an environment credential, and `cotal ps --wide` names the source host, session, digest and carry time. The manager cluster document moves to revision 21. Two one-shot credentials carry it on an authenticated mesh: a `transfer-writer` the CLI mints from the space's signing seed for the one transcript it hashed, or on a user-auth mesh exchanges from the operator's login as the new `transfer-writer` view (scope `admin`), and a `transfer-reader` the target manager mints for its own bucket on each receive or sweep, or that the host issues a remote manager through the new manager-service `transferReader` operation. A carried seat records the digest of the transcript Claude forked, and the manager stops a seat whose record does not match the carried bytes, including one whose launch was uncertain and that joined later. Space deletion lists the transfer buckets and deletes them: `deleteSpace` given the space's trust material mints its own `teardown` naming them, and it now throws naming every stream it could not delete instead of reporting success. The console space picker deletes a space this host registered as a static-auth mesh that way. The `transfer-writer` view, and the broker connection minted from it, lives at most five minutes, the static credential's lifetime.

### Patch Changes

- 48f18d0: Remove sentences from shipped comments in core, lang, the CLI and the manager that described what earlier revisions of those comments claimed. The request-path validation note in `endpoint-envelope.ts` now states as current fact that registration-time profile bounds do not replace request-path enforcement, with the `uniqueItems` measurement under it. The barrier-window note in `endpoint-action.ts`, the lang worker header, the worker result backstop, the `--rotate-sys` broker check and the manager's goal-writer epoch belt keep their contract text and drop the history. No behavior changes.
- e85e1fd: An agent's manager calls now repair a class-queue split as the CLI does. In a space with more than one manager, a call can reach a manager other than the one it resolved against, which refuses it before running it. `CotalEndpoint.invokeService` re-described and re-issued that call only once, and the re-issue splits again at the same rate, so with two managers about a quarter of `cotal_spawn` and `cotal_despawn` calls still failed. A spawn whose seat came up was reported as `Couldn't spawn` when the goal-result read that follows it split, and a named despawn was refused with `WAS NOT RUN`. The endpoint now re-issues up to 16 times, the bound the CLI already uses, which core now exports as `BIND_SPLIT_REISSUES`. A named `cotal_despawn` also asks its `inspect` lookup again when the manager that answered names a sibling instance as the owner, until the owner answers, within the same bound; before, it refused a live seat whenever the lookup reached the other manager.
- 55061ff: `cotal ext add` now reports an extension that needs an export its linked `@cotal-ai/*` peer does not have the way a later load of it does: it names which install is behind and what to rebuild or upgrade. It used to print only the raw missing-export import error. First-run and upgrade seeding add every built-in connector through this path.
- Updated dependencies [48f18d0]
- Updated dependencies [e85e1fd]
- Updated dependencies [55061ff]
- Updated dependencies [5b0da88]
- Updated dependencies [e65ec69]
- Updated dependencies [79e5268]
- Updated dependencies [bb0b14e]
- Updated dependencies [3069425]
- Updated dependencies [ae5b3cd]
- Updated dependencies [954a78b]
- Updated dependencies [f389576]
- Updated dependencies [562a56b]
  - @cotal-ai/core@0.67.0
  - @cotal-ai/workspace@0.67.0

## 0.66.1

### Patch Changes

- 568f718: `cotal down` no longer fails with `ENOENT` when a component removes its own process record while the command runs. The record readers in `down`, the manager, delivery and auth-service helpers, and `cotal service status` checked that a pidfile existed and then read it, so a record removed between the two calls threw: `cotal down manager` printed `✗ ENOENT` and `✗ not cleanly stopped` and exited 1, and `cotal down nats` aborted before stopping the broker. Each reader now reads the record once through the new `readPidfile` helper in `@cotal-ai/workspace`. A record that is gone takes the no-record path, and any other read error still throws.
- ec2f68a: `cotal status --components` no longer aborts every row when one component's PID record cannot be read. The pass checked that a pidfile existed and then read it, so a component that removed its own record between those two calls, or a record the pass could not read, threw out of the whole pass: it printed the header with no rows and exited 1, the same code as `absent`. The record is now read once. A record that is gone reads as `absent`, and any other read error makes that component `refused`, naming the error, while the other rows print as before. Bare `cotal status` reads each local process record once as well, and a record it cannot read marks only that process row `pidfile unreadable`, naming the error. It reads the manager's delivery-aware marker only after the manager's own record, so a marker left behind by a stopped manager is not read. A process that exits while status runs, or a process record status cannot read, no longer aborts the command before the component pass.
- Updated dependencies [568f718]
  - @cotal-ai/workspace@0.66.1
  - @cotal-ai/core@0.66.1

## 0.66.0

### Patch Changes

- 84cead6: A foreground `cotal spawn` on an open mesh now publishes its AG-UI events. The launch passed the seat no id, so its endpoint made up a random actor for each process and the event emitter refused to start with `events are not available for a session with a self-minted identity`. The seat's Graph stayed empty although the spawn had succeeded. The foreground launcher now allocates an id on an open mesh, as the manager already does for detached seats, so this works for every connector with an event plane. The Jcode connector used to work around this by itself, using the seat name as its actor on an open mesh. That workaround is gone, and an open-mesh Jcode seat now gets the allocated id like every other seat.
- 3808751: `cotal status --components` now probes the web dashboard at the address the dashboard bound. The dashboard records its socket's host and port in `web.session` once it is listening, and status reads that record. Before, status parsed `--host` and `--port` out of the dashboard's command line and fell back to `127.0.0.1:7799`, so a port spelled any way other than plain digits (`--port 0x1f90` binds 8080) was probed at 7799, and `--port 0` was refused as an invalid port while the dashboard listened on an ephemeral one. A live dashboard pid with no readable recorded address, including a dashboard still writing its record and one started by an earlier build, is now `refused` with `no bound address recorded`.
- Updated dependencies [a07f732]
- Updated dependencies [be53e2d]
- Updated dependencies [658c1b8]
- Updated dependencies [af779f9]
  - @cotal-ai/core@0.66.0
  - @cotal-ai/workspace@0.66.0

## 0.65.0

### Patch Changes

- a87a66c: A mesh registry record this build cannot use no longer refuses a command in the catalog preparation that runs before the command's own checks. While such a record is present the preparation neither refreshes nor applies a catalog, so `cotal spawn` reports its own usage errors and a managed handoff refuses with its handoff-phase sentence instead of the record's path. A snapshot an interrupted command left unapplied is applied once the record is restored or removed. Every command that resolves its target through the registry still refuses the record by name.
- 2cef9e6: A caller now validates a request's args in the form they are sent, so a key whose value is undefined, which JSON drops, no longer fails a responder's closed input contract. A `cotal spawn --detach` from a current CLI was refused by every manager released before `defaultAgent` existed, even with `COTAL_DEFAULT_AGENT` unset. A caller-side args refusal is now marked `not-executed`, since nothing was published. Args that JSON cannot carry, such as a BigInt, get the same `bad-request` refusal. A refusal that names a key the responder's contract does not declare carries an `ai.cotal.ep.undeclared-arg` detail. The CLI reads that detail on manager commands and reports version skew with its own version, where it used to print a bare schema error followed by a warning that the request may have run.
- Updated dependencies [ba5468d]
- Updated dependencies [451ffee]
- Updated dependencies [f01aa7c]
- Updated dependencies [2cef9e6]
  - @cotal-ai/core@0.65.0
  - @cotal-ai/workspace@0.65.0

## 0.64.0

### Minor Changes

- d121d21: Design record for carrying a detached `cotal spawn --resume <id> --detach --on <instance>` session to a manager on another host (`docs/design/resume-transfer.md`). The transcript moves through a per-space JetStream Object Store bucket for the target manager instance, in chunks sized to the broker's `max_payload`, with a chunk chain that resumes an interrupted upload and a content-addressed staging copy that makes a repeat move no bytes. The manager gains the operator-only `transcript-receive` command and `spawn` gains a one-time `resumeClaim`. The carried transcript is placed in a seat-private Claude config home that authenticates with an environment credential, and `cotal ps` and `cotal attach` show where a seat was resumed from. The implementation follows this record in the same change.

### Patch Changes

- Updated dependencies [6c79419]
- Updated dependencies [d121d21]
  - @cotal-ai/core@0.64.0
  - @cotal-ai/workspace@0.64.0

## 0.63.0

### Minor Changes

- 22e210a: Start an already-enrolled managed agent in a child outside the manager's filesystem (SPEC §13.17). A runtime may offer `Runtime.spawnDelegated(launch, handoff)`. A manager whose runtime does enrolls through `enrollManagedAgent` once, refuses `--resume`, a manifest agent's `continuity: exact`, `--cwd`, shared MCP servers and non-string launch options before enrolling, never builds a local launch for the seat, and hands the lifecycle off at most once as one closed `cotal-managed-handoff/v1` value carrying the issued owner, actor, host-chosen lifecycle UID, sentinel, pinned exchange base and the raw actor token, which the host never receives. `delegatedSeatCommand` builds the child's `cotal spawn --expect-owner <owner> --expect-lifecycle-uid <uid>` command with `COTAL_MANAGED_HANDOFF_FILE` naming the handoff file. The `cotal` entry takes and deletes that file and drops the variable under any letter case before it parses flags, prints help or loads extensions, including when it refuses an older Node, and refuses spellings that name different files after deleting each of them. The spawn refuses a foreign space, owner, actor or lifecycle UID, an unknown field, a wrong kind and a file that is not a private regular file before any broker connection or exchange request, then runs the enrollment-redeem consumer without redeeming or minting, and exchanges through `agent-bearer --exchange-url` unchanged. No refusal on that path echoes a value from the handoff: the registration's server, exchange and enforcement checks, the local state this machine keeps for the space (its mesh record, user-auth state and agent secret files), target resolution, the policy refresh, the broker preflight, the agent auth preflight and the event-plane policy each refuse with a fixed sentence naming the field and the phase, whether a check fails or a filesystem, exchange or broker error is thrown under it, and an actor that is not a single token or a space that cannot name local state is refused as malformed before any plane. Readiness stays presence-observed, so a lost create acknowledgement settles uncertain and stays held. Every stop of a delegated seat, the reap of a child whose parent exited and a destructive manager shutdown included, runs prepare-retirement, then the handle's fenced close by `managedRuntimeKey`, then the terminal barrier. A preservation cut refuses a delegated seat at prepare time, and a manager stop after a refused cut retires it the same way. A provider resource is bound to that key only by the provider's authenticated answer to its create. The design record, the embedding guide, the CLI and configuration references and SPEC §13.17 describe the shipped shape.
- c975258: A logged-in user can now run hosted workflows on a user-auth space. The auth callout issues an interactive user's `manager-caller` view as an issuance (SPEC 13.15): it chooses the generation, records evidence whose one source is the user's actor-ledger row, and writes the accepted row under a token derived from the connection's inbox nonce, renewing that generation on a reconnect whose ceiling is unchanged. `cotal run` and the other manager calls read the generation back with the new `issuedUserCaller` and ride `ep.v1`, so `cotal run start` against a participant manager started with `cotal supervise` is admitted. The issuing host admits a run from a user caller only for the manager's registered owner, and a participant manager now forwards the served subject of every caller resume and answer, which the host checks against the run's owner and the caller's live issuance; a legacy-rail resume is refused. The issuing host subscribes to those resume and answer request subjects itself and issues for a forwarded one only when it observed that request, only once, and only for the run a resume's envelope names or the endpoint and amendment an answer's envelope names, and never for a request bound to another manager instance or epoch or declaring another class or pinning another contract than the manager registered for that command. Every answering operator issuance must carry that served subject, and an amendment's carries `answers.amend: true`, which the host accepts only for a pause settled with an accepted answer, so `cotal run amend` works on a participant manager. A user caller starts, resumes and answers runs only on the participant manager that user registered, and a static caller keeps its admission there. A managed seat's manager call keeps the legacy rail when the broker refuses its accepted-row read, which surfaces as a request error caused by the permission violation. Revoking or re-granting the actor makes its issuances dead at the next resolution. New exports: `connectionAcceptedToken`, `actorLedgerSource`, `actorLedgerSourceBucket`, `parseActorLedgerSource`, `issuedUserCaller` and `isDerivedOwner` in core, and `ledgerActorSourceIsLive` and `UserCallerIssuer` in auth. `manager-caller` joins the issuable profiles, and the `issuer` profile gains the per-key read of the accepted store. SPEC §13.15 gains a **User-auth issuance** paragraph and §14.8 a **User-auth runs** paragraph, both insertions; `docs/design/user-auth-run-start.md` records the path, and `docs/cli.md`, `docs/workflows.md` and `docs/run-a-mesh.md` describe it. `docs/run-a-mesh.md` also says the stock auth service refuses managed-agent enrollment and retirement preparation for a host platform to intercept.

### Patch Changes

- 9d5cc09: First-run `cotal setup` now shares your own Claude Code MCP servers with the sessions Cotal spawns. It copies the user-scope servers from your Claude Code config into the cotal config's `connectors.claude.mcpServers` and names them in its output, so a spawned session has the tools you know plus the cotal tools. Before this, a spawned session loaded only the cotal server and setup never said why. With none to copy it writes an empty list, and a cotal config that already declares that list keeps it. A server with an `env` or `headers` value that is anything but `${VAR}` references is left out and named, because the cotal config keeps secrets only as `${VAR}` references. So is an entry no session can start, such as one with a missing or empty `command` or `url`, or one whose `command` is not a string. For a lighter seat, remove entries from the cotal config or spawn with `--share-tools none`. Connector setup providers gain an optional `mcpServers` action whose `seed` input the CLI binds to workspace's new `seedConnectorServers`, which writes under a lock so two setups run at once record one list. Core exports `readCotalConfigFile` and the `ConnectorShareSetupInput` type, and connector-core exports the `ENV_REFERENCE` pattern it already used.
- 22ed4c4: The `card-host` and `ep-rail-failure` smokes now wait for their broker to exit before removing its store. Both sent SIGTERM and removed the JetStream store on the next line, so the removal could walk a tree the broker was still writing during its graceful shutdown and fail the shard with `ENOTEMPTY` after every check had passed. Shipped behaviour is unchanged.
- 42d89b6: A `cotal up` refresh of a running mesh no longer reverts registry changes another command makes while it runs. The refresh rebuilt the whole record from a copy it read before ensuring the control plane, so a `tlsRequired: true` written in that window went back to `false`, a recorded `maxFileStore` was erased, and the command still printed `✓` and exited 0. A refresh now writes only what it decided (server, root, mode, user-auth endpoints, an explicit `--host` or `--max-sessions`) over the record as it stands at write time, so fields it does not set, including a registration's `policy`, are kept. If the record was removed during the refresh, `up` fails instead of writing it back.
- Updated dependencies [62ebc6b]
- Updated dependencies [22e210a]
- Updated dependencies [cb6a0bf]
- Updated dependencies [5738154]
- Updated dependencies [101c9b0]
- Updated dependencies [9d5cc09]
- Updated dependencies [c975258]
  - @cotal-ai/core@0.63.0
  - @cotal-ai/workspace@0.63.0

## 0.62.0

### Minor Changes

- b36bebf: `cotal spawn --detach` run from a managed seat's own shell on a static or open mesh now launches as that seat, so the manager records the seat as the spawner and the seat can stop the child with `cotal_despawn`, as it can a `cotal_spawn` child. Before, the CLI minted a one-shot operator instrument that no session could present again, and the seat's despawn was refused. `--on <instance>` keeps its pin on that path: on a static mesh the CLI mints a one-shot `manager-caller` view for the seat, pinned to that instance and carrying the spawn subject only when the seat's own credential holds it. On an open mesh the seat's call keeps the TLS requirement the mesh records, and `--server` with an unregistered `--space` keeps the operator path. Without `--space` the seat's target is picked as the operator path picks it, skipping a recorded mesh that is not running. The child is now stopped when the seat exits, and on a static mesh a seat without `capabilities: [spawn]` is refused. The seat-scoped control target that `cotal run` already used on a static mesh moves to `@cotal-ai/workspace` as `resolveSeatControlTarget`; `cotal run` keeps using it on a static mesh only. On a static mesh the seat's credential also proves its space, so a seat launched without `COTAL_SPACE` still acts as itself, as `cotal run answer` did before; an open mesh acts as the seat only when `COTAL_SPACE` names its space. See docs/UPGRADING.md.

### Patch Changes

- df6c53f: Unpinned CLI calls to a manager no longer fail when the class queue sends the describe and the invoke to different managers. A manager that receives a call bound to another instance refuses it before running it, and the CLI's manager commands (`models`, `stop`, `spawn --detach` and the rest), `cotal invoke` and the manager row of `cotal status` now re-describe and re-issue after that refusal, up to 16 times, instead of printing it. Before this, a space with three managers failed about two calls in three. The refusal still surfaces once every attempt has split, and a call pinned with `--on` is never re-issued.
- 25ef833: A foreground `cotal up` now restarts the delivery daemon it started when that daemon dies while the broker is still running, and logs that it did. The daemon ends itself once it cannot reach the broker, and a starved host can make a running broker look unreachable: under heavy load the daemon logged `broker connection unavailable past backstop` and exited, nothing brought it back, and from then on every stopped seat's retirement failed on the `ctl.delivery-admin` rail and every spawn of that name was refused as reserved pending retirement until an operator re-ran `cotal up`. A failed restart is retried after the 30-second delivery lease TTL, the longest a dead holder's lease can block its replacement. Recovery is announced only once the replacement's responder is bound. A daemon that exits cleanly or on SIGTERM or SIGINT stays stopped, and so does one stopped with `cotal down delivery`, also when `down` has to kill a starved daemon or the stop lands between two restart attempts.
- dd35543: `cotal meshes --json` prints one JSON object per recorded mesh per line, so a script no longer has to split the table, whose ROOT column can contain spaces. A row carries `space`, `server`, `mode`, `root`, `default` and `origin` (`up`, `manual` or `catalog`). A local or hand-registered entry also carries `offline`. A discovered entry is never probed, so it has none. `tlsRequired`, `events` and a discovered entry's `catalogName` appear when the record has them. An empty registry prints nothing and exits 0, and the note about a default that matches no record goes to stderr. `meshes add` and `meshes rm` refuse `--json`.

  The first-run connector seed now prints each `✓ added` line to stderr. Before, the seed wrote them to stdout ahead of the command that triggered it, so a first `cotal meshes --json` started with seven lines that were not JSON.

- 97a2382: The cotal config accepts a `modelPolicy` that names, per role, the models (and optionally the variants) a seat in that role may launch on. The manager refuses a detached spawn, and `cotal spawn` refuses a foreground one, before anything is minted when the effective role has an entry and the effective model is missing or not on its list, or its variant is missing or off a declared variants list, or the launch carries launch options (from `launchOptions:` or `--opt`), which the connector applies unread after the model and which can select another model. Ids compare whole, so `vendor/model-B-fast` does not satisfy `vendor/model-B`. The refusal names the persona, whether the value came from its own `model:` or `variant:` field or from `--model` or `--variant`, the value found, and the values allowed. Roles without an entry are unconstrained, a space-local entry replaces the operator-level entry for the same role, and a malformed policy (including an unsupported field of any name) fails the spawn loudly. Before this, a persona pinned to a superseded model, or to none, launched on it with no report.
- 877909b: A provenance line (`→ using`, `→ wrote`, `→ removed`) no longer fails or crashes a command when stderr is broken. When the stderr write throws or fails with an error such as EPIPE or ENOSPC, at once or after waiting in a full pipe whose reader goes away, the line is printed on stdout with the error and the command finishes its work. This holds for a write that throws a value that is not an Error, such as `null` or an object with no string form. It also holds when the program has already ended stderr, even if it exits in the same tick. When stdout fails too, the command still finishes its work and exits 1 instead of 0, so a line no channel could carry is never lost silently. The same holds for a line still waiting in a full stderr pipe when the command exits, as when the CLI exits on a closed stdout. A program that ends itself on a stdout error, as the CLI does, still stops at that error instead of finishing its work. Node does not say which stderr bytes are still waiting, so a line that had to wait and got through just before the exit counts the same while later stderr output still waits. A connector seed run with a broken stderr used to commit every payload and then exit 1 with nothing said, or stop after the first payload and require `cotal ext seed --repair`. A stderr that is closed or redirected away at launch still discards the line.
- 5ef9a67: Bare `cotal down` stops a stack whose manager runs the built-in `pty` runtime and has never started an agent. Since the `pty` runtime stopped using a seat custodian, its manager published no spare capability at all, so bare `cotal down` refused every default stack, left the broker running and kept the space registered, and the next `cotal up` of that space was refused as already in use. Ctrl-C on a foreground `cotal up` now holds the manager's stop reservation from its capability check until the manager exits, as `cotal down` does, so a concurrent `cotal down` cannot stop that manager or arm a reap while the Ctrl-C stop is in flight.
- 565036c: Let bare `cotal down` and Ctrl-C on a foreground `cotal up` stop a stack whose manager runs the built-in in-process `pty` runtime. That manager published no spare capability, so bare `cotal down` refused to signal it even with no agents running, left the broker up, and kept the registry entry; a default `Manager.stop()` threw on any pty seat. A default stop now stops and deprovisions the pty seats that live inside the manager process, since they cannot outlive it, and still releases every seat that can. The manager always publishes its spare capability, which now records whether its stop also stops in-process seats, and `down` reports those seats as stopped instead of left running. An older CLI refuses the new record rather than misreport those seats. A stopping manager refuses new spawns and waits for the ones it already accepted, so no seat launches after a stop that reported success, and `down` no longer promises that agents will be spared when it cannot list them. Repeated `Manager.stop()` calls share one stop, so a second call no longer reports success while the first still waits for a seat to exit.
- eeb898e: The up-resume-render-lock live smoke now also resumes a foreground `cotal up` after a second `cotal down --preserve-state`. A foreground resume that skips recreating the memory-backed presence bucket now turns it red, the way a `--detach` resume that skips it already did.
- Updated dependencies [bcf66d6]
- Updated dependencies [97a2382]
- Updated dependencies [877909b]
- Updated dependencies [5ef9a67]
- Updated dependencies [565036c]
- Updated dependencies [9236a12]
- Updated dependencies [b36bebf]
  - @cotal-ai/core@0.62.0
  - @cotal-ai/workspace@0.62.0

## 0.61.0

### Patch Changes

- @cotal-ai/core@0.61.0
- @cotal-ai/workspace@0.61.0

## 0.60.0

### Patch Changes

- 3b616a2: A manifest agent can declare `continuity: exact` to come back in its previous harness session. The manager records the session the connector proves over its authenticated control endpoint on the first launch, keeps that record current through crash recovery, preserved resume and stop, reopens it on every later launch and preserved resume under the same proof, and refuses one recorded for another space, connector or directory. A reopen fails when the harness no longer has the session rather than starting an empty one under the same id: connectors declare the new `supportsSessionReopen` capability and honor `LaunchOpts.reopenSession`, and Pi reopens with `--session`. Preflight refuses `exact` on a connector that cannot reopen an existing session.
- Updated dependencies [3b616a2]
- Updated dependencies [6ca4d8e]
  - @cotal-ai/core@0.60.0
  - @cotal-ai/workspace@0.60.0

## 0.59.0

### Minor Changes

- 70bcfe3: Breaking: `cotal actor grant` no longer turns an omitted ACL flag into the wide default, so a bare grant that used to succeed now needs `--full`. A grant must name `--scope`, `--allow-subscribe` and `--allow-publish`, or pass `--full` to take `spawn,role:default`, `>` and `>` for the ones left off. Otherwise it refuses, writes nothing, and prints both forms. Dropping one flag from a narrow event-plane reader grant used to mint a row that read or posted to every channel, or could spawn, with a success line as the only sign. The hints printed by `cotal login`, `cotal status`, `actor list` and the not-granted refusal now include `--full`.

### Patch Changes

- 1cf7f72: `ConnectRefusal` now carries a `kind`: `transient` when the broker could not be reached or answered too slowly, or no mesh is recorded yet, and `permanent` for every other refusal. A `cotal attach` that is reconnecting after its link died now exits non-zero with the refusal's own sentence when the refusal is permanent, such as a static-auth mesh whose seed has gone missing. It used to retry that forever behind `[cotal: connection lost, reconnecting]` with no explanation.
- fe90b42: `cotal attach` now puts the terminal in raw mode when it starts reconnecting. If the link died after `attached to` printed but before the first session was ready, the terminal stayed cooked for the whole reconnect, so the detach key echoed as `^]` and did nothing until a later session opened.
- 5bec8b2: `cotal attach` now opens a seat's session on a user-auth mesh. The CLI presents its bearer identity together with the session grant to the auth service's exchange, which issues a `session-caller` view bearer only after it confirms, against the redeemed `session.<id>` row and the serving manager gate, that this owner and actor hold that session. The callout re-checks the same row and mints the same `session-caller` rails with the grant's expiry that the static path mints. No local seed is read or written.
- 6c01470: `cotal backup create` no longer refuses a cut because the presence bucket is missing. The bucket is memory-backed, so it does not survive the broker stop that makes the cut. Backup now accepts that stream as absent from the stopped store and still requires every other stream exactly. Restore still requires presence after it recreates the space's infrastructure.
- cfc3b95: `cotal status` now has one Machine row per installed connector instead of fixed `Claude` and `OpenCode` rows. Each row reports whether the executables that connector declares in `requires` are on PATH, so a machine running Codex, jcode, pi or Hermes sees its harness. The `Claude plugin` and `Claude skills` rows now come from the Claude Code connector: a setup provider may declare a read-only `status`, and `cotal status` and the setup card print the rows it returns. A machine without the Claude connector no longer shows them. The extensions manifest caches each connector's setup ref, so status imports only connectors that declare a provider, and the seed reconcile refreshes a seeded entry whose cache predates it instead of checking the Claude connector by name. The debug handoff that `cotal setup` offers when a step fails now comes from connectors: a setup provider may declare an `assist`, and the menu offers one `Debug it with <harness>` option for each present connector that declares one. The Claude Code connector declares the existing Claude handoff. When no connector can host a handoff, the menu says so instead of silently omitting the option.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
- b4c69bf: A seat whose turn died on a harness-reported error now shows it on every operator surface. A Jcode seat relays the Harness error code, such as a provider `rate_limit`, as its presence `condition`, both for a turn the host drives and for one the TUI owns. `cotal ps` now carries that condition: the human row reads `waiting (rate_limit)` and `--json` rows include the `condition` object, alongside the roster, `cotal status` and `cotal endpoints`. The next turn clears the condition when it starts. Before, the seat read a bare `waiting` and the error was recorded only in its private connector log.

  Presence gains an optional `activeAt`: the epoch ms of the last work event the harness reported, carried on the next heartbeat. A Jcode seat records every token and tool event of its session there. `cotal ps`, `cotal status`, `cotal endpoints` and `cotal_roster` now print a condition with its age and the age of the last work event, such as `waiting (rate_limit for 40m) · active 40m ago`, and `cotal ps --json` rows carry `activeAt`. A turn that stopped advancing while its process keeps heartbeating no longer reads like one that is still working.

- 5f13124: Private launch files now have an owner. The Claude persona file, the Claude shared-server MCP config file and the pi persona file are listed on the new `LaunchSpec.artifacts`, and the launcher removes them once it has proved the agent process gone. On the default pty runtime the manager removes them when it sees the agent exit; on tmux, cmux, orca and herdr the manager removes them by polling the seat's status and waiting for the runtime's exit proof; the foreground `cotal spawn` removes them when its child exits. Every one of those launches also starts its child through the new core `reclaimWithChild`: a watcher started beside the child removes the files once the child's process is gone, and tries a failed removal again every five seconds until it succeeds, so a killed manager or foreground `cotal spawn` no longer strands them (POSIX; Windows has no shell for the watcher). Each directory name carries a random per-launch identity, so a stale path can never name a later launch's directory. The tmux, cmux, orca and herdr runtimes now throw the new core `SpawnRefused` for an unsafe name, an unreachable backend, (herdr) a missing working directory or an unknown layout, (orca) a working directory that is missing or outside any Orca worktree, and a launcher script they cannot write or (tmux, herdr) a session or server that will not start, all before the agent's command is handed to the backend, and the manager removes the files at once. A removal that fails, after an exit or after a refusal, is tried again until it succeeds. A batch resume removes the files of specs it built and never launched. Both connectors now refuse a bad model, prompt or launch option before writing anything. Any other spawn that throws is not proof that nothing started, so its files stay for the child's watcher, or for the OS temp reaper when no child started, as do a killed launcher's on Windows. A seat started under a custodian with `launchSeat` from `@cotal-ai/seat`, which the manager no longer does for a new launch, hands them to that custodian: a launch it refuses before any process started removes them at once, the custodian removes them when it sees the agent exit, a removal that fails stays on the custody record, and a reap that proves the seat gone removes what the record still lists from the temp dir the launch wrote to, so a successor with a different `TMPDIR` still removes them. Losing a custodian's connection no longer counts as the agent's exit. The docs now say that owner-private means any process running as the same user can read the file while it exists.
- 4d2dcae: The systemd user unit that `cotal service install` writes now sets a start limit (`StartLimitIntervalSec=30min`, `StartLimitBurst=20`), so a manager that cannot start stops after 20 attempts instead of restarting every 20 seconds forever. The manager's restart eviction also stops reporting a delivery daemon that answered and refused as "not reachable on the ctl.delivery-admin rail" with advice to start the daemon. A refusal now carries the daemon's own reason, such as a missing `$SYS` cred and how to re-mint it, and only a rail that cannot be reached is reported as unreachable. A manager that cannot verify eviction of its predecessor still exits 1 with the gate frozen (SPEC 13.1).
- 06f48f4: CLI output is plain text when stdout is not a terminal or `NO_COLOR` is set to a non-empty value. The shared color helpers used to wrap every string in ANSI escapes, so `cotal --help`, `cotal status`, `cotal meshes` and the red error lines on stderr carried escapes into pipes and log files. The manager's and the delivery daemon's own always-on copies are gone; `cotal supervise` and `cotal feedback-intake` now print through the same helpers. The guided `cotal setup` and `cotal meshes add` prompts follow the same rule, so `FORCE_COLOR` now reaches them too. `FORCE_COLOR` turns color back on even when output is piped, unless it is `0` or `false`, and it takes precedence over `NO_COLOR`, the order Node uses.
- fb1bc26: Let a credentialed peer ask which plane is broken, instead of guessing at its own credentials

  The subjects that answer "is the manager alive" are owner-only, so a peer holding perfectly valid
  credentials could not ask. When its join or its send failed, that peer could not tell a credential
  problem from a dead manager, an unbound delivery daemon, or a broker that was entirely healthy, so
  every failure presented as a credential failure, because that was the only hypothesis it was able to
  form. A reporter running a 30-agent deployment for a week recorded six independent surfaces that each
  reported success over a failure, including a `pgrep` that matched its own command line and therefore
  failed in both directions. In every case diagnosis cost hours rather than minutes, and in every case
  the missing piece was the same: nothing could be asked whether it was alive by anyone who did not own
  it.

  A read-only liveness surface now answers that question. A peer sends a presence probe on
  `live.<plane>.<owner>.<actor>` and learns whether the manager and the delivery daemon have bound
  responders for the space. It is shaped like the Synadia micro protocol's `$SRV.INFO`, a well-known,
  read-only, presence-only request/reply probe, but it rides a Cotal subject inside the space rather
  than the literal `$SRV` tree, which sits outside per-space account isolation and outside every grant
  builder and subject audit the system already enforces.

  Presence is the whole answer. The reply carries the plane, one responder verdict and an opaque
  per-bind responder token (below), and nothing else: no holder, no pid, no workspace root, no
  runtime, no roster, and no instance id, since the token is minted from nothing and names no
  instance. That is why the probe is a
  request rather than a lease read: the manager's lease row carries the operator's filesystem path and
  a process id, so the responder reduces it to a single enum and the row never crosses the wire. A peer
  gains no read of either lease bucket, cannot probe under another principal's identity, and cannot
  subscribe the responder's serve filter to answer for a plane it does not own.

  Unknown stays first class, reusing the classifier `cotal status` already grades by. Only the broker's
  own no-responders answer becomes "unbound"; a timeout, a permission refusal or an unreadable reply
  all become "unknown", because each is a failure to find out, and reporting a failure to find out as
  health is the defect this surface exists to remove. A responder that cannot determine its own state
  says so rather than guessing, and a reply is never counted as health merely for having arrived.

  The reply also names which responder answered it, as an opaque per-bind token and not an identity.
  Manager instances coexist per instance id, each responder answers only about itself, and the queue
  group hands one probe to one arbitrary member, so two instances holding opposite verdicts made
  identical probes alternate with nothing in the answer to say a second instance existed. With the
  token a caller that probes more than once can tell two responders apart from one responder that
  changed state. One probe still samples one responder and cannot report a split by itself.

  SPEC §6.1 defines the `live` subjects, the `LivenessAnswer` reply and its grading, and the
  message-flow docs page describes them.

  A remote manager can now answer the probe it already binds. It runs the same start path as a local
  supervisor, so it binds the manager plane's responder, and its credential carried neither the serve
  subscription nor the bounded reply row. The subscription was denied and a peer asking about the
  manager plane received the broker's own no-responders answer, which grades "unbound": a definite
  verdict about a plane that was in fact bound, produced by a gap in a credential. Both rows are now
  on that profile, pinned to the supervisor actor that does the serving.

  The responder's rejection notice for a reply target outside the sender's own subtree now travels on
  the endpoint's non-fatal warning channel. It was emitted on the `error` channel, and Node's
  `EventEmitter` rethrows an `error` emitted with no listener attached, so an embedder that had not
  attached one ended its process when a peer sent a probe naming such a target. The plane was then
  genuinely unbound and the next probe reported it as such, so the notice manufactured the state it
  described. The guard's behaviour is unchanged: the frame is dropped and the responder keeps serving.

- 438e9ed: Close the pid record publish window. A launcher that died between removing the old identity pin and publishing the new pidfile left the old pid with no pin, which teardown signalled with only a legacy warning, even when the removed pin had been refusing a reused pid. The publish now renames a bridge pin holding the old and the new record's lines before the pidfile commit, and teardown checks the pidfile's pid against its own line, so every crash point leaves the old or the new complete record. Publishes of one pidfile are serialized by a lock, so a launcher and the daemon it starts can no longer overwrite each other's bridge or settled pin. A publish that cannot read a start token for the new process gives it a `-` pin line, so a crash after the commit reads the legacy record it was publishing, never the new pid beside the old pin. Replacing a legacy record carries its line as `-`, so an interrupted replace leaves it legacy, never torn. Teardown and a daemon's exit cleanup remove a record under the same lock, and only while the pidfile still names the pid they stopped, so a stop that races a publish can no longer leave the new pidfile with no pin. `removeIdentityPin` is deprecated in favor of `removePidPair` and stays exported unchanged for one minor line.
- 15c16ff: Create the presence KV bucket in memory storage, at `cotal up`, at restore and when an open-mode endpoint creates it. A file-backed presence bucket could latch a broker write error that refused every later presence write, and so every new join, until the broker restarted. A bucket created file-backed by an older version keeps file storage until its stream is recreated. `cotal up` now warns about a broker below nats-server 2.14.5 only when the space's presence bucket is still file-backed.
- 8ce6be3: The 0.33.0 changelog entry "An agent now reads only the channels it lists" now carries a correction. It presented the read-set default-deny as new in 0.33.0, but that shipped in 0.28.0 with #821, so upgrading from 0.28.0 or later needs no migration for it. The correction names what 0.33.0 did change: the no-default-channel check in `multicast` now refuses only an omitted channel, so an explicit empty-string `channel` is no longer refused as if it were omitted, and its refusal is reworded; the `cotal_send`, `cotal_leave` and pi tool text; doc comments; and two regression suites. `docs/release.md` now describes how to correct a released entry.
- 569cb6f: A `--resume` seat's fork provenance is recorded on the manager. `LaunchSpec` gains `resumeRecordPath`, where a connector whose seat forks after launch has it record the source session id, the source title and a SHA-256 of the transcript it read; the Hermes and Jcode connectors declare it. The manager reads that record once the seat has written it, keeps it on the seat's resume document (an optional `resumed` field, so earlier documents still resume), and adds a `resume` object to the `ps`/`inspect` row (manager cluster revision 20). `cotal ps --wide` prints `forked from <id>` with the title and hash, and the Hermes and Jcode seats print the same facts when they fork. The Jcode fork now carries a count above 2^53 byte for byte instead of rounding it, refuses a count outside the u64 range by name, and refuses a fork record that is not an object by name.
- ffdb45c: Recreate the memory-backed presence bucket when `cotal up` resumes a `cotal down --preserve-state` cut. The broker stop empties a memory stream, and the resume skipped stream setup because the preserved store held every other stream, so the delivery daemon died on `stream not found` and the resume stopped in `resume-degraded`.
- add9984: A managed seat that leaves the mesh while its process keeps running now says so. `cotal ps` prints how long the seat has been offline (`mesh offline for 3.5h`), and `--json` carries the seat's last presence heartbeat as `offlineSince`. The manager log gets a `seat offline on the mesh` line for each such seat, including one its watch first sees offline after a reconnect, and a `seat back on the mesh` line when it returns. Both read only the seat's own presence record, so a same-named peer never dates or logs for it. Before this, a seat could read `running · mesh offline` for days with nothing saying when it dropped, so a watchdog that checked process liveness saw nothing wrong.
- 6cf0ca1: `cotal service install` on Linux no longer reports success for a unit that will not start at boot. Without lingering, systemd starts no user manager at boot, so the enabled unit stayed inert until the user logged in, while install printed `✓ service installed` and only a hint to pass `--linger`. Install now checks lingering before it writes anything and, when lingering is off, fails with the root command that turns it on (`sudo loginctl enable-linger <user>`). A `--linger` that logind refuses fails the same way and no longer leaves the unit installed and enabled behind the error. `service status` prints the same command while lingering is off. A Linger query that fails or prints anything but `yes` or `no` (logind unreachable, no `loginctl`) is not read as off: install refuses with the query's own error and enables nothing, and `service status` shows lingering as unknown with that error.
- bd8ad18: `cotal service install` now pins the installing shell's `PATH` into the unit: a `PATH` line in the systemd `EnvironmentFile`, and a `PATH` key in the launchd plist's `EnvironmentVariables`. The unit used to inherit the service manager's own `PATH`, which usually lacks `~/.local/bin` and Homebrew, so a service-run manager reported a harness such as `claude` unavailable at boot even though the shell that installed it resolved the binary. A relative `PATH` entry, including an empty one, is resolved against the directory `install` ran from, because the unit starts in the mesh root where the same spelling names another directory. An entry with a `..` segment is pinned as the directory the shell reaches through it, with symlinks followed, and refuses the install when it reaches none. A `PATH` set to the empty string is one empty entry and pins that directory. An unset `PATH` refuses the install.
- 6145abc: Resume a preserved user-auth mesh as the logged-in operator. `cotal up` after `down --preserve-state` used a static instrument whose caller has no ledger row, so the manager refused `resume-preserved` for want of `admin` and the maintenance journal degraded. The resume now uses the operator's manager view, the same caller the preserve cut used.
- Updated dependencies [70bcfe3]
- Updated dependencies [1cf7f72]
- Updated dependencies [5bec8b2]
- Updated dependencies [6c01470]
- Updated dependencies [cfc3b95]
- Updated dependencies [b669a73]
- Updated dependencies [350c87b]
- Updated dependencies [608f5f4]
- Updated dependencies [43c4179]
- Updated dependencies [4a12111]
- Updated dependencies [569cb6f]
- Updated dependencies [b4c69bf]
- Updated dependencies [f485c49]
- Updated dependencies [5f13124]
- Updated dependencies [fb1bc26]
- Updated dependencies [c389563]
- Updated dependencies [06f48f4]
- Updated dependencies [eb2681e]
- Updated dependencies [fb1bc26]
- Updated dependencies [438e9ed]
- Updated dependencies [446ed23]
- Updated dependencies [15c16ff]
- Updated dependencies [8ce6be3]
- Updated dependencies [08194ec]
- Updated dependencies [aa12a1a]
- Updated dependencies [d90f9f2]
- Updated dependencies [499bd8a]
- Updated dependencies [569cb6f]
- Updated dependencies [d0b1da3]
- Updated dependencies [37075a2]
- Updated dependencies [8d8d69a]
- Updated dependencies [c7bfc2d]
- Updated dependencies [6145abc]
  - @cotal-ai/workspace@0.59.0
  - @cotal-ai/core@0.59.0

## 0.58.0

### Patch Changes

- fba1537: A repair `up` after a broker died reopens the store the mesh record names and refuses a different `--store-dir`. A foreground `up` whose broker exits unexpectedly keeps the mesh record, names the exit and the repair, and exits non-zero.
- 576f622: A process's pidfile and its identity pin now publish as one rename-based transition, so a crash between the two writes never leaves a torn pair (old pid beside a new pin, or a new pid beside an old one). A crash still leaves one of the legacy shapes teardown already handles.
- 2457692: The broker floor SPEC §13.12 states is now enforced on every endpoint connection, the provisioning connections and `cotal up`, and `cotal up` names a broker below 2.14.5 as one whose presence bucket can latch.
- 7687fef: A refused re-exec no longer leaves a pid record, a daemon log or a seed journal entry behind, and
  the entry check no longer trusts a file name

  The entry check in `selfArgv()` accepted any file named `cotal`, `cotal.ts` or `cotal.js`, so an
  unrelated file with one of those names could still re-exec itself as a daemon. The entry now counts
  only when it resolves, through any symlink, to the bin that the `cotal-ai` package declares
  (`dist/cotal.js`) or to the `cotal.ts` beside that package's manifest (a checkout's
  `bin/cotal.ts`). A global install's `bin/cotal` symlink resolves into the package and is still
  accepted.

  Four paths ran the check only after they had changed something, and now run it first:

  - The auth-service starter published its pid slot, already naming the launcher, before the check.
    A refused start left a record that read as a running service, so a retry started nothing, and
    teardown would signal whichever process held the launcher's pid.
  - The connector seed wrote its crash cursor, staged the payload and wrote a pending child marker
    before the check. The next command then failed with "a connector seed may be mid-flight", and
    `cotal ext seed --repair` refused the same way until the marker was removed by hand.
  - The manager and delivery starters deleted dead pre-upgrade records (their pidfiles and the
    delivery-aware marker) before the check.

  The refusal's remedy line now names `ensureAuthService` along with the other starters.

- Updated dependencies [0589316]
- Updated dependencies [59a7e64]
- Updated dependencies [95ae645]
- Updated dependencies [fba1537]
- Updated dependencies [576f622]
- Updated dependencies [2457692]
- Updated dependencies [ee6de5d]
- Updated dependencies [e9ef5b3]
- Updated dependencies [7c54825]
- Updated dependencies [2c31f95]
- Updated dependencies [397bc60]
- Updated dependencies [7b3924c]
- Updated dependencies [1721738]
  - @cotal-ai/core@0.58.0
  - @cotal-ai/workspace@0.58.0

## 0.57.0

### Patch Changes

- e7c702a: The jcode connector now reports the provider route serving a seat's model to presence, and `cotal ps --wide`/`--json` surface it as `provider`.
- 6f64bcc: The manager's `slots` command and `cotal ps --slots` list a static manager's durable static slot rows, projected the same way `inspect` reports a stranded name.
- 42448fa: A DM send now reports the stored sequence and the recipient's status at send instead of a bare success, and `cotal deliver pending <name>` reads a recipient's held DMs from the broker.
- Updated dependencies [e7c702a]
- Updated dependencies [6f64bcc]
- Updated dependencies [42448fa]
- Updated dependencies [33357d9]
  - @cotal-ai/core@0.57.0
  - @cotal-ai/workspace@0.57.0

## 0.56.1

### Patch Changes

- a4c5ffa: A `--config` spawn now records the persona's identity name as its preservation ref instead of the config path, and a preservation prepare that later refuses aborts the manager's attempt and clears the prepare intent so the mesh stays usable for the next `down --preserve-state`.
- Updated dependencies [6b76946]
  - @cotal-ai/core@0.56.1
  - @cotal-ai/workspace@0.56.1

## 0.56.0

### Patch Changes

- ccf3d5f: `cotal attach` recognises the detach key when the terminal encodes it as a kitty keyboard protocol or xterm modifyOtherKeys sequence, in the session reader and in the between-sessions reader, keeping the whole-chunk match so a paste carrying the byte is still data (#598).
- a42a5e8: A one-shot `cotal send` presents `<login>@<host>` as its display name instead of the fixed `cotal-send`, so a recipient can attribute a DM, a channel post or an ask to the shell that sent it; the wire principal is unchanged (#680).
- 0cf1cf3: `cotal describe` accepts `--on <instance>` and pins the describe to that manager instance's rail, printing the same attributed surface, so an operator can read what one instance of a multi-instance endpoint serves (#554).
- ac53a09: `cotal update` no longer reads a remote user mesh's manager for continuity, since that manager runs
  under another install and its exchange's answer cannot change the local install; the mesh is named
  and skipped, and the install proceeds. A refused remote exchange that supplies no reason now says
  the face withheld it instead of presenting the HTTP status as the reason (#2158).
- 4e1c8f5: `cotal status` asks the manager's service endpoint before printing its row, so a live manager process whose rail does not answer reads `not serving` instead of `running`, and the `--components` probe mints its lease-read credential with a lifecycle uid so it is no longer refused on a static mesh (#2073).
- 8dc7c92: `doctor auth --fix` takes the mesh's one daemon-credential renewal lease before it re-signs when the broker answers, refuses with the live holder and the recovery named while a manager or another doctor holds it, and records and prints an explicit offline repair when the broker does not answer (#1063).
- 99cad7b: A membership watch that closes after setup now reaches its caller through a second callback on `watchMembership`, instead of leaving the caller holding a stale snapshot with no signal. The dashboard broadcasts the existing membership-read-failed event and the console marks the feed unreadable, instead of both keeping the last snapshot silently (#485).
- b2453f4: `--on` now refuses a malformed manager instance id at the flag with a message that names the identifier it wants and where `cotal ps` prints it, instead of the mint's bare grammar error; a roster principal id (`local.…`) is named as such (#423).
- Updated dependencies [e506040]
- Updated dependencies [8dc7c92]
- Updated dependencies [99cad7b]
- Updated dependencies [1218786]
- Updated dependencies [ef8889d]
  - @cotal-ai/core@0.56.0
  - @cotal-ai/workspace@0.56.0

## 0.55.0

### Minor Changes

- 17d066f: `cotal mint` can bound a credential's lifetime and re-mint for an existing identity. `--expires-in <seconds>` (or `--expires-at <unix-seconds>`) threads the lifetime the core mint seam already takes, so an out-of-band credential can satisfy a standing-renewal consumer that requires an `exp`; the two flags are mutually exclusive and an invalid value is refused before anything is written. `--identity <creds>` re-mints for the nkey the file carries (read by core's own creds loader), keeping the principal so every durable keyed to it survives. Fixes #1256

### Patch Changes

- e1351c2: Take a DM sender's display name and role from the roster by authenticated id instead of the message payload, so one peer cannot spoof another's name or role in the CLI DM lens or the web feed.
- 427a848: Gate the event plane on the typed spawn contract behind the caller's admin tier on a user mesh (#373): a non-admin caller asking for `events: true` is refused before anything is provisioned, an omitted bit is served unarmed with a notice in the reply, and a space whose policy requires events refuses non-admin spawns outright. The CLI's detached spawn now sends the events bit only when the operator chose it and prints the reply's notice.
- 391af1d: `cotal up` now names a manager it restored, distinctly from one it found already running (issue #883). `ensureManager` returns `started`/`pid` instead of collapsing the reuse and launch branches into the same `{ running: true }`, `ensureDelivery`/`ensureControlPlane` carry the same fields through, and a refresh that restores a missing manager prints `✓ restored in the background: manager (pid N)`; a refresh that finds everything running still prints only the `✓ mesh "<space>" already running` line.
- d5ef965: `cotal up`'s refusal for a hand-registered space now names `cotal supervise --space <s> --server <url>` (and `cotal deliver`) when the registered broker is on another host, instead of `cotal meshes rm`, which would drop the registry route a live remote mesh is addressed by. A loopback registration keeps the prior wording.
- d284ee6: A manifest or spawn prompt on a connector that cannot deliver one is refused at preflight (including `up -f --dry-run`), at spawn and in the manager, the way an unsupported model variant is: connectors now declare `supportsPrompt`, and claude, opencode, codex, jcode and pi declare it; hermes keeps its launch-time throw as the second line of defence.
- 4de65c9: Refuse unsafe seed generations and keep staged seed payload paths inside the durable store.
- cbb7087: The up-resume-render-lock live smoke exits on its own after its verdict, because the timers it raced against its children's exits are cleared when the child exits instead of keeping the process alive until the longest of them fires.
- Updated dependencies [888e9bc]
- Updated dependencies [810814b]
- Updated dependencies [8472dc3]
- Updated dependencies [f272f71]
- Updated dependencies [a83dd80]
- Updated dependencies [db9a969]
- Updated dependencies [d284ee6]
- Updated dependencies [4f48629]
- Updated dependencies [2e13607]
- Updated dependencies [d3d6742]
- Updated dependencies [fd58782]
- Updated dependencies [357af9f]
  - @cotal-ai/core@0.55.0
  - @cotal-ai/workspace@0.55.0

## 0.54.0

### Minor Changes

- 34beea1: Route user-auth manager calls through a short-lived, instance-bound control credential. Discovery and invocation address the same authorized manager while the agent's standing connection, credentials and conversation remain unchanged. Managed launches retain their manager selection across launch and resume. Static and open mesh routing is unchanged. Confirm the standing goal-progress subscription at the broker before submitting on the separate control connection, so fast terminal events cannot outrun the subscription. Recover accepted goal results through the manager's caller-scoped `goal-result` command after connection replacement, without repeating the mutation or granting clients raw JetStream reads. Followed calls now require a compatible manager before submission; update the issuer, participant manager and client together. Stopping a caller cancels its observation without cancelling the accepted goal. Retain Linux custody records across clean child exit so retirement can prove process identity and finish cleanup even after the custodian removes its file; socket loss alone never frees the alias.

### Patch Changes

- Updated dependencies [e6badb8]
- Updated dependencies [34beea1]
- Updated dependencies [b4317fd]
  - @cotal-ai/core@0.54.0
  - @cotal-ai/workspace@0.54.0

## 0.53.0

### Patch Changes

- Updated dependencies [d1f9703]
- Updated dependencies [104921c]
- Updated dependencies [83617ab]
  - @cotal-ai/workspace@0.53.0
  - @cotal-ai/core@0.53.0

## 0.52.1

### Patch Changes

- 5784ec9: Bind the user-auth service readiness wait to the daemon process, not a clock alone. A same-root `cotal up` refresh run right after a broker reload killed the old auth-service daemon used to give up at a fixed 15s while the replacement daemon it launched was still binding, then a second identical `up` succeeded: a one-shot false "auth service not ready". `ensureAuthService` now passes the pid it launched (or found live) into the provider's `ready()`, which waits past the base timeout up to 60s while that pid is provably alive, ends the wait at once when the pid exits ("exited before becoming ready"), and refuses at the bound naming the live pid, the pid record, and the service log ("alive and still starting"). `AuthServiceSpec.ready` in core gains optional `pid`/`maxWaitMs` inputs; callers that pass none keep the old clock-only behavior.
- 78d10d2: Spare managed agents on Ctrl-C of a foreground `cotal up`: verify the manager's spare capability, leave the seats running, and print the same left-behind report as bare `cotal down`, with teardown awaited before the broker is signalled.
- 3b97cd1: Refresh saved space catalogs lazily for every mesh-target command, scope discovered-space operations to their own account, show per-account status, and describe the selected mesh in setup.
- Updated dependencies [5784ec9]
- Updated dependencies [f17791d]
  - @cotal-ai/core@0.52.1
  - @cotal-ai/workspace@0.52.1

## 0.52.0

### Minor Changes

- 6595c48: The console can drive the mesh as well as watch it. Every operator action (kill, spawn, status, purge, channel delete, attach) rides the CLI's own per-action control path over the endpoint rails, never the observer, using only the manager commands that already exist; `a` attaches through the full `cotal attach` loop in place; on an open mesh the operator's first send starts a presence-only peer under the observer's card so agents can reply, with concurrent sends sharing that startup result; multi-manager reads keep silent instances separate from reachable error replies; the topology lens overlays the broker-authoritative membership feed and says live, stale, traffic-only, or unreadable; channel tabs carry unread badges, the roster tags each agent's harness, the agent detail lists runs, model, and skills, and the status bar draws a 60-second activity sparkline.

### Patch Changes

- a08528a: `cotal up --no-manager`: an explicit broker-only boot. The flag starts the broker and, in auth mode, the delivery daemon, and no local manager, on every `up` path (fresh boot, `--detach`, refresh, `-f` manifest). A refresh under the flag of a mesh whose manager is live refuses with the `cotal down manager` remedy rather than silently keeping or stopping it. `--runtime` and `--max-sessions` are refused beside it, and a manifest declaring agents under it is refused before anything boots. The `--detach` summary lists only what actually started, and `-f --dry-run` prints the omission. Fixes #1417.
- 1d2daa6: Bare `cotal down` names a registered live broker that answers when this stack holds no pidfile for it, whether or not other owned components were running: those stop and clear their artifacts first. It prints the space, the broker address, that no pidfile records the process, and that it will not stop a process it did not start, then exits 1. The broker is left to whatever started it.
- 600216a: The setup finale, the `cotal up` closing line, and the onboarding docs (Quickstart, README, Watch a mesh, docs index) now lead with `cotal web` as the watch step of the loop and name `cotal console` as the terminal alternative, instead of putting the terminal console in the loop and mentioning the dashboard as an afterthought. The Quickstart loop is four commands: start, talk, watch in the browser, stop.
- cf5a5cb: The renewal record is per-space: `renewalRecordPath(root, space)` now writes and reads `.cotal/renewal.<spaceKey>.json`, keyed by the same injective hex the pidfiles use, and every writer and reader threads the space — the manager's renewal pass, `doctor auth --fix`'s write, `doctor auth`'s verdict reads, and `status --components`' delivery row. Before, one root-scoped `.cotal/renewal.json` served every space at a root, so with two spaces co-resident the last pass won: a refused adoption in one space was reported as accepted once the other's manager ran a clean pass, and the mirror case reddened a healthy space's doctor. A root-only `renewal.json` left by a pre-per-space build names no space and is never read as any space's verdict; `doctor auth` names it as a leftover with its cleanup, and `cotal clean all` removes it beside the per-space record. Fixes #1850.
- 7940589: `cotal agent-bearer` skips the connector-seed boot gate. The helper is exec'd by a spawned seat on every bearer refresh, so a seed store stamped newer than the invoking binary refused its boot before the token file was read and a live seat died at its token expiry, while a matching generation made the credential exchange write every connector payload into the operator-global store. The skip is by command name (like `ext root`), with no environment flag: the helper reads one 0600 token file, exchanges it and prints the bearer without consulting or mutating the store. The generation guard and the auto-seed on operator-facing commands are unchanged. Fixes #1857.
- ab0808c: `cotal up --max-file-store <bytes>` sets the broker's JetStream file storage cap. Before, the rendered broker config carried only `store_dir`, so nats-server always sized its store at start as three quarters of the free disk and an operator on a shared disk had no supported way to bound it. `serverConfig` and `openServerConfig` take an optional `maxFileStore` byte count and render `max_file_store` inside the `jetstream{}` block; left unset, the rendered config is byte-identical to before, and a zero, negative or non-integer value throws naming the option. The cap is recorded on the mesh entry, carried through `down --preserve-state` into the resume, and rendered again by the bare `cotal up` that resumes it. A resume or a refresh of a running mesh that asks for a different cap is refused, because nats-server fixes the cap at start and refuses a reload that changes it. The flag is refused with `-f`. Fixes #1888.
- 4a41fd5: `cotal spawn` (foreground, user-auth mesh): the launch line now names what cleanup does on the arm that printed it. The local arm keeps its sentence (the actor row is revoked automatically on exit). The remote arm (a one-time enrollment or the advertised agent-provisioning endpoint) no longer promises that revocation: its sentence says this machine's credential files are removed on exit and the grant stays until the mesh operator revokes it, which is what its cleanup does. No cleanup behavior changed on either arm. Fixes #1837.
- 6b375c8: `cotal update` reports every running manager's continuity, and its refusal carries the remedy

  With several meshes running and the shell outside every project root, the continuity check printed
  the mesh resolver's bare text and exited before writing anything. It now renders that refusal through
  the workspace renderer, the way every other command does, so it carries the `--space` / `cotal use`
  recovery sentence. And because the install replaces the single `cotal-ai` that every running manager
  shares, an unselected run now reports each running manager in turn instead of refusing, with any
  `legacy` verdict making the whole run not a hot update. `--space`, `--server` and `--creds` still
  select exactly one manager, and nothing is written until every selected manager has been observed.

- 50998a8: `cotal status` answers for a user-auth space whose material is a remote registry entry (a discovered space or a `meshes add --from` registration) instead of a local provisioning: the bare-status login row shows the signed-in subject from the entry's pinned IdP (grant reads as "not checkable on this machine", since the ledger runs where the space was provisioned), and `status --components` probes the manager as the signed-in login — the same credential `ps` uses — instead of minting static creds or connecting with none. A user-mode components row that cannot obtain that credential states the reason on the row (verdict `refused`), never a raw Authorization Violation. In user mode the manager row grades `serving` on the manager's own typed service answer, because the manager-lease sweep is a host credential an interactive bearer does not hold. The bare-status delivery responder axis stays `unknown` in user mode, as its comment states. Status still never static-mints on a user-auth mesh, and a signed-out machine still gets the offline "not signed in" row with the exact login command and no network round trip. Refs #1832.
- Updated dependencies [5ee8eef]
- Updated dependencies [2e7558d]
- Updated dependencies [5b2c19f]
- Updated dependencies [d69aefd]
- Updated dependencies [b3db3a2]
- Updated dependencies [c44aaf8]
- Updated dependencies [fe81419]
- Updated dependencies [93b42cd]
- Updated dependencies [a069948]
- Updated dependencies [cf5a5cb]
- Updated dependencies [ab0808c]
- Updated dependencies [6b375c8]
  - @cotal-ai/core@0.52.0
  - @cotal-ai/workspace@0.52.0

## 0.51.0

### Minor Changes

- 64d723e: Enable the AG-UI event plane by default for connectors that publish one. Operators and peer spawns
  can opt out explicitly, while connectors without an event plane refuse unless that opt-out is set.
- ec8649b: Preserve the closed required-events registration policy and enforce it across discovery, launch,
  grant coverage, direct connector sessions, and trusted upgrades of existing manual registrations.

### Patch Changes

- db18070: Apply a signed-in account's space catalog to the registry under the provider's catalog lock, and
  record in the cache whether the snapshot was applied in full. A command that dies or is stopped
  while applying no longer leaves a partial registry that fresh and not-modified refreshes accept:
  the next command applies the cached snapshot again first. `prepareSpaceCatalogs` and
  `syncSpaceCatalogAfterLogin` now take the consumer's `apply`.
- 7bd1ce8: Add `cotal service` (install/status/uninstall): run the manager as a user service that survives logout and reboot. Linux installs a systemd user unit per mesh, macOS a launchd agent; other platforms fail with a message naming what is missing. The unit runs a bare `supervise` with mesh facts in a 0600 EnvironmentFile, a private COTAL_HOME (with the mesh registry entry snapshotted into it), and connectors pre-seeded synchronously by the installer. `supervise` reads COTAL_SPACE/COTAL_SERVER from the environment when the flags are absent, and pins its workspace root so a unit's WorkingDirectory owns the pidfiles.

  Every path-derived value the unit writes (WorkingDirectory, EnvironmentFile, ExecStart tokens) is escaped for systemd percent specifiers, so a mesh root containing `%` starts over its real path instead of a path systemd rewrote while install reported success. Uninstall and status require the unit's recorded mesh to be present (and, for uninstall, to match the named mesh); a unit that carries the provenance marker but no recorded mesh is refused rather than treated as the requested mesh.

- b4de8ff: Mark partial multi-manager `ps` results incomplete with a non-zero exit and a clear contract mismatch summary.
- 4dd4b90: Add harness-reported presence conditions, opaque environment references, binding diagnostics, and compact roster rendering.
- c36baf7: Refuse a URL or `host:port` value passed to `cotal up --host` by name, pointing at `--server`, instead of bracketing it into an unparseable broker URL. With no `--server` the derived garbage string used to reach the registry comparison and misfire as the unrelated "registered by hand" refusal; with `--server` the mismatch check threw a raw `Invalid URL` instead of its own diagnostic. The manifest path gets the same refusal for `broker.host` against `broker.servers`. (issue #1697)
- 92a8938: Run a manual registration's policy refresh where the policy is consumed. The refresh reached the
  pinned exchange from the command dispatcher, ahead of every command's own refusals, so `cotal status`
  on a pre-policy manual entry failed on a transport error and `cotal supervise` reported that error
  instead of its `--server` mismatch or missing-login sentence. Spawn, join and supervise now refresh
  after their local refusals; read-only commands never refresh. The bundle validator, the pinned fetch
  and the dial classifier move to `@cotal-ai/workspace` so the manager can share them.
- 949d4d1: Admit seat checkpoints and take custody on the resume path, before anything starts.

  An ordinary `up` from a preserved cut now runs the three admission gates over that cut's seat checkpoints, then claims the seat's next writer generation, all before the resume attempt is journalled and long before a manager launches. A refusal at that point costs nothing; the same refusal after a launch would be a second writer.

  Integrity checks presence, regular non-symlink, byte size and sha256, and re-stats after the read. Identity checks the space, that the recorded `lifecycleUid` is not live, and the profile revision against this host's current digest of the seat's launch config, with no override at all: a differing revision is refused naming both digests and the remedy, because the checkpoint carries the recorded digest and not the config bytes, and the manager re-digests the same file at relaunch and refuses drift on its own. Recency compares `capturedAt` to this host's clock against the horizon the record carries, refusing outside it with all three values named. `--accept-stale-checkpoint` admits a stale checkpoint and records the exercised consent in the resume journal with the seat, the capture instant, the admitted age and the horizon.

  Admission is all or nothing. Coverage is settled first from the cut's own directory listing, then all three gates run over every checkpoint, and only when the whole set has passed does any generation get claimed. A refusal anywhere leaves every generation unclaimed, including a lost exclusive create inside the claim phase itself: the claims made by that attempt are removed before the refusal is raised, by the exact paths it wrote and nothing else, so a generation another destination holds is never touched. The resume can then be retried over a repaired checkpoint set. Custody is claimed by exclusive create on the recorded generation plus one, and a lost create refuses rather than adopting the winner.

  Admission is reconciled against the inventory the resume is about to hand the manager. A retained seat with no admitted checkpoint refuses the resume by name, before any gate runs and before any generation is claimed: an absent checkpoint directory and an absent record look identical to a reader of the directory alone, and a seat that starts without passing the gates has claimed no writer generation.

  Two limits are stated in `docs/cli.md` rather than implied. The writer generation is claimed inside one workspace root, so it fences two resumes on one host and not two independent destinations. And no shipped command consumes the captured bytes: the bundle, diffs and untracked archive are written, digested and admitted, but restoring them is manual today, so an ordinary resume still requires the preserved source store.

  Checkpoints are addressed by the preservation attempt that wrote them, `.cotal/maintenance/v<N>/checkpoints/<attemptId>/<seat>/`, through one shared path helper so the cut and the resume cannot disagree about where they are. A shared per-seat directory made the second cut in a root impossible: the writer refuses a destination that already exists, and deleting the previous one would destroy an artifact a rollback still needs.

- 949d4d1: Capture a seat checkpoint during `down --preserve-state`, after the cut has proven the whole stack down.

  Each retained seat gets `.cotal/maintenance/v1/checkpoints/<attempt>/<seat>/` holding a `git bundle` of its `cwd`'s reachable history anchored on a named base commit, the staging state as two diffs (base to index, index to worktree), the untracked files in scope, the harness session pointer and store when the connector declares them, and a `checkpoint.json` written last with every file's byte size and sha256. The command prints each checkpoint's path, continuity class and writer generation. The preservation attempt is in the path because a sealed checkpoint is immutable: a shared directory would make the second cut in a root refuse on the first cut's leftovers.

  Capture runs only after the manager has proven every child exited and the endpoint is unreachable, because anything earlier races a harness still writing its transcript and its working tree. The staging state is two diffs rather than one so a mixed tree restores with the same index it was cut with.

  The recorded untracked selection rule excludes the `.cotal/` control directory. When a seat's `cwd` is also the mesh root that directory is untracked, and without the exclusion the broker trust material, the space account, the manager instance identity's private seed and the seat's own credentials would be written into the artifact. A checkpoint carries credential references only.

  A seat whose launch options could not be resolved is refused at prepare time, while every child is still running, in the manager's existing wording. The decision reads only the prepared inventory, so refusing after the stack is down would cost the operator a running mesh to learn the cut could never complete.

  The continuity class a checkpoint records is what the connector declares, capped by what the cut actually carried. The manager's resume inventory records no session pointer path, so a command-produced checkpoint carries no session bytes and a continuation-capable connector is recorded as `fresh` or `drain-only` rather than `exact`. A class is a promise a destination may act on, so it never describes bytes the artifact does not contain.

- f50e20d: Restore an admitted seat checkpoint on the destination, before the preserved resume starts.

  A destination used to admit a checkpoint and then launch the seat against whatever happened to be at `launch.cwd`. The captured bundle, the two diffs and the untracked archive were written, digested and admitted, and nothing consumed them. `cotal up` now puts those bytes back, as a step of the preserved-resume path that runs after every gate has passed over every checkpoint and before a single writer generation is claimed, so a refusal costs nothing for the same reason a gate failure does.

  Each seat stages beside its own `cwd`. Every recorded digest is verified again over the files as they are now; the bundle is cloned into `<cwd>.incoming`, refused when that path already exists; the recorded base commit is verified in the clone and checked out detached; the index diff is applied with `--index` and the worktree diff without it, both `--binary --allow-empty`; the untracked archive is extracted. Every seat stages before any seat is promoted, and promotion moves an existing `cwd` aside to `<cwd>.superseded.<timestamp>` before renaming the staging directory into place. Those two renames are the only steps that touch the path the seat will use, so a failure anywhere leaves every seat's live `cwd` as it was, promotes nothing and claims no generation. `git` and `tar` run as child processes with argument arrays, never a shell string.

  The superseded name is claimed before anything moves, by exclusive directory create, with a numeric suffix when the name is taken. The timestamp has one-second resolution, so two promotions of the same seat within one second would otherwise compute the same path, and the second rename would either replace the tree the first one saved or fail on it. A name this step could not create is a name it does not use.

  A leftover `<cwd>.incoming` refuses by name and is never removed automatically: a staging directory from a failed run is the only record of what failed, so an operator inspects it and removes it by hand. A pre-existing `cwd` is renamed rather than deleted, so a wrong checkpoint costs a rename instead of a tree.

  The promoted tree is verified once more. A checkpoint now records the seat's `git status --porcelain` as the cut read it, under the same selection rule the untracked set was produced under, and the restore re-reads it in the promoted tree and refuses a difference. Both applies can return 0 and still leave an index the source did not have, and this is the only check that sees it.

  The session files travel the same way. The manager's resume entry carries the connector's `sessionStatePath` when the seat has one, `cotal down --preserve-state` takes `--session-store <path>` (repeatable, applied to every continuation-capable retained seat, refused when the path does not exist or is not a directory), and each captured session file records where it lands as an anchor plus a relative path rather than the source host's absolute spelling. The restore places them before the seat launches, so a connector that declares exact continuation is sealed and resumed as `exact` rather than capped. A pointer whose recorded `sessionId` is not the one the retained inventory reopens is refused before anything is cloned, and a session file already present at its destination is judged by content: equal bytes are already restored, different bytes are refused with both digests rather than clobbered.

  `up --restore <dir>` reaches the same admission and the same restore, after the store is restored and validated and before commit intent is journaled. It previously handed a retained inventory to the manager with no gate run, no generation claimed and no restore.

  The incarnation check runs before the restore does. The recorded `lifecycleUid` is reconciled against the inventory the resume is about to hand the manager as a gate over the staged set, so a checkpoint describing a different incarnation refuses with both uids while every live working tree is still in place and no generation has been claimed. That comparison previously ran after admission returned, which is after a tree had been moved aside, another promoted over it and a generation claimed under the checkpoint's uid.

  A restore never moves or replaces the destination's own control directory. A seat whose `cwd` holds a `.cotal/`, the layout an operator gets from running `up` and `spawn` in one directory, is refused before staging: a checkpoint excludes the control directory by design, so promoting a tree that cannot contain it would carry the destination's live trust material and maintenance state away under the superseded tree, and the restore would report success.

  A continuity class of `exact` or `fork` now requires the pointer and at least one store file. A pointer alone names a session whose transcript the artifact does not hold, and it is capped like a cut carrying neither.

- a1c7737: A seat restore moves an existing working tree aside by renaming it straight onto its timestamped superseded name, retrying with a suffix when the name is taken. The previous exclusive-create claim could never be redeemed on Windows, where a rename onto an existing directory is refused.
- a0c8a59: Discover a signed-in account's advertised spaces lazily, cache validated snapshots, and add `cotal sync` for explicit refreshes.
- f178611: Preload every persisted per-space auth-callout account when a shared broker starts, and refuse incomplete user-auth state before writing its resolver config.
- 21407fd: Allow foreground seats to redeem one-time remote user-auth enrollments, bootstrap stock mesh records, and launch without a cached human login.
- 26d864b: `cotal update` and `cotal update --self` complete on a machine with no recorded mesh instead of refusing with "no mesh running": there is no running manager to observe there, so the continuity read is skipped. The same holds when every recorded mesh is down and none is selected. A recorded mesh that is down still refuses when the command selects it, with `--space` or from inside its project, and so does a named space that is not running. A connect refusal that came from mesh-target resolution now carries that target error as its `cause`.
- Updated dependencies [db18070]
- Updated dependencies [64d723e]
- Updated dependencies [ade42d5]
- Updated dependencies [4f153ab]
- Updated dependencies [eb65c9b]
- Updated dependencies [314a12c]
- Updated dependencies [4dd4b90]
- Updated dependencies [92a8938]
- Updated dependencies [ec8649b]
- Updated dependencies [949d4d1]
- Updated dependencies [949d4d1]
- Updated dependencies [f50e20d]
- Updated dependencies [a0c8a59]
- Updated dependencies [c18c055]
- Updated dependencies [f178611]
- Updated dependencies [21407fd]
- Updated dependencies [26d864b]
  - @cotal-ai/core@0.51.0
  - @cotal-ai/workspace@0.51.0

## 0.50.1

### Patch Changes

- Updated dependencies [c499a85]
  - @cotal-ai/core@0.50.1
  - @cotal-ai/workspace@0.50.1

## 0.50.0

### Minor Changes

- ba91ad5: Attach on an open-mode mesh, which never has a local seed

  `cotal attach` refused every seat on a mesh started with `cotal up --open`, saying it needed this
  space's local seed to redeem the session grant. An open-mode mesh has no seed by design, so the
  refusal fired on exactly the configuration attach exists to serve, and its remedy pointed at
  re-registering a root the mesh had already resolved correctly.

  How a session grant is redeemed is now the recorded mesh contract, carried as a value rather than
  inferred from whether a credential happens to be present. An open mesh redeems over the same bare
  connection the control round trip already used, and nothing is minted or synthesised for it. A
  static-auth mesh still mints a session-scoped credential from the seed at the root the mesh
  resolved to, and a static-auth mesh whose seed is missing still refuses, now naming
  restore-at-checkout rather than a re-registration that would change nothing. A user-auth mesh still
  refuses loud: two-step user-mode redemption is not wired.

- 6f248ac: Enumerate broker spawn sites so an unmigrated suite fails the gate instead of leaking

  The reaper claims a leaked `nats-server` by matching the store-dir token in its argv, and its header
  states the standing condition: it "is only ever as complete as the migration that mints the token".
  #1008 measured what that costs, 108 orphaned brokers on one box in a day, all holding loopback ports
  inside the OS ephemeral range that suites draw from. The five suites it named were migrated, and
  nothing was left behind that could notice the sixth.

  `pnpm smoke:broker-migration` is that missing piece. It names no filenames: it walks `git ls-files`,
  finds every call that starts a `nats-server`, and fails when one is not claimable by the reaper or
  killable by the teardown helper. A suite added next week is in the population on the commit that
  adds it. The census currently reads 319 spawn sites across 297 files, and the gate checks all 315
  that are in scope.

  The census found 98 unadopted sites, not five. Two conditions each break the chain on their own and
  both are now required: the token has to be in a path the broker is STARTED with, since the reaper
  reads argv and nothing else, and the handle has to reach `teardownOnSignal`, since the token only
  helps once the owner is dead. Three shapes were leaking for reasons a named list would never have
  surfaced. A suite minting a tokened store dir but launching with `-c <conf>` put the token somewhere
  argv never carries, so it was unclaimable despite looking migrated. Brokers started with neither
  `-sd` nor `-c` left no evidence at all; those now pass a tokened `-sd` purely as a marker, which
  `nats-server` accepts without JetStream and writes nothing into. And suites that owned one broker
  while leaving a sibling unowned read as clean under any file-level check, so ownership is decided per
  spawn site.

  A deliberate negative control opts out with a `SMOKE_BROKER_UNADOPTED_OK` marker, which is greppable
  and per-site rather than a silent exclusion: `reaper.smoke.ts` must be able to start an untokened
  broker, since that is the case it exists to detect.

  The teardown helper no longer stalls three seconds and then reports a false alarm on every green
  run. It waited on `process.kill(pid, 0)`, which keeps succeeding for a child that has been killed but
  not yet waited on, so a suite whose own `finally` kills the broker first left a zombie that read as
  alive until the deadline elapsed, and the helper then printed `did not exit before path cleanup`
  about a process that was already dead. Liveness now distinguishes a zombie from a running process,
  and a genuinely running broker is still waited on before its store dir is removed.

- 44cdcc2: Make the delivery daemon own its liveness record

  `delivery.<space>.pid` was written only by the CLI launcher, so a daemon started by any other route,
  a container entrypoint, systemd, or an operator running `cotal deliver --space <space>`, left
  whatever was on disk untouched and every reader believed it. On a reporting mesh the record named a
  pid that had been dead for four days while the daemon ran under a different one.

  That is not only an under-report. `cotal down` decides what to stop from the same record, and
  `mayBeRunning` is the guard that must fail closed so `cotal down nats` cannot take the broker away
  from a live dependant. A record naming a dead pid satisfies that guard: it supplies the
  proof-of-death the guard asks for, so a live delivery daemon reads as clear and the broker goes out
  from under it.

  The daemon now writes its own record and removes it, with the identity pin, when it exits. The write
  happens once the single-flight shard lease is held, and not before: a daemon that loses that lease
  refuses to bind and exits, so writing on entry would let a loser overwrite the live holder's record
  on its way out. It is written before the Plane-3 bind so an operator can still stop a daemon whose
  bind hangs; readiness is a separate fact the lease's own flag already carries.

  Readers no longer believe a pid merely because it is alive. The delivery record's liveness gains the
  `foreign` state the manager's already had, for the same reason: a record that outlived its daemon is
  eventually re-pointed at an unrelated process by pid reuse, and `kill(pid, 0)` alone reports that
  stranger as a healthy daemon forever. A live pid is trusted only once its command line has been read
  and names the daemon, and `cotal down` never signals a live process that is provably not one.
  Attribution only downgrades on proof, so a platform with no argv source, an unreadable process, or
  one that exits during the read all behave exactly as before.

- 6cc504b: Report an unbound delivery responder instead of a healthy-looking daemon

  A delivery daemon whose `ctl.delivery` responder has not bound blocks spawn, retirement and join,
  but no operator-facing surface said so. `cotal status` printed `delivery  running (pid N)` off the
  pidfile alone, which is the identical line it prints when delivery is fully healthy. The daemon's
  own readiness lease already distinguished the two, and `cotal status --components` already read it,
  but that pass is opt-in, so an operator watching the ordinary surfaces saw a green control plane
  while every lifecycle operation failed. The boot path made the same conflation from the other side:
  when the readiness wait elapsed, `cotal up` logged one info line promising that boot durable joins
  would reconcile and then reported success, so its caller could not tell a bound responder from an
  absent one.

  Bare `cotal status` now reads the same readiness lease `--components` reads, and reports the
  responder as bound, not bound, or unchecked. An unbound responder names its consequence in the same
  line: no spawn, no retirement, no join until it binds. Bare status remains a broad, recovery
  oriented diagnostic and still exits 0, and where the lease cannot be read it says the axis was not
  checked and points at `--components` rather than implying health.

  Readiness is judged against the daemon that is supposed to be serving, not merely against the flag.
  A daemon that dies without releasing its lease leaves its `ready` record in the bucket until the
  lease TTL expires it, so for that window a restarted or crashed mesh could still report a bound
  responder off the previous daemon's record. Both surfaces now compare the lease holder against the
  daemon this workspace launched and report a leftover record as not bound, naming it as a dead
  daemon's record that clears on its own. Where the holder genuinely cannot be known, such as an
  adopted daemon this process did not start, the holder is not checked and behaviour is unchanged.

  `cotal up` either binds the responder or states that it did not and what that prevents; the promise of a reconcile stays, but as
  a statement that the wait is open ended and that agents do not need respawning, rather than as the
  only thing said. A denied join now names the delivery daemon as a possible cause alongside
  credentials, instead of sending an operator holding valid credentials after the wrong hypothesis.

  `cotal doctor auth` no longer reports a healthy fleet as broken. When a daemon re-mints an agent's
  credential, the previous incarnation's file stays on disk, expired, and every one of those was
  reported as `EXPIRED - the broker denies this credential` with the remedy `respawn the agent`.
  Following that remedy destroys live sessions to repair nothing, because the running agent is already
  using its successor. Superseded incarnations are now recognised from the credential family that
  names them, reported as leftover files with a cleanup that is explicitly not a respawn, and excluded
  from the verdict, while a credential that genuinely has no successor is still a problem. The remedy
  for a recoverable credential now says that a running manager re-mints it and that the agent adopts
  the new file without being restarted; `respawn` is reserved for material no renewal pass can rescue.
  The doctor also names an unbound delivery responder when the recorded renewal pass hit one, so the
  surface an operator reaches for when credentials look wrong can say that credentials are not the
  fault.

- fc6f0b1: Scope an unanswered endpoint verdict to the rail the request rode

  A CLI whose caller carries an issued generation rides the versioned `ep.v1` rail. SPEC 13.15 makes
  that rail a separate subject space from the legacy `ep` rail and requires an endpoint to serve
  both, so a manager built before the versioned rail serves `ep` alone and never receives the
  request. The describe waited out its whole budget and every hosted `cotal run` verb reported that
  no manager answered on the endpoint rails, asked whether one was running, and offered `--local`,
  against a manager that was up, on the roster and answering `cotal ps` throughout. `--local` drives
  the run from the calling process and names the caller as the run's answerer, so an operator who
  took the suggestion would submit an answer under the wrong identity.

  The unanswered marker now carries the `ep` plane the request was published on, and `describe`
  names it in its own refusal. `cotal ps` and the other manager verbs state the reachability verdict
  against that rail instead of against the mesh, and say what silence on a versioned rail does not
  establish. `cotal run`'s hosted verbs do the same and drop both the question and the `--local`
  suggestion there, since neither follows from what was observed. On the legacy rail every message is
  unchanged: there is no second rail its silence could be hiding a manager on.

  No fallback describe is issued on the other rail. A caller holds broker rows for its own rail only,
  so the request would be refused at publish rather than answered.

- f4ddd02: Refuse to re-exec a detached daemon from an entry that is not the CLI

  `selfArgv()` builds the argv every detached re-exec is spawned with: `[node, ...loaderFlags,
process.argv[1]]`, plus a cotal subcommand the caller appends. It took `process.argv[1]` on trust.
  Under tsx that is whatever file was run, so a process started from something other than the `cotal`
  entry spawned a child that re-ran THAT file with `supervise`, `deliver` or `ext add` appended, which
  the file does not read. A test fixture reaching `ensureControlPlane` therefore spawned a copy of
  itself as its own manager, and the copy reached the same call and spawned the next: 970 detached
  generations over 4.7 hours on a persistent host, each holding a nats-server and a delivery holder.
  The guard cannot live in the test harness, because `startManagerDetached` unrefs its child on
  purpose and nothing can adopt it.

  `selfArgv()` now refuses unless the entry is the CLI's own composition root: `bin/cotal.ts` in a
  source checkout, `dist/cotal.js` in an install, or a bare `cotal`, which is what `npm i -g` leaves
  in `process.argv[1]` because it publishes the bin as a symlink. The refusal names the entry, says
  what a child spawned from it would actually run, and names the remedy. It is a throw rather than a
  skipped spawn: a re-exec that silently does not happen reports a healthy control plane over nothing.

  The manager, delivery and auth starters now build that argv before they open the daemon logfile, so
  a refused start leaves the mesh root exactly as it found it instead of creating a log and leaking
  its descriptor.

- 56afdaf: A seat is reported as not found only when every reachable manager instance answered for itself

  `cotal stop`, `cotal attach` and `cotal input` locate a seat by asking every registered manager
  instance which one hosts it, because a single manager answers `not-found` both for a seat it does
  not host and for a name that exists nowhere. That search concluded absence from every instance the
  scatter called reachable. An instance that answered with a REFUSAL is reachable, and it stated
  nothing about which seats it hosts; an instance that never answered at all was left out of the
  count entirely. So an incomplete search printed a definite negative that named the instance count,
  which is the shape a reader believes: a seat that `cotal ps` listed as running the whole time was
  reported as being on none of the reachable managers, and the same command with `--on <instance>`
  succeeded first time.

  Absence is now concluded only from instances that answered for themselves. When any registered
  instance stayed silent or refused the read, the verbs report that the seat's location could not be
  established, name those instances, and state that this is not a report that the seat is gone, so an
  operator or a retry loop pins with `--on` instead of concluding the seat is already gone. A search
  in which every instance answered still reports the seat as absent, unchanged.

### Patch Changes

- 5e23b1d: Keep the versioned rail's subject token out of source comments

  The issued-profile census scans every shipped source for the versioned rail's subject token and
  allows only core's subject and grant builders to spell it. Five comments in core, the CLI and the
  runtime spelled the token and failed that cell on main. They now say "the versioned rail" or "the
  versioned plane". No code changes.

- 1112755: Give fresh setup defaults the run capability alongside spawn. Document workflow tool setup, credential refresh for existing personas, and supported authentication modes.
- 504e78f: Observe before writing: no seed store rewrite during parse, validation or a dry run

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

- Updated dependencies [ba91ad5]
- Updated dependencies [06eccc3]
- Updated dependencies [6f248ac]
- Updated dependencies [5e23b1d]
- Updated dependencies [44cdcc2]
- Updated dependencies [6cc504b]
- Updated dependencies [87dda9f]
- Updated dependencies [fc6f0b1]
- Updated dependencies [aaedc42]
- Updated dependencies [4ab8b4b]
- Updated dependencies [fe813fe]
- Updated dependencies [55dae63]
- Updated dependencies [7df3498]
- Updated dependencies [438c629]
- Updated dependencies [a211c52]
  - @cotal-ai/workspace@0.50.0
  - @cotal-ai/core@0.50.0

## 0.49.0

### Minor Changes

- b0aeca4: Make bare `cotal down` and `Manager.stop()` spare managed agents by default. Use
  `cotal down --with-agents` or `Manager.stop({ withAgents: true })` for deliberate destructive
  teardown. Linux PTY seats release manager-local proxy custody while their detached custodians and
  child processes continue running, and the CLI binds destructive intent to the exact live stop
  attempt so an interrupted command cannot poison a later bare shutdown. Managers launched before
  process identity pins existed remain stoppable after the documented reduced-guarantee warning:
  bare down cannot prove which SIGTERM handler that running binary carries, so it never reports the
  pre-signal seat inventory as confirmed spared. A genuinely older destructive handler may still reap
  those agents. `--with-agents` uses a one-shot handoff bound to the manager pid and the live
  stop-reservation inode, then signals unconditionally.
- e3f2d21: Keep a dead `cotal up` mesh record as offline, with its root in the error

  A liveness miss used to delete every registry record that was not `origin: "manual"`, including
  `origin: "up"` and pre-origin records. `cotal meshes` was the command the error pointed at, and it
  was the command that destroyed the restart authority. The record was already written at provision
  time; this change stops withholding survival from it.

  `pruneMesh` is now reason-gated. `gone` (the liveness sweep, and preflight `unreachable`) keeps
  every origin as `offline`. `mismatch` (credentials rejected, open-now-auth, stale-auth-root) still
  drops an `up` record and still never drops a `manual` one. `cotal down` / `cotal clean all` still
  drop `up` records for the root they tear down.

  The unreachable copy for a kept `up` record still starts `no mesh running at <server>` and then
  names the recorded root, telling the operator to run `cotal up` there, so a bare `cotal up` in
  the wrong cwd cannot start a different mesh.

  A liveness sweep still returns `{ pruned, offline }`. Resolution now uses `offline`: a record
  known dead is not a live candidate for a bare command (`no mesh running` / `multiple meshes
running` name only meshes that answered). `--space` still resolves a dead record so preflight
  can name its root. All-offline is still `no-meshes`; the named-space path is what reports
  "recorded but not running".

### Patch Changes

- 0680a3f: Warn when `cotal up --detach` is launched by a systemd `Type=oneshot` unit with
  `RemainAfterExit=yes`, because that unit observes only the launcher's successful exit and can remain
  active after the detached stack dies. Document a foreground long-running unit, component-health
  checks, and split broker/manager monitoring.
- 062881a: Wire `--max-sessions` from the CLI into the manager's live-session ceiling.

  `ManagerOptions.maxSessions` was documented as deployment-configurable, but nothing in the CLI
  could set it, so every live manager sat at 64. `cotal supervise --max-sessions` and
  `cotal up --max-sessions` now parse a positive integer, pass it into the manager, and record it on
  the mesh so a same-root repair, resume, or `spawn -f` that restarts the manager does not silently
  drop a raised ceiling. A refresh of an already-running manager refuses a different `--max-sessions`
  rather than recording an unapplied setting. A capacity refusal names `--max-sessions`. Default
  remains 64. Size for agents × panes: the browser console opens one session per pane.

- 5079c89: Rebind a presence watch that goes silent under a live connection, and stop `cotal ps` from printing a liveness verdict while the manager's own presence view is stale.

  On netcup on 2026-09-09 the presence stream was deleted and recreated while the manager kept its
  connection. Its ordered consumer re-created itself from the old cursor against a stream whose
  sequence had restarted, the broker kept sending it idle heartbeats, and nothing ever re-created the
  watch. The manager's roster froze at the pre-recreation snapshot for hours: `cotal ps` printed
  `mesh offline` for every seat older than the freeze and `not in roster` for every seat younger,
  while a fresh observer saw all of them heartbeating. The lane watchdog stopped a working
  orchestrator twice on that reading.

  The endpoint's sweep already refused to age peers out while the whole bucket was silent and marked
  the view stale; that was the right verdict for a held link and the wrong end state for a dead
  consumer. When the view is stale and the transport is up, the endpoint now stops the old watch and
  binds a new one from the bucket's current state, once per liveness window, and reports the rebind
  as a warning that names the silent interval. The per-peer age-out also requires that the watch
  delivered for a full window after the peer's last heartbeat, so an observer's own deafness no longer
  emits one offline verdict per peer on the tick before the whole-bucket gate trips. A rebind that
  is still awaiting the broker when the endpoint stops or rebuilds its connection is retired: it
  installs nothing and reports nothing, so a stopped endpoint never regains a watch and a rebuilt
  one keeps the watch its fresh connection bound. A rebind that lands on a bucket with no keys is
  read two ways. An observer that does not register (a probe) learns that nobody is present: it
  retires every peer still in its roster and holds the view current until the first write, instead of
  reading its own silence as staleness and rebinding once per window while the mesh is empty. An
  observer that registers (the manager) is one of the missing keys, so the bucket was wiped since its
  last heartbeat: it re-publishes its own record, the new watch delivers it, and every other peer is
  re-observed or aged out from that delivery. It never marks itself offline on a current view.

  Each `ps` row now carries the manager's presence-view state (`meshView`: `current`, `stale`, or
  `unpopulated`), and the CLI prints `mesh unknown` with the reason instead of `mesh offline` or
  `not in roster` whenever that state is not `current`. Rows from an older manager carry no field and
  render as before.

- 1636927: Resume long manager re-registrations with fresh scoped authority and durable same-operation eviction progress, and document safe gate recovery and the last-resort JetStream store replacement procedure.
- 6836dd3: Allow `cotal send dm`, `msg`, and `ask` from an operator shell outside a managed seat. The transient
  sender now uses a fixed advisory display name while its wire principal continues to come from the
  resolved credential or user bearer.
- Updated dependencies [a9c9849]
- Updated dependencies [b0aeca4]
- Updated dependencies [348b8b7]
- Updated dependencies [9a334ae]
- Updated dependencies [18f3df0]
- Updated dependencies [9ff5c22]
- Updated dependencies [cf6ced5]
- Updated dependencies [36d1779]
- Updated dependencies [e3f2d21]
- Updated dependencies [062881a]
- Updated dependencies [159c5f0]
- Updated dependencies [c9ea091]
- Updated dependencies [5079c89]
- Updated dependencies [5395c7c]
- Updated dependencies [6fd855f]
- Updated dependencies [186fc62]
- Updated dependencies [1636927]
- Updated dependencies [dd6fea0]
- Updated dependencies [6fb1d64]
- Updated dependencies [b00f3c1]
- Updated dependencies [13f29e1]
  - @cotal-ai/core@0.49.0
  - @cotal-ai/workspace@0.49.0

## 0.48.2

### Patch Changes

- @cotal-ai/core@0.48.2
- @cotal-ai/workspace@0.48.2

## 0.48.1

### Patch Changes

- 9c101cc: Report failed static lifecycle reconciliation, retry the same durable terminal with a bounded schedule, and drain accepted reconciliation work during shutdown.
  - @cotal-ai/core@0.48.1
  - @cotal-ai/workspace@0.48.1

## 0.48.0

### Patch Changes

- 26af599: Use the explicitly selected space when refreshing delivery credentials on a multi-space root.
- Updated dependencies [b6c843f]
  - @cotal-ai/core@0.48.0
  - @cotal-ai/workspace@0.48.0

## 0.47.1

### Patch Changes

- @cotal-ai/core@0.47.1
- @cotal-ai/workspace@0.47.1

## 0.47.0

### Patch Changes

- 8ec22cb: `cotal down` and `cotal describe` now dial with the TLS requirement the mesh record holds, instead
  of passing `tls: false` at every one of their three dials. On a mesh recorded `tls://`, `wss://` or
  added with `--tls`, those connections previously tolerated a plaintext broker; they now require the
  handshake, which is what the recorded requirement means everywhere else. This is fail-closed on
  `down`, a destructive command: a mesh recorded TLS-required whose broker answers plaintext now
  fails there. Target preflight already refuses that mesh one step earlier, so no reachable mesh
  changes behaviour.
- f3103b3: Refresh an explicitly named local space from its matching same-server registry record instead of a record chosen by registry order.
- cf294e7: Settle pending wait-exit after a real child exit, drop the redundant handle catch, keep launch-failed when backlog throws on a closed attach stream, bound manager control-rail disconnects after a broker exit, refresh the bundled custody docs, and grade ci-ok as the sole always-running aggregate plus both pack polarities.
- 8ec22cb: `cotal supervise` on a registered remote mesh now dials the broker URL the registry actually
  holds. A remote broker is commonly published over a `wss://` edge, and the manager-authority
  registration the supervisor runs first handed that URL to the raw node transport, which refuses a
  websocket URL outright, so supervision stopped before a manager was ever constructed. That
  registration and every other control dial this audit found can be handed a registry server URL now
  select the transport from the scheme, including the planes `cotal run --local` opens, which failed
  on such a mesh for the same reason. The registration also carries the record's TLS requirement
  instead of assuming a plaintext broker, so a participant no longer downgrades its prepare
  credential exchange on a mesh the registry describes as TLS-required. On the same path, the cluster
  artifacts the registration reads back are now looked up by the key form the content-addressed store
  uses, which a remote registration reached with a prefixed digest reference and could not resolve.
- 8aee1c0: Allow generic `describe` and `invoke` to use an authorized user-mode bearer while preserving endpoint grant and TLS enforcement.
  - @cotal-ai/core@0.47.0
  - @cotal-ai/workspace@0.47.0

## 0.46.0

### Minor Changes

- 9d745af: Add the local durable runtime adoption seam and report legacy manager continuity before a running update can be described as hot. `Runtime.adopt` is optional: runtimes without durable custody omit it, and the manager refuses by name rather than requiring a throwing stub on every adapter. `cotal update --self` reports the selected manager before a global install and hands `--space` / `--server` / `--creds` to the replacement child.
- 18a0024: The manager hosts workflow runs. `run-start`, `run-resume`, `run-answer`, `run-status` and
  `run-ps` are served on the manager's endpoint rails; a run is validated before anything is
  recorded, driven in the manager's process under a per-run `run-driver` credential, and taken back
  from its journal after a manager restart. `cotal run` is a client of that surface by default,
  with `--local` keeping the in-process drive, now under the run's own `run-driver` and
  `run-operator` credentials rather than `admin`; an answer's writes are pinned to the one pause it
  answers. A user-auth mesh refuses the family by name until a run can carry its user's owner. A new `run` capability mints the family into an
  agent's credential and injects the `cotal_run` tool, so an agent can write a cotal-lang program
  and start it from a session. `run-answer` records the answerer from the caller's credential and
  takes no `by`; `cotal run answer` drops `--by` on the hosted path. `spawn({ supervise })` is a restart policy the manager enforces in
  place: `{ restarts, window? }` (default `10m`) until the budget is spent, then the seat is
  retired and the next `turn` is L4002. A policy this host cannot honour is refused at accept.

### Patch Changes

- e986173: Make manager `inspect` distinguish a stranded static slot from an unknown name through structured durable-state details, and make `attach` stop reconnecting when those details show the seat is gone.
- Updated dependencies [9d745af]
- Updated dependencies [18a0024]
  - @cotal-ai/core@0.46.0
  - @cotal-ai/workspace@0.46.0

## 0.45.0

### Patch Changes

- 2a34295: `cotal send` identity refusal and CLI docs now name `COTAL_NAME` as required in both accepted shapes: plus either `COTAL_ID` or both `COTAL_OWNER` and `COTAL_ACTOR`.
- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0
  - @cotal-ai/workspace@0.45.0

## 0.44.0

### Minor Changes

- ba9af19: Refuse a source-checkout `cotal` from writing or GC'ing the operator-global seed store. A missing identity answer is a refusal, not a released install. The refusal names `$XDG_CONFIG_HOME` isolation, not the test-only `COTAL_ALLOW_CHECKOUT_SEED=1` override. An older CLI that meets a newer store is pointed at `cotal ext seed --force`, not `--reset`. `COTAL_HOME` does not relocate this store.

### Patch Changes

- 2850a5a: Count a smoke suite as gated only when a CI job actually runs it. join-external live coverage now rides its own live-job step; a duplicate connect classifier that only `pnpm check` reached is gone. Backup live suites stay UNGATED as already-red (#643 / #1285).
  - @cotal-ai/core@0.44.0
  - @cotal-ai/workspace@0.44.0

## 0.43.0

### Minor Changes

- 64d6131: Require a complete seat identity (`COTAL_NAME` plus `COTAL_ID`, or `COTAL_OWNER` plus `COTAL_ACTOR`) for one-shot CLI messages, so a nameless `cotal send` cannot deliver as the command verb. Isolate the send smoke's CLI subprocesses from the operator seed store (`HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, strip `COTAL_*`). In-tree callers that previously relied on a missing or ambient name now set that identity: `send.smoke.ts`, `user-auth-launch.smoke.ts`, `sys-rotation-e2e.smoke.ts`, `up-tls-routes-live.smoke.ts`, `backup-usermode-live.smoke.ts`, and `backup-faults-live.smoke.ts`. A child that inherited a seat's environment is still attributed as that seat.
- e5412a1: Add per-agent `cwd` to mesh manifests. Relative paths resolve on the manager host against its workspace, matching the imperative spawn option. The directory survives launch-spec validation and contributes to stale-entry detection without changing hashes for manifests that omit it.

  This implements the working-directory part of #963. Manifest session continuity remains separate work.

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0
  - @cotal-ai/workspace@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/core@0.42.0
  - @cotal-ai/workspace@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4
- @cotal-ai/workspace@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3
  - @cotal-ai/workspace@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2
- @cotal-ai/workspace@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1
- @cotal-ai/workspace@0.41.1

## 0.41.0

### Minor Changes

- dbd7d98: Keep agent-profile minting within one resolved mesh root.

  `cotal mint` now reads the persona ACL, loads the signing authority, and stores the default credential under the selected mesh root. If the current folder holds trust for a different space or account, it refuses before writing and names both roots instead of combining authority material from one root with persona policy from another.

- 96e1d54: Resolve the persona catalog from the target mesh rather than the current directory.

  `cotal personas` listed the personas of whatever directory it ran in, while `cotal spawn` launched from the mesh it resolves — so from one directory the two could name completely different sets, with neither saying anything was wrong. Every `cotal personas` subcommand now reads and writes the resolved mesh's catalog, which also makes `--space` and `--server` real for the listing rather than only for the live `--running` overlay: naming a mesh now moves the catalog, and an unresolvable target refuses instead of silently acting on another directory's files. `cotal spawn --role`/`--subscribe` and `cotal send msg`/`ask` complete from that same catalog.

  The library functions behind this (`personasDir`, `listPersonas`, `listPersonaNames`, `listDeclaredChannels`, `listDeclaredRoles`) now require an explicit root instead of defaulting to the current directory, so a caller that omits one fails to compile rather than answering about the wrong place.

- 5ec7feb: Pin every stack pidfile to its process's creation identity before teardown. `up` writes a sibling `<pidfile>.identity` containing the pid and process start where the OS reports one. Every stop path checks it before signalling: a reused pid or torn pin is refused and preserved, and rerunning after the process is stopped clears the stale record automatically. A live pre-pin record warns and proceeds so the first teardown after an upgrade still works; relaunching writes the pin and enables full match and mismatch protection.

### Patch Changes

- bc2f328: Seed personas into the catalog `cotal spawn` reads, and name that directory in the output.

  `cotal setup` wrote `.cotal/agents/default.md` under the directory it ran in, while `cotal spawn` loads its persona from the mesh it resolves. On a machine where those differ — a shell outside any project, plus a mesh whose root is elsewhere — setup created a file spawn would never open, so `no default persona yet - run cotal setup to seed one` survived running exactly the command it named. Setup now seeds into the resolved mesh's catalog, including when that mesh was registered against a brand-new directory with no `.cotal` in it yet.

  Every seed states its destination as an absolute path, and when the mesh's root is not the current directory both are shown, so the choice is visible rather than assumed. With no mesh running at all the current directory is still the answer — setup has to work before the first `cotal up` — but it says that it fell back and why. With several meshes running and none selected it refuses and asks you to pick, instead of choosing a root on your behalf.

  `cotal spawn`'s refusal now names the absolute directory it searched and the mesh that directory came from, so a persona that is missing from one catalog and present in another is diagnosable from the message itself.

- 7dab05c: `cotal status` now names the root behind every persona row, and flags the case where the folder you are standing in is not the one a bare `cotal spawn` will use.

  Status could print `personas  default` in green under "This Folder" while `cotal spawn` refused in the same second with "no default persona yet". Both were right about their own root and neither said which root that was: the folder's catalog is `<root>/.cotal/agents`, while spawn loads the resolved mesh's, and the two diverge whenever `cotal use`, a `--space`, or a registry entry points elsewhere. The personas status listed and the personas spawn could launch could be completely disjoint.

  When the two roots differ, status now names both, says what the spawn root actually offers, and drops the green from a `default` that will not launch. When they agree, the output stays as short as it was.

- Updated dependencies [de258fb]
- Updated dependencies [bac1e00]
- Updated dependencies [5ec7feb]
  - @cotal-ai/core@0.41.0
  - @cotal-ai/workspace@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0
- @cotal-ai/workspace@0.40.0

## 0.39.1

### Patch Changes

- 3f10a7b: Name a verified newer Cotal executable when an older binary refuses a newer seed store.
  - @cotal-ai/core@0.39.1
  - @cotal-ai/workspace@0.39.1

## 0.39.0

### Patch Changes

- Updated dependencies [2277e28]
  - @cotal-ai/core@0.39.0
  - @cotal-ai/workspace@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [21d9552]
  - @cotal-ai/workspace@0.38.0
  - @cotal-ai/core@0.38.0

## 0.37.0

### Minor Changes

- 00ac9d9: manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.
- 9021896: Make the runtime pid/log namespace per-space. The manager and delivery daemon now record themselves
  as `.cotal/manager.<spaceKey>.pid`, `.cotal/manager.<spaceKey>.log`,
  `.cotal/manager.<spaceKey>.delivery-aware`, `.cotal/delivery.<spaceKey>.pid` and
  `.cotal/delivery.<spaceKey>.log`, through the same `{space}` expansion `auth-service.<spaceKey>.pid`
  already used. The five names were root-scoped constants, so one workspace root hosted one manager and
  one delivery daemon by filename: a second space booting in the same root overwrote the first space's
  record, and every reader of that file then answered about the wrong process. `status`, `down`, `up`,
  `clean` and `spawn -f` take the space they are answering about.

  Existing single-space meshes keep working across the upgrade. Reads admit a pre-segmentation
  root-scoped record while it is the only spelling present, byte-exact, so a `cotal down` still finds
  and stops a daemon started by the previous build instead of orphaning it. Writes are always the
  canonical space-keyed name, and each start reclaims a provably dead pre-upgrade record first, so an
  ordinary upgrade does not leave both spellings behind. A live pre-upgrade daemon is refused rather
  than overwritten, and both spellings present is reported as ambiguous rather than guessed.

  A folder-wide command reads its space off the runtime records the folder holds. `resolveRuntimeSpace`
  decodes the space out of the record filenames and prefers a space whose record is running over dead
  residue; two spaces running under one root throws and names both. The previous read came from the
  `.cotal/auth` account records, which an open mesh (`broker: { auth: false }`) never writes, so a bare
  `cotal down` in such a folder answered with the default space and walked past its own manager once the
  records became space-keyed.

  `MANAGER_PIDFILE` and `MANAGER_DELIVERY_AWARE_MARKER` move from `pid.ts` to `local-process.ts` and
  are now `{space}` templates; both are still exported from the package index. `RESERVED_COTAL_CHILDREN`
  no longer lists the five root-scoped runtime names.

### Patch Changes

- 283de1c: Identify the running CLI artifact in `cotal status` and show the compared versions for stale Claude skills.
- a304a89: Allow offline backups to ignore the exact stopped ordered consumer left by whole-bucket KV scans while retaining strict validation of other consumer residue.
- 1cb7042: Announce seed-store generation migrations and record the writer and timestamp for later downgrade refusals.
- 05d534b: Make guided setup enumerate every installed connector through the registry and derive PATH and plugin hints from connector declarations instead of connector names.
- 7e45495: Make every shipped endpoint consumer explicitly surface or ignore recoverable warnings so retry and renewal failures no longer disappear silently.
- e703873: Report connector harness availability at manager boot and expose resolved binary paths in status.
- 6b9525e: Point manager startup and failure guidance at the per-space logfile the detached manager actually writes.
- c09d750: Stop answering progress with presence. Textual working rows without an outside last-assistant observation render progress unknown, while heartbeat age remains explicitly labelled as liveness. The render-agnostic observation classifier lives in the workstation layer, not protocol core; compact presence-only glyphs make no progress claim. A stale observation overlays stalled Xm on still-fresh presence.
- 17046ac: Spawn failures return the lifecycle facts the manager already had (blocked op, head state, opId, remedy) instead of a connector timeout or opaque string.
- b7b932e: Point status skills rows at `cotal setup --skills`, with harness-native setup declared and implemented by connectors rather than the base CLI.
- Updated dependencies [e5e68ed]
- Updated dependencies [c31de91]
- Updated dependencies [d4779db]
- Updated dependencies [6926b34]
- Updated dependencies [d2c0fd3]
- Updated dependencies [7e45495]
- Updated dependencies [135ddaf]
- Updated dependencies [e703873]
- Updated dependencies [6c1cefe]
- Updated dependencies [00ac9d9]
- Updated dependencies [c09d750]
- Updated dependencies [b20644b]
- Updated dependencies [74c9a1b]
- Updated dependencies [bfd650c]
- Updated dependencies [e6c6947]
- Updated dependencies [b36bf50]
- Updated dependencies [3cc980d]
- Updated dependencies [9021896]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0
  - @cotal-ai/workspace@0.37.0

## 0.36.0

### Patch Changes

- 7c5995b: Key per-tenant material per space instead of per root. The five root-scoped kinds (the `$SYS` cred pair, `membership.json`, `membership-rw.creds`, `delivery.creds`) and every per-agent standing secret now live under `space.<hex>/` segments, migrated on first touch through one choke point that refuses — loudly, with an honest remedy — on any root it cannot show to hold a single tenant. `space rm`'s step-7 reaps land with their step-1 preconditions ahead of the verb itself. Also: the delivery daemon's `$SYS` repair advice now asks the guard instead of printing commands that refuse on the roots that need them, expired user bearers stop being re-presented on reconnect (with the retry bounded), and `agentSecretKeyForFile` takes the caller's space and checks the recorded path against it, so a stored path can no longer address another tenant's material.
- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0
  - @cotal-ai/workspace@0.36.0

## 0.35.0

### Minor Changes

- c5948e6: Seed the default persona with wildcard channel read and post ACLs while keeping its active
  subscription set empty. A fresh default agent can now join and create channels on demand without
  receiving every channel at boot. Repeat setup also upgrades the byte-exact legacy default while
  leaving every edited persona unchanged. The guided demo personas retain their existing `welcome`
  scope.

  This is a minor release because packages are pre-1.0 and the shipped security default broadens the
  default persona's broker-enforced publish authority. The connector-core bump ships the updated
  version-matched operator docs bundle.

- d457d7f: Show each managed seat's model and requested variant in the default `cotal ps` view, and expose Jcode's declared local model catalog without presenting configured effort tiers as provider-verified capabilities.

### Patch Changes

- 4919a53: Render the broker config from the validated tenant inventory, so `cotal up` on a root that holds several spaces keeps every sibling account trusted instead of silently evicting it, and refuses to render while any account record is unreadable.
- Updated dependencies [4919a53]
  - @cotal-ai/workspace@0.35.0
  - @cotal-ai/core@0.35.0

## 0.34.0

### Minor Changes

- 22c3182: Honor the persona file's `agent:` frontmatter when picking the spawn harness. The key existed in
  half the fleet's personas but no code path read it: it swept into the verbatim `meta` bag, and both
  launch paths resolved the connector before the persona file was loaded, so `COTAL_DEFAULT_AGENT`
  silently beat a deliberate per-persona pin (a `jcode` persona ran `claude` with no complaint).

  The harness now resolves once, on every spawn path, as: explicit `--agent` flag > persona `agent:` >
  `COTAL_DEFAULT_AGENT` > the product default. That is the precedence `model:` and `variant:` already
  have, keeping the env var a _default_ rather than an override. On `--detach` the CLI now threads
  an explicit flag and the caller's environment default as separate control fields. The manager loads
  the persona file before resolving its connector and applies the same precedence while preserving
  the invoking operator's default when its own environment differs. A pin naming an unregistered
  connector fails the spawn loudly with the connector install hint (no silent fallback).

  `saveAgentFile` round-trips the field, so a runtime `cotal_persona` redefine preserves a pin.
  Docs updated (`agent-files.md`, `connectors.md`, `cli.md`, `config.md`).

### Patch Changes

- 9e4e4ed: Add an explicit concrete host option for remote web dashboard binding, launch, readiness, Origin checks, and status probes while preserving the loopback default.
- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0
  - @cotal-ai/workspace@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9
- @cotal-ai/workspace@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8
- @cotal-ai/workspace@0.33.8

## 0.33.7

### Patch Changes

- 576ac7d: Account for endpoint-plane streams in backup validation and space teardown, grant their deletion only to the ephemeral teardown credential, and recreate their canonical empty infrastructure during restore.
- Updated dependencies [576ac7d]
- Updated dependencies [7119b4c]
  - @cotal-ai/core@0.33.7
  - @cotal-ai/workspace@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6
- @cotal-ai/workspace@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5
- @cotal-ai/workspace@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4
  - @cotal-ai/workspace@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3
- @cotal-ai/workspace@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2
  - @cotal-ai/workspace@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1
- @cotal-ai/workspace@0.33.1

## 0.33.0

### Minor Changes

- ba74c84: An agent now reads only the channels it lists. An omitted or empty read set means **no channels**,
  where it previously meant `general`: the agent-file loader, the provisioner, the credential mint and
  the endpoint each defaulted an absent read set to `["general"]`, so any persona that simply did not
  mention channels was subscribed to `general` by code and had the matching channel read row baked
  into its credential.

  An agent on no channel is still a full mesh peer: it appears on the roster and sends and receives
  DMs and anycasts, and the same default-deny that already governed `allowPublish` now governs reads.
  An empty list and an omitted one mean the same thing, for both read keys. That has one consequence
  worth stating plainly: when **both** are omitted, `allowSubscribe` falls back to the read set and so
  resolves empty too, which leaves the agent unable to `cotal_join` a channel at runtime. Give it an
  explicit `allowSubscribe` if it should be able to join one later.

  With no concrete channel there is no default broadcast target, so a send with no explicit channel is
  refused with a message saying so, rather than resolving to `general`. Leaving your last channel is
  allowed and always was; the `cotal_leave` description said otherwise and now says what actually
  happens, including that the default send channel is gone until you join one.

  Migration: **list `general` explicitly if you want it.** A hand-written persona that relied on the
  old default needs `subscribe: [general]` added.

  This changes the default `cotal setup` install as well. The seeded `default_agent` carries
  `subscribe: []`, which used to resolve to `general` and now resolves to no channel; it keeps
  `allowSubscribe: [">"]`, so it can still `cotal_join` anything, it just no longer arrives on a
  channel it never asked for — which is what its own seed comment already described.

  Already-running agents are not narrowed retroactively: a live seat keeps the read ACL its credential
  was minted with, across renewal, until it is respawned.

  **Correction:** the read-set default-deny described above is not new in 0.33.0. It shipped in 0.28.0
  with 86f6b10 (#821, "Remove the implicit `general` channel floor"), and so did the refusal of a send
  with no channel and the no-channel default for the seeded `default_agent`. Upgrading from 0.28.0 or
  later needs no migration for it. What 0.33.0 changed is narrower. The no-default-channel check in
  `multicast` now refuses only an omitted channel (`channel === undefined` where it was `!channel`), so
  an explicit empty-string `channel` is no longer refused as if it were omitted, and the refusal now
  says to name or join a channel. The `cotal_send` and `cotal_leave` tool descriptions and pi's send
  call line no longer name `general` as a default or say the last channel cannot be left, doc comments
  state the rule and the both-keys-omitted consequence, and the `smoke:no-implicit-general` and
  `smoke:session-channels` suites guard it.

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0
  - @cotal-ai/workspace@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0
- @cotal-ai/workspace@0.32.0

## 0.31.0

### Minor Changes

- 4ef59c3: A spawned seat now receives a constructed environment (PATH/HOME/locale, the machine-wide COTAL\_\* knobs, connector-declared provider keys) instead of the manager's ambient environment. Host-session markers such as CLAUDE_CODE_CHILD_SESSION no longer leak into seats and silently disable transcript saving. The Claude connector declares CLAUDE_CODE_OAUTH_TOKEN (and the rest of claude's documented credential set) so a container seat still authenticates; spawn.env remains the explicit opt-in for extra names, including a host marker a persona has chosen to receive.

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0
  - @cotal-ai/workspace@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2
- @cotal-ai/workspace@0.30.2

## 0.30.1

### Patch Changes

- 1b4b386: The control command family (`ps`, `stop`, `attach`, and the detached-session release) dials
  through `dialerFor`, so it works against a websocket broker (`wss://…`) instead of refusing
  with "'servers' node client doesn't support websockets, use the 'wsconnect' function
  instead" while `send` and foreground `spawn` — already routed through the dialer — worked.
- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1
  - @cotal-ai/workspace@0.30.1

## 0.30.0

### Minor Changes

- 0e673ff: Delivery daemon: the launcher stops dropping the transport, and stops reporting a daemon it did not start.

  Two independent defects let `cotal up` print a healthy control plane over one that was not there.

  **A same-root refresh relaunched the delivery daemon without TLS (#836).** `startDeliveryWithBroker`
  re-derived the transport from `<root>/.cotal/broker-policy.json` whenever its caller passed no
  `transport` — and the refresh path never passed one, even though it had already decided the same
  fact from the mesh-registry entry and reconciled it against the live listener's `INFO`. The two
  durable records are written by different paths, so on any root that records `tlsRequired` without
  holding a policy file (registered with `cotal meshes add --tls`, or a mesh predating the policy
  file) the daemon went out flagless against a TLS-required broker. Nothing looked wrong: the client
  still upgrades on the server's unauthenticated greeting. The daemon holds a standing credential and
  reconnects unattended, so that was a repeating exposure, not a one-shot. The transport requirement
  is now a required argument to `startDeliveryWithBroker`; the policy re-derivation is gone and every
  call site names its source.

  **A stale lease answered for a daemon that had already exited (#837).** `waitForDeliveryLease`
  accepted any `ready:true` lease. A daemon killed with `SIGKILL` never releases its lease, and the
  record survives for the rest of the bucket TTL — so a replacement that lost the single-flight CAS
  and exited was reported ready off the corpse's lease, and `up` exited 0 with no daemon running and a
  pidfile fronting a dead pid. `waitForDeliveryLease` now takes `holder` and waits for that daemon
  specifically (`undefined` only when adopting one that was already running, whose id is not knowable
  from the launcher). `ensureDelivery` passes the id of the daemon it launched, and a launch whose
  process is provably gone while holding no lease now fails loud, naming `.cotal/delivery.log`,
  instead of returning success.

  `waitForDeliveryLease` now requires `holder` — pass `undefined` for the previous behaviour.

### Patch Changes

- cc1f2e2: `cotal attach` now coalesces rapid wheel input and PTY redraw bursts, waits for local stdout drain
  before returning session credit, and automatically repaints the canonical terminal snapshot after an
  explicit backpressure drop. Session teardown also lets the distinct terminal reason drain before the
  unsequenced close control can overtake it. The bounded 64-frame rail window is unchanged.
- 656921b: Add `cotal status --components`, a fail-loud per-component health probe that distinguishes an absent process from a live component that is not serving. It reports manager lease/service reachability and explicit unavailable startup phase, delivery ready-lease plus renewal-adoption outcome, web PID-bound HTTP port reachability, and registered broker reachability.
- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0
  - @cotal-ai/workspace@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2
  - @cotal-ai/workspace@0.29.2

## 0.29.1

### Patch Changes

- 9570a57: A remotely provisioned spawn now launches under the incarnation uid the mesh
  minted. The provisioning endpoint pre-creates the agent's lifecycle-keyed
  durables and writes the ledger row under ITS `lifecycleUid`, and the auth
  callout mints the agent's dm/dlv/chathist grants from that row — but the launch
  kept the locally minted uid, so the agent asked for durables its credential did
  not name and looped on bind violations, surfacing as "not connected to the
  mesh" while the broker showed publish violations on `$JS.API.CONSUMER.INFO`.
  The remote branch now adopts `material.lifecycleUid`, the same authority rule
  already applied to the returned subscribe/allow lists.
  - @cotal-ai/core@0.29.1
  - @cotal-ai/workspace@0.29.1

## 0.29.0

### Minor Changes

- 1f025c3: `cotal spawn` works against a mesh registered from a remote bundle. A user-mode
  agent's credentials must be granted where the space's signer lives, so a laptop
  spawn previously refused with a message about missing local material. A mesh may
  now advertise an agent-provisioning endpoint in its discovery bundle
  (`cotal up --agent-provisioning-url <https://…>`, carried as
  `userAuth.endpoints.agentProvisioningUrl`); spawn POSTs the operator's login
  bearer there, lands the returned material 0600, and runs the same bearer
  preflight before launch. A remote mesh that advertises none now refuses by
  naming that fact and the operator's remedy, instead of blaming absent local
  state. The endpoint is https-only (it receives the login bearer) and redirects
  are refused, matching the registration fetch discipline.

  The login proof itself never crosses the CLI package: the provisioning POST is
  a new optional `AuthProvider.postAgentProvisioning` seam on core's provider
  interface, implemented by `@cotal-ai/auth` — the CLI keeps its no-auth-import
  boundary.

  Also fixes `finalizeUserBundleEndpoint`, which replaced the bundle's endpoints
  object and would have dropped any sibling field the composer set.

### Patch Changes

- Updated dependencies [1f025c3]
  - @cotal-ai/core@0.29.0
  - @cotal-ai/workspace@0.29.0

## 0.28.2

### Patch Changes

- 53f66c2: `cotal personas new` demanded `--subscribe` while the command registration
  refused the flag as unknown — a catch-22 that made persona creation impossible
  through the shipped binary. The registration now declares it (and the usage
  names it).
- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2
  - @cotal-ai/workspace@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1
  - @cotal-ai/workspace@0.28.1

## 0.28.0

### Minor Changes

- 1f44ca6: Add an optional reverse-proxy-facing auth exchange listener with generated mesh discovery, credential-based public proof, isolated throttling, and `cotal up --user-auth` configuration.
- 86f6b10: Remove the implicit `general` channel floor: undeclared access now grants nothing

  An agent that declared no channel access used to fall back to `["general"]` for its
  active read set and read ACL. That floor was applied in seven places — the provisioner,
  the agent-file loader, the manager's spawn path, the CLI's `spawn`, the connector's
  config resolver, and the endpoint's own channel list — so an agent with no frontmatter
  silently joined a channel nobody had granted it.

  The fallback also could not see the credentials it was guessing against. On a manifest
  spawn the materialized persona carries no access frontmatter, so the connector fell back
  to `general` while the minted creds allowed only the manifest's channels; the broker then
  refused the subscription and the agent joined nothing, with no error naming the cause.
  `COTAL_SUBSCRIBE` forwarding was added to paper over exactly this.

  Undeclared read is now empty, matching the repo's no-fallbacks rule and the existing
  default-deny on `allowPublish`. `Endpoint.send()` throws instead of defaulting to
  `general` when the endpoint is on no concrete channel — a caller that never declared a
  channel now gets a loud error rather than a message delivered somewhere it never asked
  for.

  The seeded personas change with it: `default_agent` no longer auto-subscribes to
  `general` and no longer carries a wildcard post ACL (`allowPublish: [">"]` → `[]`,
  default-deny), and the demo personas move to their own `welcome` channel. Channels are
  implicit — created on first use — so no channel provisioning is required.

  Breaking for anyone relying on the implicit floor: an agent that read `general` without
  declaring it must now declare it.

- a84cb62: Saving a persona now requires it to name the channels it reads. `saveAgentFile` refuses a
  definition with no `subscribe`, `cotal personas new` takes a required `--subscribe` (pass
  an empty value for an agent reachable only by direct message and anycast), and a persona
  defined over the wire is created with an empty read set, since that path deliberately
  accepts no policy from its caller, and records that the caller was never offered the
  choice so a reader can tell it apart from a persona whose author chose no channels. Previously a saved persona with no read set inherited
  whatever default was current, so a file could grant a channel its author never chose and a
  later reader could not tell a deliberate silence from a forgotten field. An empty list is
  written rather than filled in, so the two stay distinguishable.
- 45db9f8: `cotal meshes add` can register a REMOTE mesh. `classifyJoinTarget` gains the `public-tls` reach: with recorded TLS strictness (`tlsRequired: true`) a hostname or public IP literal is registrable, because the TLS chain + hostname check — not the resolver — picks the peer; without it every verdict is unchanged, and RFC1918 stays refused in both modes. **The overlay consent gate no longer applies under required TLS.** `--allow-unencrypted-overlay` exists because an overlay address is only protected while its tunnel is up; with `--tls` (or a `tls://` scheme) the handshake proves the transport instead, so registering an overlay address now needs no flag, prompts for no acceptance, and records none — where previously every overlay registration demanded one. Without required TLS the gate is unchanged. TLS intent is now sourced (a `--tls` flag or a `tls://` scheme) and ENFORCED: the record carries it, the candidate probe honours it, and `meshes add tls://…` against a plaintext broker is a refusal rather than a silent plaintext dial. Remote user-auth registration is built but **fail-closed**: `cotal meshes add --mode user` refuses by default, naming the sequencing, because no connect path can consume a remote entry yet (the auth provider still refuses remote user-mode connects). It is enabled by the remote-exchange client work, which deletes both refusals together. Behind that fence the form is complete: `--mode user` takes its pinned trust supplied — `--user-auth-file <bundle.json>` or `--from <https://…/.well-known/cotal-mesh>` (fetched over HTTPS, pins displayed and confirmed) — verified against the pinned exchange's `/health` + `/jwks` and the broker's own auth-required refusal. Address classification canonicalizes EVERY legacy IPv4 spelling before any verdict. `inet_aton` — which the OS dialer and Node's resolver both accept — takes octal, hex and short forms, so `3232235786`, `0300.0250.01.012`, `0xC0A8010A`, `192.168.257` and `[::ffff:192.168.1.10]` are all the same private addresses that their dotted forms name, and each previously classified as a public hostname and registered while the dotted spelling was refused. They are now refused identically. **This changes verdicts for EVERY alternate spelling, not only private ranges:** a mapped loopback literal now classifies as `loopback`, a mapped overlay literal as `overlay` (so it answers to `--allow-unencrypted-overlay` and can carry a residual), and a mapped public literal as `public-tls` — each one previously fell through to whatever the unnormalized string happened to match. Anything that classified an address in a non-canonical spelling may therefore get a different, dotted-equivalent verdict now. Genuine hostnames are unaffected: a name that is not a valid IPv4 literal in any base (`09.0.0.1`, `999.1.1.1`, `1.2.3.4.5`) stays a hostname. The `--from` discovery fetch and the pinned-exchange probes refuse redirects instead of following them (a 302 can walk an HTTPS fetch onto plaintext or another host), require an `https://` endpoint, and perform no network I/O until the operator has consented to the address. Remote user entries record `userAuth.remote` and a 0600 `sentinelCredsPath` (the path, never the blob), and promote `endpoints.url` to pinned trust; `assertUserAuthInfo` fails loud on both.
- 200a93f: Enable remote user-auth mesh registration now that managed agents can consume the recorded pinned exchange and sentinel through the remote bearer client. Remove the temporary development-only registration hatch and its fail-closed sequencing refusal.
- 44738b2: A remotely-registered user mesh now connects with stock cotal end to end, including over a websocket broker address.

  `cotal meshes add <space> --from <url>` already landed a complete remote trust
  position (IdP pins, public exchange URL, sentinel creds); the auth provider now
  CONSUMES it at connect when no local user-auth material exists: login session →
  fresh IdP JWT → the pinned exchange's capless public face → bearer + the
  registration-landed sentinel. Nothing is discovered at connect time, the
  transport rule (HTTPS, loopback-literal http only, names get no exception) is
  checked before the IdP round trip, and every refusal names its exact remedy.

  Brokers published through an HTTPS edge are dialable as `wss://host/path`:
  core picks the websocket transport by scheme at every dial site (endpoint,
  reachability, probe), `hostPort` defaults ws/wss to the web's ports, and
  `join-target` classifies `wss://` as TLS-bearing (the handshake is the
  transport's own) while `ws://` gets exactly the plaintext fences `nats://`
  gets. The canonical server string keeps the URL path — behind an edge the
  path is part of the broker's address.

### Patch Changes

- b8ee849: Announce the operator-global seed-store payload write, and its deletions, on the provenance channel. `cotal up` and the built-in-connector reconcile re-seed `~/.config/cotal/seed/store/<version>`, which is a machine-wide action (shared by every space, project directory, and checkout on the machine, moved only by `$XDG_CONFIG_HOME`), yet the store write was previously silent. It now emits a `wrote operator-global seed store payload` provenance line naming the path on each materialization, so re-seeding from a non-released checkout reads as the machine-wide write it is. The idempotent reuse path stays silent.

  The same reconcile also garbage-collects unreferenced store generations, and that was silent too. A new `removed` verb on the provenance channel names every directory the collector deletes, because a silent delete is worse than a silent write: the write at least leaves the thing it made, while the delete leaves nothing to notice. The announce rides stderr with no failure policy, so a closed stderr keeps the write and loses the line; that bound is stated at the call site and in the config reference, which also documents the isolation mechanism.

  The config reference that documents all of this ships inside the connector as well as in the docs tree, so the regenerated documentation bundle carries the same text: an agent asking `cotal_docs` for the configuration page now gets the announce, the removal announce, and the stderr bound along with everything else that page already said.

- 5db8641: Registration's exchange probe now pins the exchange's own issuer (`urn:cotal:auth:<space>`, derived from the bundle's `space`) instead of the IdP issuer. The auth daemon's `/health` reports its own token issuer, so pinning `userAuth.idp.issuer` made `cotal meshes add --from` refuse every bundle the daemon's public face generates. The user-bundle smoke pins the cli-side derivation against auth's `spaceIssuer` so the two cannot drift.
- 653c6cd: Accept a path on ws:// and wss:// --server URLs in `meshes add`. The public face legitimately advertises a path-carrying websocket broker address (`wss://host/mesh-ws` behind a reverse proxy) and the dial layer already honours it, but checkServer refused it as non-bare — so the face's own generated bundle could not be registered. nats:// and tls:// URLs stay bare.
- Updated dependencies [09b6a3b]
- Updated dependencies [b8ee849]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [45db9f8]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/workspace@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [900f630]
  - @cotal-ai/workspace@0.27.0
  - @cotal-ai/core@0.27.0

## 0.26.0

### Minor Changes

- aa1fe5f: `cotal attach` redeems a session grant with the seed the mesh resolved, never one walked up from the current directory.

  Resolution picks a root from the mesh registry and connects with it; redemption then asked the current directory the same question and used whatever it answered. The two disagree on a real machine rather than in theory, because root detection accepts any directory named `.cotal` and `~/.cotal` exists on every install (the mesh registry lives there). A command run anywhere under `$HOME` outside a project therefore minted its per-session credential from the home directory's trust chain and presented it to a broker that trusts a different one, surfacing as a bare authorization failure that named nothing. The trust material the resolution already carries is now used directly, which is the rule the control layer states for its own re-mints.

  A cwd anchor holding a DIFFERENT chain for the same space is reported rather than obeyed: it cannot change what the command does, but staying silent about it is how the failure stayed a mystery. `@cotal-ai/workspace` gains `divergentCwdAnchor` for that comparison, which is silent on a second checkout of the same mesh and on a directory with no anchor at all.

  The report cannot end the command either. Taking the seed from the resolution stops the current directory choosing which chain is used; it does not by itself stop it ending the run, because the report reads the walked root before the mint and the loader refuses unreadable trust material loudly. A half-written `.cotal/auth/broker.json` anywhere up the walk aborted an attach that had just declared it was not using that root, and on the reconnecting path that fault was retried as though the link were down. A fault reading either root is now reported as nothing to say, which is the accurate answer rather than a fallback: the comparison needs two legible chains, so an unreadable walked root asserts nothing and an unreadable resolved root leaves nothing to compare against. Corruption in the root the command actually reads still surfaces from the path that reads it.

  When the resolved mesh genuinely holds no seed, the refusal now names what the command resolved: the broker and the root. The old sentence named neither the root nor the mesh.

### Patch Changes

- Updated dependencies [aa1fe5f]
  - @cotal-ai/workspace@0.26.0
  - @cotal-ai/core@0.26.0

## 0.25.0

### Minor Changes

- a087c2b: A spawned agent now inherits the operator's environment. A harness you installed and configured
  should behave under `cotal spawn` the way it behaves when you run it yourself, and the alternative
  was Cotal maintaining a list of inference vendors: every new provider needed a change in Cotal
  before it would work through a managed spawn. `MODEL_PROVIDER_KEYS` and the per-connector lists
  that extended it are gone, and Cotal no longer names an inference vendor anywhere in its source.

  Cotal still resets its own `COTAL_*` namespace before the child starts, keeping the machine-wide
  knobs (`COTAL_HOME`, the feedback set, the default-agent pair, the `*_BIN` overrides, the timing
  knobs). That reset is not configurable, because it is identity and not preference: a connector
  supplies the per-session names for each child and does so conditionally, so an inherited value is
  never overwritten and would hand an agent another agent's credential path, ACL, or lifecycle uid.
  The whole prefix is stripped rather than a named list, because which names a connector sets varies
  between connectors and a deny-list only ever names what its author remembered.

  To confine a spawned agent instead, declare `spawn.env` in the cotal config file. The child then
  gets a fixed OS allow-list plus exactly the names you list. An empty array is a real policy meaning
  the OS allow-list alone. Note what this does and does not buy: `HOME` is forwarded either way, so
  an agent with a shell reads `~/.aws` and `~/.ssh` regardless, and this protects only secrets that
  live nowhere but the environment.

### Patch Changes

- 3f1ee2f: `cotal ps --wide` / `--json`: surface the per-seat facts the manager already records. The agent row now carries the model pin (and variant), `cwd`, `pid`, spawner, and the owning manager's instance id and host, all optional so an unrecorded fact (no model pinned; a runtime that owns no real process) serializes absent, never fabricated. Bare `ps` output is unchanged; `--wide` prints one dim facts line under each seat; `--json` prints the manager's row verbatim, one object per line, with instance headers on stderr. No new collection path: every field was already held in the manager's spawn-time record.
- a7742a7: attach: own the keyboard whenever there is no session. Keystrokes typed at a terminal whose link
  has died are read and dropped instead of buffered, so nothing an operator types at a frozen screen
  is delivered to the agent by a reconnect they did not know had happened, Ctrl-C included. That now
  covers every gap in the loop: the waits, the attempts, the hand-back of a session that faulted on a
  link that is still up, and the first establishment, so a key struck before the very first attach
  comes up does not arrive at the agent when it does. The detach key is read across all of them, and
  a press that lands while a session is opening ends the attach rather than being swallowed by the
  handoff to that session's own reader. With stdin a pipe the old behaviour is kept on purpose, in
  every one of those windows rather than only the first: a script's input is buffered and delivered
  when the session opens, including across a reconnect, so a feed piped into an attach does not lose
  what was written while the link was down. `--no-reconnect` keeps the single-session behaviour
  everywhere.

  Also: a piped attach now gives the shell back when it detaches. `printf 'ls\n' | cotal attach --name
web --no-reconnect` printed `detached from web` and then held the process open, because nothing
  released the command's own claim on stdin on the way out. That release is made where there is
  something to release: a terminal and a pipe are sockets, while a stdin that is a file
  (`cotal attach --name web < seed.txt`, or a parent that spawns attach with stdin ignored) is not,
  and releasing it there raised `process.stdin.unref is not a function` on the way out.

  Also: a session that dies while it is still opening no longer leaves the keyboard unread. The
  window is one round trip wide, between the reconnect being announced and the session going live,
  and a link that dies inside it ended a session that had never taken the stream while the client
  paused it regardless, so the reader that was still installed read nothing for the whole backoff and
  everything typed at that frozen terminal was delivered to the agent when the next session opened.
  The stream is now paused only by a session that resumed it.

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/workspace@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [b7cc4fa]
  - @cotal-ai/core@0.24.0
  - @cotal-ai/workspace@0.24.0

## 0.23.0

### Minor Changes

- 5634356: `cotal attach` re-establishes its session when the link dies, instead of leaving you with a dead terminal.

  An attach left alone while the laptop slept was gone by the time you came back, in one of two ways
  depending on how long the link was down. Shorter than the serving side's stall watchdog: the
  manager's rail keeps advancing its sequence into a subject nobody is subscribed to, and the session
  transport has no retention, so those frames are gone. The moment the client redials and its
  subscription is restored, the next frame lands far ahead of what the client expected, the rail
  faults, and the CLI exits with `mesh session transport error: gap` about a second after the network
  came back. Longer than the stall: the serving rail fills its window, stalls, ends the session and
  closes, and both of those notices are published while the client is disconnected, so neither is ever
  delivered. On redial the client is subscribed to a session nobody is serving and hangs there with no
  output, no honest end and no exit at all.

  `attach` now owns re-establishment rather than leaving it to the NATS layer. When the link breaks and
  you did not press the detach key, it prints `[cotal: connection lost, reconnecting]` on stderr, then
  asks the manager for a fresh grant, mints a fresh per-session credential, opens a fresh connection
  and a fresh session, prints `[cotal: reconnected]`, and carries on in the same raw-mode terminal.
  The manager repaints the seat's current screen through the path it already uses for any attach.
  Retries wait 1s, 2s, 5s, 10s, then 30s, for as long as the seat exists, and the detach key is read
  during the waits between attempts, so a reconnect never traps you. Every attempt re-runs the manager's full authorization, so a
  reconnect cannot keep a revoked or expired grant alive: no grant is ever presented twice.

  Giving up always says why. A manager that refuses the attach exits non-zero with the manager's own
  message; a reconnect that finds the seat no longer there exits cleanly with `seat <name> is gone`. A
  refusal that could still pass, such as a manager at its session ceiling, is relayed in the manager's
  own words while the loop keeps trying, so waiting is never unexplained. Pressing the detach key, or
  the agent's process exiting while you are attached, ends the attach as before.

  Each reconnect also hands the abandoned session back to the manager, over the first link that can
  carry the message, so an attach that rides out several outages does not consume a session slot per
  outage. Nothing on the serving side reaps a session whose caller went away while the seat is quiet:
  the stall watchdog only arms once the send window fills, and an idle seat never fills it. The client
  is the only party that knows, so it says so, using the session's own credential, the only one
  scoped to that session's subjects. If it never gets a link that can carry the message, it says that
  instead, on exit. Every wait on a link that is dying is bounded, and the bound is real: the timer
  that enforces it is what keeps the process alive while a socket that will never answer is waited
  on. A link that stays UP and carries nothing, which is what a sleeping laptop looks like from the
  client, ends with the same clean exit and the same message as any other fault instead of the
  command aborting on a wait that never returned.

  `--no-reconnect` restores the single-session behaviour for scripts that want one run and one exit
  code.

  Under it, `@cotal-ai/workspace` separates a connect refusal from what is done about one. Resolving a
  mesh and its preflight answered every refusal by printing a sentence and ending the process, which is
  right for a person who just typed a command and wrong for a loop riding out a broker that is briefly
  unreachable. The decision now raises a `ConnectRefusal` carrying that exact sentence, and the
  `*OrExit` entry points are thin wrappers that print it and exit as before, so one place writes each
  message and the two forms cannot drift.

### Patch Changes

- 401f0d6: `cotal attach`: pressing the detach key during a reconnect gives the shell back at once, instead of
  at the end of the backoff rung.

  The detach itself was always immediate: the terminal came back and `detached from <seat>` printed a
  moment after the press. The process then stayed alive until the backoff wait it had already
  abandoned ran out. Losing a `Promise.race` does not stop a `setTimeout`, and the timer is ref'd, so
  node kept the command open to the end of the rung. On the 30s rung that is half a minute of a shell
  that has said it detached and will not give the prompt back. Measured before the fix: 27.0s from
  press to exit with the next attempt 26.9s away, and 8.3s with it 8.1s away, tracking the rung rather
  than any work being done; 0.1s after it.

- Updated dependencies [5634356]
  - @cotal-ai/workspace@0.23.0
  - @cotal-ai/core@0.23.0

## 0.22.0

### Minor Changes

- 57d3a57: A Claude session publishes a structured event plane, and the `tr-<name>` transcript mirror is
  retired

  A session launched with `cotal spawn --events` now actually publishes. The Claude connector maps
  its session records to structured events behind the same hook relay the mirror used to sit behind:
  run boundaries per turn, assistant text, reasoning, and each tool call with its arguments, its end
  and its result, written to a per-session write-ahead log before they go on the wire so a restart
  resumes at its cursor instead of replaying or skipping. Until now no connector constructed the
  emitter at all, so every event channel was empty.

  The `tr-<name>` mirror is removed in the same change rather than deprecated alongside it. Gone with
  it: the `--transcript` and `--no-transcript` flags on `cotal spawn`, the `transcript` field on the
  manager's spawn op and its service contract, `COTAL_TRANSCRIPT` and `COTAL_TRANSCRIPT_DEFAULT`,
  `LaunchOpts.transcript`, `Connector.transcriptChannel`, and the mirror in all three connectors that
  carried one.

  MIGRATION. If you read a `tr-<name>` channel, nothing publishes to it any more. A managed session no
  longer mirrors its prose there under any flag or environment variable, and a spawn that passes
  `--transcript` now fails on an unknown flag rather than being ignored. Read the session's event
  channel instead: launch with `--events` and subscribe to `events.<owner>.<actor>`, which is keyed on
  the session's principal. On a static mesh that is `events.local.<key>`, where the key is what the
  manager allocated and the spawn reply carries it as `id`; on a user-auth mesh it is
  `events.<your-owner>.<agent-name>`, where the actor half is the agent's own name. `connect-claude.md`
  gives both forms. `cotal console` and the web console render event frames directly. Unlike
  `tr-<name>`, you cannot simply subscribe: the plane needs an out-of-band grant, and the command for
  it is under "To let something read a plane" below.

  What you gain and what you lose, both stated. A tool call now arrives with its full arguments, its
  end and its result, in a vocabulary a program can read, where the mirror gave a truncated one-liner
  of glyph-prefixed text. What you lose is prompt text somebody else wrote: the mirror republished
  every prompt, and the event plane withholds the body of a turn the agent did not author, because
  republishing a peer's message onto a channel that peer may not read crosses an ACL boundary. A
  peer-authored turn still opens a run and still shows the work it caused. One stated limit on that,
  because the loss column is only useful if it is complete: a tool result is this session's own output
  and is republished, so peer text quoted inside one still reaches the wire. A cell in
  `agui-authorship.smoke.ts` holds that as a measured limit rather than leaving it to be discovered.

  A spawn may be granted the event plane of the agent it is creating, and no other. A spawn that names
  a different agent's event channel in `allowSubscribe` or `allowPublish` is refused at the door,
  because that channel carries the session's tool inputs and outputs. The same rule runs on a manager
  resume: a retained inventory naming another agent's event channel is refused rather than adopted.

  The rule reads a **concrete** channel, two principal tokens and nothing else. A pattern such as
  `events.<owner>.>` is not an event channel to it and passes untouched, governed by ordinary ACL
  authority. That is deliberate, since the pattern is the form an operator writes on purpose for an
  observer.

  To let something read a plane, grant it out of band. The refusal prints one command, spelled out in
  full, for the mesh it is running on. On a user-auth mesh:
  `cotal actor grant <reader> --owner <owner> --scope '' --allow-subscribe '<channel>' --allow-publish
''`, every field named because `actor grant` is an upsert of the whole row and an omitted flag is the
  wide default (`>` read, `>` post, `spawn,role:default` scope), not "leave it alone". On a static mesh there is no
  actor ledger for `actor grant` to write to, so mint the reader instead:
  `cotal mint watcher --profile agent --allow-subscribe '<channel>' --provision`, the agent profile and
  not the observer one, since `mint` reads `--allow-subscribe` only for that profile and refuses it off
  that profile.

  `cotal mint` now REFUSES `--allow-subscribe` / `--allow-publish` off the agent profile rather than
  ignoring them. Those profiles carry a FIXED read set, the chat plane for observer and the whole
  messaging plane for admin, so
  `--profile observer --allow-subscribe <one channel>` used to exit 0, print a success line, and hand
  out a credential that reads every channel in the space: an operator asking to narrow got the
  opposite, silently. `--role` and `--provision` were already refused there for the same reason. The
  rows in `cli.md` and the sentence in `build-a-client.md` now say the same thing.

### Patch Changes

- Updated dependencies [57d3a57]
  - @cotal-ai/workspace@0.22.0
  - @cotal-ai/core@0.22.0

## 0.21.0

### Minor Changes

- 4cf5f72: Give a session's structured event plane a way to be turned on, and a channel that names who is publishing.

  An agent can now be launched with `cotal spawn --events`, foreground or detached, which publishes
  that session's structured event stream, what it did rather than the prose it wrote, on a channel of
  its own so an external observer or UI can read it. Off by default. Nothing about an existing launch
  changes.

  **The channel is named after the principal, never the display name.** It is `events.<owner>.<actor>`,
  derived from the principal the manager actually allocated. A display name is UI convenience: this
  mesh permits two live agents to carry one, and the manager itself auto-numbers a collision, so a
  name-keyed channel would fuse two principals onto one subject and, in auth mode, would authorize both
  onto it from a value that identifies neither. The derivation is a single function on the connector
  contract, `eventChannel`, so the subject the manager grants and the subject the session publishes to
  cannot drift apart. A connector that does not implement it refuses `--events` before any provisioning
  rather than starting a session whose events have nowhere legal to land, and the refusal releases the
  name it had already reserved.

  **The flag and the grant are deliberately separate.** Holding publish rights on a channel is not a
  request to publish to it. An agent file or a manifest can hand-write anything into `allowPublish`, so
  if a grant could arm the plane, any author who could write an agent file could turn on a full
  transcript of another seat's tool inputs and outputs without ever touching the launch grammar. Only
  the launch arms the session; the grant is what makes the arming useful. `cotal_spawn`, the peer-facing
  tool, does not expose the option at all. That is the shape of the tool and not a control-plane refusal:
  the manager's spawn service op is a second door onto the same handler and still accepts the field,
  which is a pre-existing property of that door and is fenced separately.

  **The flag rides the whole launch path, including the record a restart reads.** It is on the
  foreground launch, the detached spawn payload, the manager service contract, and the resume document,
  so a manager restart brings an armed session back armed. The foreground path mints its own grant, from
  the principal it allocated, and passes the workspace root the emitter's write-ahead log needs: a
  session armed by one launch surface and not the other would be a flag that means two different
  things. A resume adopts the credential the spawn wrote rather than minting a new
  one, so what a restart can lose is the record: either the channel leaves `allowPublish`, or the
  arming flag does and the session returns holding publish rights it will never use, which reads as a
  working system with an empty panel. Both halves are now carried and both are asserted.

  **One behaviour change to state plainly.** The foreground launch now passes the mesh's root as the
  launch's workspace root, on every foreground spawn rather than only on an armed one, which is what the
  manager has always done. Two connectors already read that field and root their per-agent home at it:
  Codex, which puts its per-agent home under it, and OpenCode, which puts its database and its serve
  pidfile there. Both previously fell back to the directory the operator happened to run the command
  in. So a foreground Codex or OpenCode session moves its local state from that directory to the mesh
  root, which is where its detached counterpart has always put it. Operators who ran `cotal spawn` from
  somewhere other than the mesh root will find that session's state under the mesh root instead. The
  Claude connector reads the field only on an armed launch, and Hermes and pi do not read it at all.

  **Supporting pieces in the shared connector runtime.** The event vocabulary is exported from
  `@cotal-ai/connector-core` for the first time, so a connector can reach it by package name instead of
  by deep path. The emitter gained a way to close an open run out of band: a harness reports the end of
  a turn through a lifecycle hook that writes no record, so a record-sourced stream previously had no
  vehicle for a turn terminal. The closing frame is an ordinary frame with one exception, it republishes
  the source cursor unchanged, because advancing it would mark records consumed that were never mapped
  and leave a consumer no gap to notice it by. The emitter refuses to close while a message or a tool
  call is still open under the run, while a frame is still pending recovery, and after a halt.

  **One pre-existing limit this makes visible earlier.** In user mode the allocated actor is the display
  name, and principal tokens forbid `-`, which is reserved as the principal name form's separator. The
  manager's collision handling appends `-2`, so the second user-mode launch of any persona has never
  been principal-keyable; it already failed at the identity and provisioning sites. The event grant is
  derived before provisioning, so that launch now fails before it leaves a footprint rather than after.
  The underlying naming limit is unchanged and is not addressed here.

- 9c2412c: `cotal input --name <seat> --text <text> [--no-enter]` types one line into a running managed agent's terminal and returns, so a program can deliver a harness command (`/compact`, `/clear`, `/model`) without holding an `attach` stream open. It is backed by a new manager op `input`, which carries the same row shape and the same authorization as `attach` (capability `manager.lifecycle`, targeted, authz modes `owner` and `any`), takes `{text, enter?}` with the text verbatim up to 64KiB, and answers `{name, bytes}`. Enter is appended unless suppressed; nothing is echoed back. The manager's cluster document is revision 7, so a caller's `describe` sees the new command. `AgentHandle` gains an optional `write(data)`: the `pty` runtime implements it, and the external terminal runtimes (`tmux`, `cmux`, `orca`, `herdr`) do not own the child's input stream, so `input` refuses and names the runtime rather than dropping the keystroke. The command is granted only to operator credentials, in both modes, and NOT to the `spawn` capability that already carries `despawn` and `attach`. That placement is deliberate: an `attach` grant needs a `session-caller` credential to redeem and an agent profile cannot mint one, so `input` would be genuinely new authority rather than a restatement of `attach`, and the own-owner rule that bounds `despawn` covers every seat under an owner rather than only the ones a caller launched. Killing a peer is denial; typing into a peer is control of it. On a user-auth mesh `cotal input` therefore needs ledger scope `admin`, the scope `ps` already needs there.

### Patch Changes

- Updated dependencies [4cf5f72]
- Updated dependencies [219d33c]
- Updated dependencies [9c2412c]
  - @cotal-ai/core@0.21.0
  - @cotal-ai/workspace@0.21.0

## 0.20.1

### Patch Changes

- 2752fe7: Stop `cotal ps` waiting on registrations whose host is gone, and give those registrations an exit.

  A class scatter's gather has two exits: every frozen slot answered, or the deadline. The expected set
  is frozen from the service registry, which records registration rather than liveness, and an instance
  that crashes never deregisters, so its record goes on claiming a live instance for as long as the
  bucket exists. That leaves a slot which can never answer, which makes the first exit unreachable, so
  the deadline is paid in full on every scatter in the space, indefinitely. Measured on the laptop this
  was built against: `cotal ps` at 12.5s with one true corpse in the set, ending in a row that read
  `unreachable` for a machine that had been gone for weeks. There was no way to remove that record.
  Three things were wrong, one per layer, and all three are fixed here.

  **The scatter can now be told an instance is gone.** `epScatter` takes an optional `probeLiveness`
  hook and ends the gather once every frozen slot has either produced a valid reply or been affirmed
  gone. It moves the classification point and nothing else: an affirmed-gone slot is still `missing`,
  still surfaced, still not `complete`, and a straggler arriving after an early finish is still reported
  `late` rather than dropped. Only the verdict `gone` licenses anything; `live`, `unknown`, a hook that
  throws, and any value outside the closed set all leave the full deadline standing, so a broken probe
  degrades to exactly the previous behaviour rather than to a fast wrong answer. `epProbeInstanceInterest`
  supplies that verdict from the broker itself: a `describe` cast on the instance's own rail with the
  reserved no-responders sentinel as its reply-to, the same primitive and trust rule `epCall` already
  relies on. A serving incarnation subscribes its instance rail for every command it serves and every
  endpoint must serve `describe`, so silence on that rail is evidence of absence rather than absence of
  evidence. The reply is never read, so an instance whose describe is broken still reads as present.

  **And a probe is never a reason to still be running.** Against a live instance the probe is never
  answered, because the request is a cast and a responder must not reply to one, so its deadline timer
  runs the full budget on every healthy instance every time. Wired into `cotal ps` that was measured at
  four extra seconds after the last row was printed, on a mesh with no dead registration in it at all:
  12.8s with the probe against 8.8s with it switched off, same tree and same mesh. The timer is now
  unref'd, so a probe still settles `unknown` at its budget for anyone waiting on it and no longer holds
  the event loop open for a caller whose gather has already finished. The same measurement after the fix
  is 8.6s to 9.4s.

  **The probe belongs to the caller, not to the scatter.** Asking about an instance is a publish on that
  instance's rail, and a credential holding no row for it is refused by the broker asynchronously while
  the publish returns normally, so a refused probe is silent and silence is what a live but slow instance
  looks like. Core cannot tell those apart because core does not know what the credential carries. So
  `epScatterService` forwards a caller-supplied hook and never invents one, and the CLI supplies a closure
  that returns `unknown` without publishing for any id outside its pinned set, and reports a refusal the
  broker raises anyway instead of letting it expire into a timeout. That refusal is attributed to the
  instance its own subject names, parsed as an exact route token, so one refusal is never charged to a
  second frozen instance whose id happens to be a prefix of the refused one. `cotal ps` freezes the class on its
  first connection, re-mints an instrument pinned to exactly the frozen ids, and resolves and scatters on
  a second. `instancePinnedInstrumentCapabilities` accepts several ids as well as one; each still emits
  its own concrete rows, so no wildcard instance is minted and the existing boundary on instance
  addressing is unchanged.

  **A registration now has an exit, in two explicit routes.** A manager that stops cleanly deletes its own
  `svc` spec and status keys, so an instance that was shut down leaves no row behind; a manager that loses
  its lease still tears down fail-closed and deliberately does not deregister, because at that point it is
  not the authority on its own record. For the host that cannot cooperate, `cotal deregister-instance
--instance <id>` removes the record, on the same evidence the scatter acts on and no weaker: it asks the
  instance first and refuses if it answers, refuses if the probe could not run at all, refuses if the
  instance is merely quiet, and deletes both keys at the revisions it read only when the broker affirms
  that nothing is subscribed on that instance's own rail. Silence is never the evidence, because a wedged
  process still holds its subscriptions and an unanswered describe is what a dead host, a hung one and a
  slow one all look like. A dead process holds no subscription, so a real corpse still deletes. Nothing
  sweeps the registry on age or on silence. Registering over a deregistration tombstone now works on both
  keys, so a deregistered instance re-registers normally on its next start, with its epoch advancing.

  **Rows split by what was actually established.** A silent instance already printed as registered with
  no answer rather than as unreachable. Now that a probe exists, the four cases behind that one sentence
  are distinguished: a registration the broker affirms is gone says the registration is stale and prints
  the command that removes it, a probe that was refused and one that was never sent each say so, because
  both are facts about the command rather than about the instance, and asked-and-silent keeps the wording
  it has, since a slow host and a wedged one are the same observation.

  **And one layer down, the same shape.** The manager writes `.cotal/manager.pid` itself rather than
  having it written by whatever spawned it, so a supervisor started by a container entrypoint, by cron, or
  by hand is recorded like a detached `cotal up` is; the record is removed on a clean stop, and only while
  it still names that process. Every reader now verifies the recorded pid is alive and is a supervisor
  before trusting it, and a live pid that belongs to something else is reported as a stale record and
  never signalled.

  This does not help against an instance that is connected but not answering. A hung responder holds its
  subscriptions and is indistinguishable from a slow one, so it still costs the full deadline, which is
  the correct result, and the removal verb refuses it for the same reason rather than unregistering a
  process that is still running. A scatter with no probe wired behaves exactly as before.

- Updated dependencies [2752fe7]
  - @cotal-ai/core@0.20.1
  - @cotal-ai/workspace@0.20.1

## 0.20.0

### Patch Changes

- 4743594: `cotal ps` prints what the manager reports instead of folding it into one false word.

  Every row carried two facts, the process (`running` or `exited`, with its age) and the mesh presence, and the CLI printed only the second. A seat whose process has been up for two days but whose mesh session dropped rendered as `offline`, and a seat with no roster entry rendered as `starting...` regardless of age. Both are false statements about a live process. Rows now print both facts, `running 2d 10h  mesh offline`, so the reader can tell a fresh start from a seat that never joined, and a live process from a dead one.

  A registered manager instance that gives no answer within the deadline is no longer labelled `unreachable`, which is a network verdict the client does not hold; it prints `registered, no answer within the deadline` and says that a dead host never deregisters itself. `attach` and `stop` say the same instead of telling the operator to retry against an instance that may never answer.

  - @cotal-ai/core@0.20.0
  - @cotal-ai/workspace@0.20.0

## 0.19.0

### Minor Changes

- a1bc784: Display an agent event frame, and separate event channels from chat.

  An `ag-ui.frame` part carries no text part by design, so every surface that renders a message as
  flat text drew one as `[unrenderable part kind "ag-ui.frame"]`. A renderer now folds a frame's
  events into readable lines: streamed text and reasoning deltas accumulate into one line rather than
  one line each, a tool call reports its name, its arguments and its result, and a stream that ended
  without its terminator is flushed and marked truncated instead of being dropped. An event type this
  build does not know is named rather than skipped, because a skipped event is a hole in a transcript
  that still looks complete. It registers through the part-renderer seam, so the standard resolves it
  by the part's own kind and never learns what the vocabulary means.

  The renderer is loaded by the composition root rather than by a connector. Connectors are removable
  extensions materialized on demand, and no surface that renders imports one, so a provider that
  registered only inside a connector would be absent from every process that draws.

  The event channel's name and its classifier move into the standard, beside the frame's identity.
  Both are things a reader needs in order to recognise an agent's stream without knowing which adapter
  produced it, and the two surfaces that most need to classify cannot reach an extension package at
  all. The constructor is re-exported from its former home, so no caller changes.

  The classifier is now a derivation rather than a prefix test, and the two disagree on names a real
  mesh produces. Nothing reserves the `events.` prefix, so a channel a human created and talks on
  answered yes to "does this start with `events.`" and was swept out of the chat pane it was sent to.
  A name that does not resolve to a principal is no longer treated as machine traffic, which returns
  those channels to the view, and leaves a malformed publisher visible rather than hidden. The
  collision is narrowed rather than closed: a chat channel whose remainder is itself principal shaped
  is still indistinguishable from an agent's stream, and closing that means reserving the prefix on
  the wire.

  The console keeps event channels out of the channel strip and out of the history prefill. The order
  matters more than the result: the channel list carries one entry per retained subject, so filtering
  after the fetch would read history for every event channel and discard it, which is unbounded work
  to display nothing. Live rows are marked rather than dropped, because hiding them would delete the
  only traffic this change taught the console to draw.

  The dashboard gains the same rendering through a per-kind lookup, so its dispatcher stays ignorant
  of every kind anyone teaches it. A renderer that throws, returns a non-string, or shares a name with
  an inherited object method is reported by name instead of blanking the body. The browser cannot
  import the shared renderer, so the two implementations are held together by an executable
  equivalence check rather than by intent.

  The example harness records a message through the shared renderer instead of keeping only its text
  parts, so a message whose content is not text is no longer written to the transcript as an empty
  string and scored as an agent that said nothing.

  No connector emits a frame yet, and no transcript mirror is removed. Display lands first on purpose:
  a cutover shipped before a renderer would replace a readable mirror with a part every surface shows
  as a marker.

- a7267b3: Refuse a class-queue split before the command runs, instead of reporting it afterwards.

  An endpoint call resolves one incarnation and then invokes through a queue that may pick another.
  Until now the caller was the only party that noticed: the mismatch was detected on the reply, by
  which time the responder had already handled the request. That is why the error had to say it
  proved nothing about whether the command ran: a check that runs after the effect is a report, not
  a guard. In a multi-manager space it is how one spawn becomes several: the effect lands on A, the
  caller bound to B is told the call failed, and the retry duplicates it.

  A request now carries the incarnation the caller resolved against (`bind`, a new optional
  `EndpointRequest` field), and a responder that is not that incarnation refuses at the pre-effect
  seam, before args validation, before target resolution, and before the governed gate that can
  consume a one-use payment proof. The refusal carries `ai.cotal.ep.bind-refused` and states that
  the command did not run, so re-resolving and re-issuing is safe. `failed-precondition` when a
  different instance received it, `expired` when the same instance is at another epoch: the epoch is
  carried even on the instance rail, where the subject grammar has no token for it and a successor
  incarnation would otherwise serve its predecessor's caller.

  The block confers nothing. It can only make a responder the subject already reached refuse, so it
  narrows and never widens, and attribution still comes from the reply subject: a refusal
  attributed to the very incarnation the caller bound is incoherent and is rejected rather than
  honored, so the marker cannot be used to claim an effect away. It is refused rather than ignored
  where it has no reading: on `describe`, which is what produces a bind, and on the scatter rail,
  which addresses every incarnation by construction.

  A long-lived client recovers from the refusal instead of stranding on it. `invokeService` caches
  its resolve, and its existing split recovery keyed on a thrown marker, which a refusal, being an
  ordinary reply, never raises. It now keys on the reply too, drops the stale bind, and re-issues
  the call **once for any command**, not only for one on the repeat-safe allowlist. That allowlist
  exists because a split used to be detected after the responder had handled the request, so core
  could not tell a duplicate-able effect from a repaired one and had to fail closed; a bind refusal
  removes the uncertainty rather than working around it, so the re-issue is a first attempt.

  The allowlist still governs everything else, and that is the half that keeps this safe. A
  responder that predates the fence ignores the field and executes, so its reply proves nothing
  about whether the command ran, and re-issuing on it would duplicate the effect. The re-issue is
  therefore withheld from every reply that does not carry the refusal, and the refusal is checked
  rather than believed: the bind it was computed against must be the one this request carried, and
  the incarnation it claims to be must be the one the reply subject attributes it to. Both halves
  are derivable by the caller, and neither is something an unfenced responder can produce by
  accident. A refusal that fails either is `internal`, not a licence to try again.

  A re-issue that cannot be resolved surfaces the refusal, not the resolve. Re-resolving goes back
  to the registry, and an endpoint that has since retired answers nothing, so a stale handle used
  to be met with a describe deadline ten seconds later, with the one fact that said the command had
  not run discarded on the way. The refusal now surfaces, carrying its marker, with the resolve
  failure named as the reason the repair could not be attempted.

  That recovery is counted, and the counter is the point. Handling a split makes it invisible, and
  the routing event is the only evidence the split exists at all; silence it and the split rate
  becomes unmeasurable exactly as it becomes survivable. `CotalEndpoint.splitRecoveryCount` is
  always on and never behind a flag, and a `split-recovered` event carries the same fact for anyone
  listening; the event can be missed, the count cannot. On a live two-manager mesh, 5 of 6 unpinned
  class-anycast reads split, so this is not a rare-event counter.

  The caller-side check remains, and remains necessary: a responder that predates the fence ignores
  the field and executes, which leaves the older after-the-fact report, and the allowlist, as the
  only protection in a skewed pair. That pair is now driven directly rather than argued about, by a
  hand-rolled responder that answers the class rail without a fence; `serveEndpoint` cannot produce
  the case, because its fence refuses a mismatched bind before the handler, so a request it executes
  is one whose bind matched. `--on` still addresses a specific manager, but it is no longer what
  stands between a split and a duplicated effect.

  The suites count executions at the responder rather than publishes at the caller, and the change
  was forced. "One publish" meant "one execution" only while a split was caught after the responder
  had handled the request; under the fence the second publish carries the first execution, so the
  old instrument reports a correctly repaired call and a duplicated one identically. Where a claim
  narrowed, the cell says which condition moved it rather than being replaced.

  SPEC §13.2 and §13.3 carry the normative rules; `docs/control-surface.md` is updated.

- 7f83b8c: `cotal mint --provision` (agent profile) pre-creates the identity's bind-only DM/deliver durables and its role's task queue on the live mesh, so a credential minted out of band can consume rather than only publish; `--role <role>` names the anycast queue, and `--space`/`--server` pick the mesh. The command now prints the identity's principal and lifecycle uid, the two facts a consuming client needs beyond the file.

### Patch Changes

- 87c4130: Say what a refused publish, a goal deadline, and a class-queue split actually proved.

  A refused publish now reports itself. `nc.publish` is fire-and-forget: a caller whose credential
  does not authorize the subject gets an asynchronous answer on the _connection_, so the publish
  returns normally and the only observable is that no reply arrives. That is indistinguishable from
  an absent responder, though the two need opposite responses: mint the grant, or go find the
  responder. An instance-addressed describe made with a class-rail credential is exactly that case,
  and it read as an unresponsive manager: measured live, `ps --on <instance>` returned `no describe
reply from manager within 10000ms` against a 115ms RTT while an untargeted describe answered from
  either instance in well under a second. The describe now watches its connection for a permission
  violation on its own subject and raises `permission-denied` naming that subject, the instance rail,
  and the fact that the responder may be perfectly healthy. The watch closes its status iterator on
  every exit, so it does not leave a listener parked on the connection per resolve.

  A goal that produced no terminal in time no longer implies the goal failed. It was accepted; only
  its terminal did not arrive within the wait. Observed live: seats that reported this had already
  come up and were messaging peers, and retrying submitted a second goal that duplicated the effect.
  The message now says the deadline is on the wait rather than the work, and says not to retry on it
  alone.

  An unpinned class-queue split no longer implies the effect did not land. Describe and invoke are
  separate trips through the same anycast queue, so in a multi-instance space the instance that won
  the queue received the request and may have executed it, possibly after the error was raised. The
  core message now says so and points at `ps`/`inspect`/roster before any retry; it stops at "a call
  that addresses one instance does not split". The CLI adds `--on <instance>` as the remedy, and only
  on the commands that have the flag (`ps`, `stop`, `attach`, `spawn --detach`), which declare it to
  the shared renderer; `models`, `up` and `down` ride the same rails and split the same way, and are
  no longer told to type a flag they do not have. Absence of a pin is not evidence of the flag.

  And a split is no longer silently retried into a duplicate effect. The client recovered from
  `failed-precondition` by dropping its cached resolve and invoking again, which is a repair when the
  bound incarnation is gone but a second attempt when the error came from a different live instance
  answering the class queue: request received and answered (executed or refused; the reply does not
  say which), error raised afterwards. Re-invoking there re-issued the command automatically, while
  the error text told the operator not to retry; it is the mechanism behind one spawn producing
  several seats. The retry now happens only for commands
  whose second execution is observably indistinguishable from one: the reads and `describe`. Every
  other command surfaces the split to its caller, carrying a marker that says a responder did answer
  the request, so the caller can check before deciding. Surfacing also drops the stale bind: the
  cached resolve named an incarnation a different live instance has just answered for, and keeping it
  would send every later deliberate call on that endpoint into the same refusal, so the caller could
  verify and still never reach the live instance. Dropping it re-issues nothing; the next call is the
  caller's own.

  The same rule now covers the adjacent case, a manager restarted in the same workspace root. That
  restart keeps the logical instance id and advances its epoch, so a client that resolved before it
  gets its next answer from the same id at a later epoch: `expired`, raised after the attributed reply
  just like the split. It used to be rethrown untouched with the bind kept, so a long-lived client
  (a connector's mesh agent, the console) reached the successor on every later call, may have applied
  the effect each time, and never recovered. The stale-epoch refusal now carries the same
  responder-answered marker, the guard keys on the marker rather than the error code, and its message
  says which side is stale: a responder ahead of what the caller holds is a successor (re-resolve to
  adopt it), one behind is a superseded incarnation still answering. The old text called the caller's
  own bound epoch the responder's "current" epoch, which named the wrong side.

  That classification is an allowlist and fails closed at both levels. It is keyed by endpoint, not by
  bare command name, because the client is endpoint-agnostic and a flat list would lend the manager's
  judgement to any endpoint that happened to reuse a name; an endpoint nobody has classified has no
  repeat-safe commands, and an unlisted command is surfaced rather than repeated. `describe` is the one
  exception, and structurally so: it is served by the machinery on every endpoint and can never be
  redefined into something that mutates.

  `models` is deliberately not on that list even though it is a read command. With `{refresh: true}` it
  reaches the connector's model listing and, for OpenCode, re-fetches provider catalogs and rewrites a
  cache: the same name, in the same grant class, answering differently because of an argument the
  classification cannot see. A long-lived client invoking `models` through `invokeService` therefore
  surfaces a split rather than absorbing it in a multi-instance space; encoding per-command argument
  rules here would reintroduce exactly the fail-open shape this replaced.

  Where this table bites, precisely: it is read only by `CotalEndpoint.invokeService`, the long-lived
  client path. Its shipped callers are the connector's `cotal_*` manager tools (spawn, inspect, stop,
  despawn, purge, define-persona), `cotal spawn -f` (launch) and `cotal down -f` (despawn), whose
  splits now surface instead of being re-issued, plus the repeat-safe `ps` reads of `spawn -f`,
  `down -f` and the console, which keep absorbing them. The one-shot CLI commands (`cotal ps`,
  `cotal models`, `stop`, `attach`, `spawn --detach`) resolve fresh and invoke once on a short-lived
  connection; they had no cached bind and no retry, and are unchanged. That is the clearest statement of what the list is: a client-side
  stand-in for `effect` (SPEC 13.7), which the wire now carries and this change does not yet consult.
  The spec grew both halves after this work began: `effect` declares whether repeating a command is
  safe, and rides `protocol.v: 2`, while this tree still registers and resolves at `v: 1`, under which
  every command reads as a write. Reconciling the two is a separate change and is named here rather
  than described as absent from the wire.

  The CLI no longer prefixes every failed manager call with "no manager reachable on the ep rails".
  That verdict is stated only where the call went unanswered, as core marks it: no responder, or the
  reply deadline elapsed with nothing attributed to the request. The catalog code alone was not
  evidence of that. A manager that answers its describe with `ok:false` has the refusal rethrown under
  its own code, `unavailable` included, and a store read after an answered describe raises the same
  code; both printed as an unreachable manager while a manager was answering (reproduced live during
  review). Core now sets a detail kind on the producers that observed silence and the CLI keys on it,
  never on the code. A registry read on the caller's own side (the scatter's freeze or its reconcile)
  is a third outcome with its own line, since the managers were not the failure and may all be up. A
  refusal that states its own cause (a describe refused by the broker, a split, a stale epoch) is
  printed as it is, because the prefix contradicted it, and an unanswered `--on <instance>` names the
  instance that did not answer instead of pronouncing on the mesh (measured: three managers answering,
  one typo in `--on`, "no manager reachable"). `up`'s resume readiness poll keys on that same
  unanswered fact rather than on the message prefix.

  `ps` prints the full instance id in its multi-manager view. That view appears only where the split
  makes `--on <instance>` the one way to address a manager, and `--on` accepts nothing but the whole
  26-32 character lifecycle token, so an abbreviated header named the remedy and withheld the value
  it needed, and `--on <prefix>` was refused as a malformed token. The `stop`/`attach` seat-lookup
  miss, which lists the instances that did not answer for the same purpose, prints them whole too and
  says the id must be passed as printed. `spawn` refuses `--on` outside a detached imperative spawn: a
  foreground spawn has no manager to pin and a manifest deploy launches through the manager class
  queue, so the flag was accepted there and silently ignored. An empty `--on` (`--on ""`, an unset
  shell variable) is refused at the flag on all four commands: `ps` and the detached `spawn` carried it
  to the mint, which refused it as an invalid token, while `stop` and `attach` read it as absent and
  fell through to the seat lookup, so one input had two answers and one of them was a dropped pin.

  The peer-side manager tools stop reading silence off the catalog code too. `MeshAgent`'s manager
  invoke reported "no responder answered - a manager may be down, or this credential holds no <cmd>
  capability and the broker denied the request" for every `deadline-exceeded`, and the bare code for
  everything else. That was wrong in both directions. The broker's no-responders 503 arrives as
  `unavailable` carrying the unanswered marker, so the one case where the capability explanation is
  certain was the one case that did not get it: an agent denied a capability was told only
  "unavailable". And an answered `ok:false` describe is also `unavailable`, deliberately unmarked
  because a manager did answer -- and this surface is read by agents, where a claim of silence invites
  the retry that duplicates a spawn. Same code, opposite conditions, separated only by the marker,
  which is now what the verdict keys on.

- 007a17b: `cotal up` now provisions the data-account half of the membership bundle on every run, not only when a space is first created, so a space provisioned before broker-sourced membership gains the graph feed without regenerating its auth. The delivery daemon's incomplete-bundle message now names the repair that matches the missing piece instead of always pointing at a system-account rotation.
- eae512e: `cotal mint --profile agent` now mints the lifecycle uid the agent profile requires, instead of failing on every invocation. The agent arm of `permissionsFor` builds lifecycle-keyed dm/dlv/chathist grants and threw without one, so the default profile could never be used and the only reachable profiles were observer and admin, neither of which can publish to a channel.
- 12f2df8: Refuse to stamp the connector seed store down to an older generation. A cotal older than the store's
  stamped generation used to miss the fast path, refresh nothing, and then write its own version over
  the stamp, leaving the store claiming a generation whose payloads were not the ones installed and
  making the next newer command reinstall every connector. It now fails loud before writing anything,
  naming both generations and pointing at `cotal ext seed --reset`.
- Updated dependencies [48c6631]
- Updated dependencies [10d9cd6]
- Updated dependencies [a1bc784]
- Updated dependencies [a7267b3]
- Updated dependencies [ce1c248]
- Updated dependencies [5e95736]
- Updated dependencies [19931dd]
- Updated dependencies [6074c26]
- Updated dependencies [24687a3]
- Updated dependencies [17f14be]
- Updated dependencies [87c4130]
- Updated dependencies [cb9e1ad]
- Updated dependencies [c038730]
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [8572a5d]
  - @cotal-ai/core@0.19.0
  - @cotal-ai/workspace@0.19.0

## 0.18.0

### Minor Changes

- b519e73: Add the Herdr integration: a new `@cotal-ai/herdr` extension with a self-registering `herdr` Runtime provider that spawns managed agents into panes of a dedicated named Herdr session (`cotal-<space>`), where the Herdr server owns them — so they survive the manager's terminal going away. Requires herdr >= 0.8.0, enforced by a version check rather than a bare binary probe, so an older herdr reports the runtime as unavailable instead of advertising it and then failing every spawn.

  Each agent gets its own workspace and name-labeled tab by default (`COTAL_HERDR_LAYOUT=split` folds them into one shared tab). A spawn is `workspace create` + `pane run "exec …"`, then a bounded wait on the real process table — `pane run` types into a shell, so a delivered keystroke is not proof that anything started. The `exec` is load-bearing: without it the pane's shell outlives the agent and no exit could be proven. Lifecycle is keyed by Herdr's stable `terminal_id` with the public pane id re-resolved per operation off the session-wide pane inventory; creds ride an owner-only launcher script, never herdr's command line or its native `--env` (which lands in pane scrollback); every CLI call is scoped with `--session`.

  Spawned agents do not appear in Herdr's Agents sidebar: 0.8.0 reserves that registry for recognized agent kinds attached to an existing pane, so an arbitrary launcher is never one. They are identified by tab label and a `cotal` metadata token on the pane.

  The CLI lists `herdr` among the official runtimes (`cotal runtimes`, `cotal ext add @cotal-ai/herdr`), and CI now installs herdr so the extension's smoke suite actually gates rather than silently skipping.

- 665b378: Gate which broker addresses a mesh may be registered at, and make the unsafe one an explicit choice.

  Registering a mesh is how a machine starts sending agent credentials to a broker it does not run,
  and nothing here can require an encrypted connection yet. NATS announces itself in plaintext
  before anyone authenticates, so an attacker on the path can pose as the broker and read the
  credential straight out of the connect; a `tls://` URL does not prevent it, because it is the
  connect options rather than the scheme that make the client insist on TLS.

  `cotal meshes add` therefore gates on the address. Loopback literals (`127.0.0.0/8`, `::1`) are
  permitted because nothing leaves the machine. Private-overlay literals (`100.64.0.0/10`,
  `fd7a:115c:a1e0::/48`) require `--allow-unencrypted-overlay`, an explicit acceptance that is
  recorded on the mesh entry: they ride an encrypted tunnel only while that tunnel is actually up,
  and with it down the range is ordinary carrier-grade NAT that hostile routing can answer. A
  printed warning was not enough — stderr is not read by scripts, and it was not persisted, so
  nothing repeated it at the dials that followed. Everything else is refused, including ordinary
  private ranges such as `10.x` and `192.168.x` — a café network is private too, and private is not
  the same as yours.

  Registering an authenticated mesh also copies that mesh's `.cotal/auth`, which carries the space's
  account **signing seed**: a machine holding it can mint any identity in the space until the signing
  key is rotated and every credential re-minted. The docs and the guided form now say so where the
  operator reads them, and `cotal mint` alone does not substitute (registration needs signing
  material that composes).

  **Scope, stated precisely so this is not read as more.** This gates NEW REGISTRATIONS, and only
  those. It is not a client-side dial fence: a record written before this change, or a `--server`
  override, reaches the broker through the ordinary connect path without consulting it. Calling the
  join path "protected" or "made safe" would be wrong. Fencing the credential-bearing dial itself
  is separate work.

  Hostnames are refused as well, even ones that resolve somewhere permitted, because otherwise
  whoever answers the lookup decides which machine receives the credentials. The check runs before
  `--force`, which exists for a mesh that is temporarily down and never waives it.

### Patch Changes

- Updated dependencies [0ab9b4d]
- Updated dependencies [208ad1f]
- Updated dependencies [665b378]
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0
  - @cotal-ai/workspace@0.18.0

## 0.17.0

### Minor Changes

- 975cad1: Give each space an artifact object store, with a real size limit.

  The `artifact` message part references bytes that live outside the message; this is where they live.
  Every space now gets a JetStream Object Store alongside its other streams, created by the same setup
  that creates them and removed by the same teardown.

  It carries an explicit 4 GiB cap, which is the point rather than a detail. A fresh object store ships
  unlimited, and a space's account is provisioned with unlimited disk, so "the account limit bounds it"
  would have bounded nothing — artifacts could grow until the disk did, starving the chat and delivery
  streams sharing it. Reaching the cap refuses the write instead of evicting older objects, so a
  reference published yesterday cannot quietly stop resolving.

  A space resource has to be listed in five separate places — created, deleted, granted, enumerated for
  backup, and recreated on restore — and being in four of them is the failure that reads as correct.
  Excluding the store from backups does not mean restore skips it: restore rebuilds every excluded
  resource and then asserts each one exists, so a store left out would fail a restore rather than
  quietly come back missing. The store is excluded under its own class rather than borrowed from an
  existing one, because artifact bytes are neither transient, derived, nor a lease, and calling them
  derived would suggest something could recompute them.

  Two smokes join the gate. One proves the store against a real broker by enumerating what the broker
  actually holds — created, matching the inventory exactly, carrying its cap, and gone after teardown —
  because create and delete are claims about a broker and cannot be checked any other way. The second
  was already in the repository, asserting the stream inventory, and no script had ever run it; it is
  now registered and gated, and it fails correctly on this change.

- c76a49d: Add the `artifact` message part: a reference to bytes too large to send.

  Every Cotal message rides one NATS message under the broker's maximum payload, so moving a file
  between agents has meant pasting bytes into chat until it breaks, or sharing a filesystem path that
  stops working the moment two agents are not on the same machine. SPEC §5 reserved the answer; this
  defines it. A message can now carry `{ kind: "artifact", name, mediaType, digest, size }` — the
  content address of the bytes, and nothing about where they live, so the store behind it can change
  without any message changing shape. This is the contract only: the transport that serves the bytes
  lands separately.

  The digest is the one field that is not taken on trust. `name`, `mediaType`, and `size` are
  whatever the sender wrote, and a receiver that sizes a buffer from `size` or dispatches on
  `mediaType` has believed a stranger; `verifyRawBytes` checks fetched bytes against the digest before
  they reach a caller, which is what catches a store handing back a truncated object — otherwise
  indistinguishable from a small one.

  `artifact` is a bare core kind rather than a namespaced extension, because reverse-DNS kinds are for
  wrapping vocabularies Cotal does not own, and this is Cotal's own reserved primitive. That
  distinction has teeth: a core kind the message validator does not know is not a schema detail. The
  validator gates the durable delivery frame, so an unrecognized core part means the backstop drops
  the whole message, silently, and the loss shows up nowhere near the part that caused it. The
  `artifact` guard is enforced there, and it checks the digest's form rather than only its type — a
  malformed digest is not a reference to anything, and admitting one would turn a bad message into a
  "missing artifact" that blames the store.

  Message rendering moves to a single `partsToText` in core. The same one-line expression had been
  copied into the connector inbox, `cotal join`, and the mesh view, and each copy fell back to
  stringifying a part's `data` field — which an artifact part does not have, so all three would have
  rendered it as the literal word "undefined". One renderer means a new core part kind is legible
  everywhere at once, or nowhere, never in two surfaces out of three.

- fd361fe: Serve the broker over TLS: the transport foundation, with the omission cases made unrepresentable.

  `serverConfig` and the new `openServerConfig` take a REQUIRED `transport` discriminated union
  (`plaintext` | `tls-required { certFile, keyFile }`) instead of an optional TLS field, and
  `standaloneConnectOpts` now requires an explicit `tls` boolean with no default. Both are breaking,
  and both are deliberate: an optional transport is omitted by default, and the omitted case is the
  dangerous one. A client with no TLS requirement still connects to a TLS broker — it upgrades the
  same socket after reading the server's unauthenticated `INFO` — so nothing looks wrong until an
  on-path attacker forges an `INFO` without `tls_required` and collects the credentials that a NATS
  client sends in its `CONNECT` line.

  Also in this change:

  - `cotal up`'s open (no-auth) mode now renders a config instead of launching from bare CLI flags, so
    no path reaches a listener without naming its transport. Previously a cert/key pair given to an
    open-mode `up` would have been accepted while the broker came up in cleartext.
  - `validateTlsMaterial` checks readability, private-key mode, pair match, validity window and
    dial-host SAN before the broker starts, because `nats-server` does not: it reports an expired
    certificate valid, starts, and serves it, and only the client fails.
  - `probeServedCert` / `assertServedCertMatches` complete a real STARTTLS upgrade and read back the
    leaf actually being served, so a rotation is proved rather than assumed. Renewing files on disk
    does not reload `nats-server`.
  - A durable broker launch policy records the transport so a TLS decision survives `cotal down`, and
    refuses rather than degrading when it cannot be honoured.
  - `MeshEntry.tlsRequired` carries TLS-required client intent (never cert paths) through to
    `Connection` and `endpointAuth`, so a CLI-resolved connection inherits the recorded decision.

  `allow_non_tls` is never emitted: it is mixed mode, and a client that declines the upgrade is served
  in cleartext. `handshake_first` and `verify`/`verify_and_map` are likewise never emitted — mTLS is a
  deliberate non-goal, since identity here is JWT/NKey plus the auth callout.

  ## What this guarantees, and what it does not

  **The guarantee.** `cotal up --tls-cert <cert> --tls-key <key>` either serves TLS or refuses to
  start. There is no third outcome. The transport is decided once, above every branch in `up`, so the
  manifest (`-f`), `--detach`, refresh and restore routes cannot reach a listener without naming it;
  each route re-checks the certificate against the host clients will actually dial. A running broker
  cannot change its transport, so passing the flags to an already-running mesh is refused rather than
  answered with a success line. The decision is recorded, so a later bare `cotal up` after a
  `cotal down` keeps serving TLS instead of silently reverting to cleartext.

  **A direct `CotalEndpoint` construction still defaults to plaintext.** `EndpointOptions.tls` remains
  optional and absent still means "no TLS required". If you build an endpoint yourself rather than
  going through `cotal up` or a resolved mesh record, you must pass `tls: true`; nothing will tell you
  otherwise, and the connection will succeed either way against a TLS broker because a NATS client
  upgrades the same socket once it reads the server's `INFO`. Making that field required is a tracked
  follow-up. It is called out here because "Cotal supports TLS" is not something you should be able to
  believe while your own client is connecting without requiring it.

  **Client-side strictness is NOT complete, and the honest scope is wider than a short list.** The
  broker refuses cleartext, so none of these connects in the clear against a healthy TLS broker — a
  NATS client upgrades the same socket once it reads `tls_required`. What they lack is their own
  requirement, which is the fence against a stripped or forged `INFO`, and that is the whole reason
  this feature exists.

  Two distinct cases, and the second is worse:

  _Never had a TLS path / passes `tls: false` explicitly._ `waitForDeliveryLease`
  (`packages/core/src/lease.ts`) builds its own `connect` options rather than going through
  `standaloneConnectOpts`. The user-auth service and the membership feed connect the same way.
  The **enumerated** `standaloneConnectOpts({ … tls: false })` sites at this tip (twelve, not a
  prose list) are:

  | File                                       | Lines              | Role                                                                                                                                                              |
  | ------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `packages/core/src/channels.ts`            | 166, 192, 217, 238 | channel-registry helpers                                                                                                                                          |
  | `packages/core/src/streams.ts`             | 322, 369, 398, 439 | stream/history helpers                                                                                                                                            |
  | `implementations/cli/src/commands/up.ts`   | 1155, 1234         | `provePreparedRestoreListener` / `proveOrdinaryResumeListener` authenticated JetStream proof (restore + ordinary-resume adopt only — not bare `up` / bare `down`) |
  | `implementations/cli/src/commands/down.ts` | 651, 691           | `assertControlPlaneQuiesced` / `readPresenceWithoutConsumer` — **only** on `down --preserve-state`, not bare `cotal down`                                         |

  Bare `cotal down` does **not** hit those two `down.ts` sites: it stops via pidfiles
  (`stopLocalProcess`) and never opens a broker wire. Live-checked twice: `up --detach --open
--tls-cert/--tls-key` then bare `down` (with `NODE_EXTRA_CA_CERTS` stripped on the down step) stops
  manager, delivery, and nats-server and leaves the port `ECONNREFUSED`. There is no silently-skipped
  safety gate on ordinary teardown.

  `down --preserve-state` is the only path that calls `assertControlPlaneQuiesced` (via
  `isReachable(mesh.server)` at `down.ts:585`, then the `tls: false` connects at :651/:691). Bare
  `isReachable(server)` is a plaintext INFO probe (`tcpInfoProbe`): on this branch's STARTTLS TLS it
  still returns **true** (INFO precedes the upgrade), so the quiescence gate is **entered**, not
  skipped, when the client trusts the CA. **Narrow residual (do not fix in this branch):**
  `down --preserve-state` **and** a CA the client does not trust — then a stricter `{tls:true}` probe
  would fail, the INFO probe still says up, and the subsequent authenticated connect without a trusted
  CA fails or the cut proceeds without a completed wire-truth lease proof depending on the failure
  mode. Same family as the private-CA diagnosis gap (S7); incomplete client fence, not an ordinary-path
  break. Flagless sites mostly **work** via auto-upgrade and are **unfenced** (no own requirement
  against a forged INFO), not "broken teardown."

  _Resolves the decision and then drops it (partially closed)._ `cotal web` now passes
  `tls: conn.tls` into its endpoint. `cotal status` carries `target.tlsRequired` on the Selected Mesh
  preflight, the open/auth live snapshot, the user-mode connection probe and user live snapshot, and
  the Recorded Meshes liveness check — a mesh recorded `tlsRequired: true` is not greened by a bare
  TCP/INFO probe against a plaintext substitute. What still drops the decision: the mesh manager
  (`startManagerDetached`'s options type has no `tls` field, so `ensureControlPlane` forwards `--tls`
  to the delivery daemon and then launches the manager without it), plus the never-had-a-path sites
  above.

  Client-side strictness landed for: `cotal up` (every route to a listener), the recorded mesh record
  (`MeshEntry.tlsRequired`), CLI-resolved connections that go through `resolveMeshTarget` /
  `endpointAuth`, `cotal status`, `cotal web`, and the delivery daemon's three dials. It has not
  landed for the manager process, the user-auth service, the membership feed, `waitForDeliveryLease`,
  or the twelve helper sites tabulated above. That table is the residual enumeration; do not collapse
  it back to prose.

  The delivery daemon is strict on all three of its dials, including the every-two-seconds reachability
  poll that re-presents its standing credential for the life of the process.

  **Also not included:** the `cotals://` handout from `up`; a rotation command; and `tls://` as a
  _server_ scheme enforcing anything (it is cosmetic at the client: nats.js connects plaintext to
  `tls://host` with empty options, and only the explicit `tls` option refuses). **Changing transport
  on a live broker is restart-only by construction:** passing `--tls-cert/--tls-key` (or dropping
  them) against an already-running mesh is refused — `cotal down`, then `cotal up` with the desired
  flags. A reload of `nats-server` is not offered, because it would leave established plaintext
  sessions alive.

  Operators using a private CA need `NODE_EXTRA_CA_CERTS`, because `EndpointOptions.tls` is a boolean
  and cannot carry a CA file. The private-key permission check is POSIX-only.

  **S10 (fixed in this change):** a `tlsRequired` registry entry used to be **pruned** when a
  `connectOrExit` / `preflightOrExit` path ran without a trusted CA. `preflightTarget` probes with
  `{tls:true}`; certificate verification failure was classified as `unreachable` (prune:true), so
  `cotal send dm …` (and any other preflighted command) deleted a healthy mesh record on a recoverable
  trust error — durable state destroyed because the operator forgot `NODE_EXTRA_CA_CERTS`. Fix: when
  the recorded target requires TLS and the TLS probe fails as unreachable, confirm plaintext INFO
  still advertises `tls_required: true` (with a second, longer read before condemning); if it does,
  classify as `tls-trust` with **prune:false**. That proves a TLS-required NATS listener is present —
  INFO is unauthenticated and is not mesh identity — so the record is conservatively kept and the
  operator is told to fix the trust store (`NODE_EXTRA_CA_CERTS`). A plaintext substitute on the same
  port does not advertise `tls_required` and still follows the normal unreachable/prune path.
  Live-checked both ways.

  **Named follow-ups (not fixed here):**

  - Defence-in-depth only: pass `mesh.tlsRequired ? {tls:true}:{}` at `down.ts:418`/`:585` and thread
    transport into `:651`/`:691` (measurement showed bare INFO already enters the preserve-state
    quiescence gate when the CA is trusted).
  - Bare `cotal down` pidfile-trust: hiding manager/delivery pidfiles while those processes still run
    lets bare down stop the broker and report success (pre-existing; filed separately).

- 019afc3: The manager control surface gains three capabilities on the v0.4 endpoint rails: spawn as an action, multi-manager instance addressing, and attach as a mesh session.

  Spawn and launch are now actions (SPEC 13.6). Asking the manager for an agent no longer blocks the caller while the process comes up: the manager accepts a spawn goal and returns the allocated identity at once (`{name, owner, actor, uid, goalId, fingerprint, executor{lifecycleUid, epoch}}`), then progress events follow the launch to a terminal outcome. Presence within the readiness window settles the goal `succeeded`, an early exit `failed`, and the window elapsing with neither is `uncertain` (a bounded, durable outcome a later `ps` settles against the live roster, never a silent hang). A persona-derived name collision auto-numbers; a hard-pinned `--name` colliding with a live agent refuses at accept, before anything is minted. The `--detach` CLI spawn, the manifest `-f` launch, and the connector's `cotal_spawn` submit and follow to the terminal, so their behavior is unchanged. The goal terminal is fenced to the executing manager's own gate epoch (the terminal lands on an epoch-scoped result subject), so a superseded incarnation's terminal is invisible to current readers; a durable reconcile index lets a restarted manager settle any goal a predecessor accepted but never terminalized. The goal-fact writer is a dedicated, family-staged, renewed credential disjoint from the serve credential.

  One space can now run more than one manager. Each manager persists a stable logical instance id across restarts and advances its process epoch when it comes back, so peers address a specific manager regardless of which process currently serves it; a restart re-registers the same instance and evicts its predecessor's serve family through a scoped, one-registration eviction credential. `cotal spawn --on <instance>` pins one instance by its exact id, an untargeted spawn rides class anycast (the acceptance records which instance took it), and `cotal ps` / `status` become a class scatter that merges every registered instance's rows with per-instance attribution and labels a non-answering instance unreachable, never omitting it. The manager lease is demoted from a per-space singleton to per-instance liveness (loss stops only that instance's serving, never the space), reconcile touches only rows the instance owns, and the retirement rail authorizes on the registration gate rather than a name-derived holder, so a deposed predecessor cannot retire a target.

  `cotal attach` no longer returns a `127.0.0.1` websocket URL. It creates a one-use, holder-bound session over the mesh: the reply carries a signed session grant (no URL, never logged), redeemed once, after which terminal bytes stream on session subjects scoped to the two parties, with backpressure surfaced as an explicit drop notice. A late attach still repaints the full screen from a replayed terminal snapshot, and close, expiry, target despawn, and manager restart are distinct, surfaced end states. The browser console is now a real mesh session client over a served bundle (the broker gains a localhost-default websocket listener), holding only a per-session, rails-only credential that expires with the session. The manager's session writer is a scoped, family-staged, renewed credential over a dedicated sessions store.

- f85ffbf: The manager now registers itself as an ordinary v0.4 `service` endpoint (`manager`) on every static auth mesh and dual-serves its FULL typed command surface on the endpoint rails beside the existing control tiers — nothing removed yet. The served commands mirror every control op through the same handler cores: `status`, `ps`, `inspect` (per-agent read), `models`, `spawn` (the full 16-field launch surface), targeted owner-mode `despawn`/`attach`, the baseline self-mode `stop`, `define-persona`, `purge`, `launch`, the resume/preservation family, and the reserved `describe`. `ps`/`inspect`/`spawn` replies now also carry each agent's `lifecycleUid` (the coordinate a targeted request pins). Core gains the production endpoint-serve credential subsystem over the durable auth store: the §13.1 endpoint issuance gate and serve ledger (`epgate…`/`epcred…`), the registration barrier with fail-closed eviction, and the serve-mint release fence — plus a key-pinned one-shot `endpoint-serve-executor` credential profile scoped to exactly one endpoint instance's gate, serve-ledger family, and registration record keys. The manager drives its registration and every serve-credential mint and renewal through that scoped executor connection (never its standing supervisor connection), applies one shared lifecycle-membership + maintenance admission gate on both control doors (the legacy `ctl` tiers and the new endpoint rails), and renews its bounded serve credential on the standing renewal pass. Registration also publishes the manager's §13.7 contract artifacts — every command's schema root, its closure manifest, and the cluster document — to the per-space content-addressed contract store (created create-or-verify at manager start alongside the authority stores), and every agent credential's baseline now carries the store's read grant, so any caller can fetch, verify, and recompile the registered schema digests without out-of-band contract sharing.

  The control CONSUMERS now ride those rails (static-auth meshes): every CLI manager call (`spawn --detach`, `ps`, `stop`, `attach`, `models`, `down`/`up`'s resume and preservation phases) and every connector supervision tool (`cotal_spawn`/`cotal_despawn`/`cotal_persona`, self-stop, history purge) goes through the generic invoke path - describe, fetch the registered schemas from the contract store, recompile digest-verified validators, invoke - instead of hand-importing the manager's contracts; invoke currency is describe-bound (the answering incarnation's broker-authenticated identity), so a superseded or split-brain manager refuses instead of answering stale. New `cotal describe <endpoint>` and `cotal invoke <endpoint> <command>` expose the same generic surface to operators. Operator reach is now minted, not door-refined: `control-caller-privileged`/`control-caller-admin`/`deployer` instrument credentials carry tier-matched endpoint capability rows (the admin tier's cross-agent `despawn`/`attach` ride the operator-only `any` authorization mode, declared in the manager's revision-3 cluster document), the spawn capability additionally mints `define-persona` + `inspect`, and an `admin`-capability credential mirrors the full admin instrument set. Open meshes and user-mode bearers kept the legacy `ctl` path until the final slice below.

  User-mode meshes join the migration end to end: the manager registers its v0.4 service on per-user meshes too (the registration/serve machinery is operator infrastructure riding the space's static trust material), the CLI's bearer path derives its caller triple from the bearer's ledger lifecycle claim, the connector's endpoint identity is its triple in every auth mode (no ctl branch left in the connector), and `spawn -f`'s deploy probe drives `ps`/`launch` over the generic invoke path for both the static admin credential and the user-mode deployer view. Serve-side hardening: every `manager.admin`-class command (purge, launch, and the resume/preservation family) re-checks operator reach at serve time against the caller's CURRENT ledger scope on user meshes, so a revoked `admin` scope demotes the next call instead of riding out the bearer's remaining row lifetime.

  The migration is now complete: the manager's legacy `ctl` control rail is deleted. Core drops the `manager`/`self`/`admin` control tiers, the `ControlTier` type, and `controlSubject`; the server-side `ctl.delivery`/`ctl.delivery-admin`/`ctl.auth-admin` rails (the delivery daemon's and auth service's own carve-outs) are unchanged. Every credential profile is endpoint-only: agent baselines lose the `ctl.self` publish and control-reply subscribe rows, the supervisor serves no control tier, and the operator instruments carry endpoint capability rows only, so the old manager control subjects are unreachable end to end (publish rows, serve subscriptions, and handlers are all gone). The manager registers its `service` endpoint on EVERY mesh: auth meshes ride the scoped endpoint-serve executor; open meshes run the same gate/registration/serve-grant ceremony over bare one-shot connections (no credential is ever minted; the broker enforces nothing on an open mesh) and create-or-verify the authority stores at boot, so a raw broker no longer dies at the first gate write. The CLI's control layer replaces `ControlTier` with `ControlReach` (`owner`/`any`): the target's authorization mode derives from the resolved target owner (an own-domain target rides owner mode; a cross-owner target rides any mode, which the broker admits only for admin-instrument holders), open meshes ride a bare caller triple, and a raw `--creds` control caller without an endpoint caller identity refuses loud instead of falling back. `ps`/`inspect` rows pin `role` as optional (a manifest-launched agent declares none, and the reply schema previously failed the responder's own output).

- 11cd652: `cotal ps` on a user-auth mesh no longer class-scatters.

  **Why.** The class scatter freezes the live manager set via a records-bucket `STREAM.INFO` read that only the static `control-caller-privileged` instrument holds. A user-mode bearer never has that row, so scatter died on a permissions violation that read as "no manager" — even when a manager was up and would have answered `ep.one.manager.ps`. Measured: an admin-scoped user bearer is served on `ep.one`; the same bearer is refused on the freeze.

  **What changes.** Mode is chosen up front from the connection shape, never try-scatter-catch-degrade:

  - **User-auth:** `ep.one` to one manager (in-memory roster, owner-filtered). Multi-manager completeness is not claimed; an unreachable manager fails the command rather than printing a bare empty list.
  - **Static / open:** class scatter unchanged (freeze + per-instance attribution, unreachable labeled).

  `connectOrExit` now refuses a `control-caller-*` instrument request on a user-mode mesh (those profiles are static-only); `resolveControlTarget` translates to the user bearer path explicitly. `deployer` is unchanged (real `userViewAuth` elevation). Docs state the user-mode completeness bound. Gated: `smoke:ps-operator-path` (static + dead-manager honesty) and `smoke:ps-user-mode` (user path + dead-manager non-zero).

  **Known limitation.** This fix's correctness relies on the ep tier boundary asserted at `user-spawn.smoke.ts` B1e (a spawn-scope bearer's `ps` is broker-dropped). That suite is **not** in the `smoke:ci` chain, so the invariant is unprotected by CI. Gating it is out of scope here and is tracked separately.

- 185e721: Renew the `$SYS` credentials without tearing the space down.

  `membership-observer.creds` and `connection-evictor.creds` carry a 30-day expiry and are signed by
  the system-account seed, which is never persisted, so nothing re-signs them in place. The only
  repair the tooling named was "`cotal down` then a fresh `cotal up`", and that did nothing: `up`
  mints the pair only on the branch that _creates_ the trust record, so re-upping a provisioned space
  reused the same expired files and reported success. A long-running mesh therefore lost its
  membership feed and live connection eviction every 30 days with no supported way back.

  `cotal up --rotate-sys` is that way back. It issues a new system account under the same broker
  operator, mints both `$SYS` creds against it, and renders the broker config from the rotated record,
  so the broker it starts is the one that trusts them. The data account, the account signing key,
  every agent credential minted from it and the JetStream store are untouched; what dies is the
  retired system account, on every broker that loads the rotated config. It is refused wherever the
  on-disk material and the broker could end up on different generations: a running mesh; an open mesh,
  whether that comes from `--open` or from `broker.auth: false` in a manifest; `--restore`; an
  unfinished restore or resume attempt on the root, including one a bare `cotal up` would recover,
  since those paths can adopt a live listener and return without booting a broker; and a root hosting
  more than one space, because the system account lives in the shared broker record and the rotation is
  therefore broker-wide. `rotateSystemCreds` is exported from `@cotal-ai/workspace` and carries the
  multi-tenant guard itself rather than at the CLI flag. It is deliberately a workstation operation and
  takes no `SecretStore`: the `$SYS` pair has no store seam to be written through, and because a
  `SecretStore` cannot be enumerated, accepting one would mean a broker-wide guard that reads a local
  filesystem while enforcing nothing for the tenants actually at risk.

  A rotation requires every broker for the root to be stopped, and three checks now say so: this root's
  recorded mesh at the requested address, anything unidentified answering there (which refuses instead
  of relocating to a free port), and the root's own ownership records: a live or unreadable `nats.pid`,
  or any recorded mesh for this root still reachable. Without them a lost registry row, or a
  `nats-server` started by hand against this root's `server.conf`, was enough to bypass the running-mesh
  refusal: `up` found the port busy, picked a free one, rotated, and left the old broker serving the
  retired config while a second one ran against the same JetStream store. These are Cotal's ownership
  records rather than a scan of the process table, and the docs say so: a hand-started broker on a
  different port writes none of them and is the named residual.

  Two consequences the tooling now states rather than leaving to be discovered. The retirement is
  config-load-bound, so a stale broker still running the previous config keeps honouring the old creds
  until it is stopped. And a full backup binds to the trust chain it was taken against, which includes
  the operator JWT and the system account, so every full artifact taken before a rotation refuses to
  restore afterwards: the rotation says so as it happens, and `cotal up --restore` names the drift when
  the data account still matches. The commit is a trust-record write plus two credential writes, so an
  interrupted rotation leaves the record ahead of the creds; that split is detected rather than
  silent. One shared check compares each `$SYS` cred's issuer against the persisted record, and it
  runs on every auth-mesh boot as well as in `cotal doctor auth`, so the state cannot pass unremarked
  by a mesh that simply never runs the doctor. The boot REFUSES rather than warning: a warning becomes an unread log line
  under `--detach`'s success output, and live connection eviction rides the same credential pair, so
  booting would silently downgrade revocation to deny-new for the life of the mesh. The delivery daemon, which never
  loads the signer and so cannot read the record, compares the two creds against each other instead.

  The recovery is covered end-to-end as well as in unit form: a suite drives the packaged binary
  against a real broker, a real delivery daemon and a real manager, on a root whose `$SYS` pair is
  already past its horizon. It asserts the reported symptom (the daemon's membership feed does not
  start, and says which credential and which repair), that `down` + a plain `up` leaves both files
  byte-identical and the doctor red, and that `down` + `up --rotate-sys` clears it in the daemon that
  reported it. The survival claim is checked rather than asserted: an agent credential minted before
  the rotation still connects afterwards, the CHAT stream returns at the same sequence and count, and
  registry state written before the rotation reads back through the CLI after it.

  Diagnosis now names the cause instead of the symptom. An expired observer cred used to surface as a
  bare "Authorization Violation" in the delivery log and, one layer up, as a `membership-rw` adoption
  refused with "membership feed is not running", neither of which mentions a credential. The daemon
  checks the observer's own expiry before connecting and reports it, carries that reason into the
  adoption reply, and the manager warns on every renewal pass from the 75% point onward rather than
  letting the mesh discover the expiry at the horizon. `cotal doctor auth`, `evictPrincipal`,
  `planeConnLiveness` and the two mint errors now print the repair that works. Where the feed is down
  because its bundle is incomplete rather than expired, the daemon now names the missing files and
  distinguishes the two cases: a missing `$SYS` observer is re-minted by a rotation, while a space
  predating broker-sourced membership is missing the rw cred and the account id as well, which a
  rotation does not write, so it is told the truth rather than sent through a stop/start that cannot
  help it.

### Patch Changes

- 91b75e3: Stop the control-target mode peek from exiting on an off-registry target. `--server` with an unregistered `--space` is the raw-open escape hatch and has no registry entry to carry a mode, but the peek resolved through the exiting form and ended the command before `connectOrExit` could serve it.
- d49f505: Sandbox `server-resolution:live`'s fixtures so a stray `.cotal` above the temp base cannot capture them.

  `findCotalRoot` walks to `/` with no boundary, so one `.cotal` anywhere above the temp base captures
  every fixture a suite mints there. This suite is unusually exposed: the whole premise of its `cwd`
  fixture is that it has NO `.cotal` up-tree, so bare resolution falls through to the registry. Under a
  captured base that premise is simply false.

  Measured, both arms, against a deliberately poisoned base: unconverted, the suite resolved against a
  foreign registry and dialled the shared local demo broker instead of its own fixture. Converted, it
  rejects the captured base, mints under a clean one, and passes its 18 checks. The scratch is
  witnessed with `assertScratchHeld` rather than assumed, which is the half that makes it evidence.

  Only this one entry is converted. The other live entries mint raw too, but minting raw is not the
  same as being captured: tested by artifact, two of four write into a captured root and two never
  touch it. A sweep would have "fixed" suites that were never broken, so the rest want the
  poisoned-base arm run per suite first (tracked on #360).

- 14ff831: Stop reading another user's live process as dead.

  Asking the kernel about a process has three answers, not two: it is there, it is gone, or it is
  there but not ours to signal (`EPERM`). A two-state probe folds the third into "gone", and the
  caller then acts on a running process as if it had died.

  The repo already had a tri-state contract that gets this right, documenting itself as "consumed
  everywhere". Two production files imported it. Sixteen other production call sites probed inline,
  and **seven of the fourteen files handled `EPERM` correctly on their own while seven did not**, so
  this was a coin flip repeated fourteen times rather than one broken helper.

  Fixed, with the wrong answer named at each site:

  | site                       | what the old probe did                                                                        |
  | -------------------------- | --------------------------------------------------------------------------------------------- |
  | `manager-proc.managerUp`   | reported no manager, so `ensureManager` starts a second one onto a live one                   |
  | `delivery-proc.deliveryUp` | same, for the delivery daemon: two daemons on one fanout                                      |
  | `auth` `agent-bearer`      | "the user-auth service is not running, restart it with `cotal up`" about a service that is up |
  | `auth` provider            | same misread on the readiness path                                                            |
  | `cli ext`                  | printed "stale pidfile" about a live extension, which is advice to delete it                  |

  Both `up` functions also parsed their pidfile with `Number.isFinite`, which admits fractional and
  out-of-range values `process.kill` throws on. They now use the contract's bounded parser.

  The contract moved from `implementations/cli/src/lib/pid.ts` to `@cotal-ai/workspace`, the widest
  tier that may hold a local-process concept. **"Consumed everywhere" was never reachable and the
  claim hid the gap:** `extensions/*` peer-depend `core` only, and a pid probe is not a wire concept,
  so reaching them would mean leaking a local concern into the standard. The two extension-side
  probes keep their own copies by construction, and the module now says so instead of overclaiming.

  Presence questions require PROOF (`=== "alive"`); only destructive questions preserve on doubt
  (`!== "dead"`, which is why `down.ts` is written that way and is untouched). An earlier revision of
  this change had the presence sites preserving too, and review reproduced what that buys: a permanent,
  silent, retry-proof false-up, where the control plane reports `running: true` three times over
  against an unreachable manager. The demonstrated defect was `EPERM` alone, and widening past it was
  unforced.

  Covered by a new broker-free suite, `smoke:pid-contract`. The errno-to-state mapping is a pure
  exported function tested exhaustively, so there is no fixture to skip: the first revision reached the
  `EPERM` rule only by probing pid 1 and hoping the process was unprivileged, and as root or in a
  container that cell skipped while the suite still printed a passing banner over a deliberately broken
  implementation. The suite also drives the CONVERTED CALLERS through real pidfiles, because the first
  revision tested only the primitive and a reviewer inverted all five call sites without reddening a
  single check.

  `unknown` is REACHABLE on a real kernel, not merely under a test shim. A Linux seccomp
  `SECCOMP_RET_ERRNO` filter, or an LSM policy through `security_task_kill()`, can answer
  `kill(pid, 0)` with an arbitrary errno without executing it, and libuv preserves it. Review proved
  this with a live seccomp BPF filter and no interposition. So both ways of folding the third state
  into a boolean are wrong, and both fail SILENTLY: preserving reports a control plane that is not
  there and no retry clears it, while requiring proof launches a second manager over one that may be
  live.

  `ensureManager` and `ensureDelivery` therefore REFUSE on `unknown`, loudly, naming the pid, naming
  seccomp/LSM as the expected cause inside sandboxes, and saying what to check. `managerLiveness` and
  `deliveryLiveness` expose the state the booleans cannot carry; `managerUp`/`deliveryUp` remain
  `=== "alive"` for display, with a doc note sending any caller that ACTS on the answer to the
  tri-state.

  Honest coverage limit, stated in the suite's own output rather than implied away: no cell here
  exercises `unknown`, because no `parsePid`-accepted input produces one from this process. The refusal
  is verified by a seccomp BPF harness outside the suite.

- a74a768: Sandbox the temp root in the smokes that mint a mesh fixture there, so a `.cotal` left above the temp base (`/tmp/.cotal` on Linux CI runners) can no longer capture the fixture and make a suite grade a live mesh. One shared implementation in `bin/smoke/_scratch.ts`, used by `spawn-from-anywhere`, `down-target`, and both `ps` suites. The dead-manager cells now assert that the manager was found, was alive, and is dead, instead of skipping their own kill when the pid file is missing.
- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [2768f5b]
- Updated dependencies [019afc3]
- Updated dependencies [3539f20]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [14ff831]
- Updated dependencies [11cd652]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0
  - @cotal-ai/workspace@0.17.0

## 0.16.0

### Minor Changes

- 531d37d: Register, list and unregister meshes from the CLI.

  `cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open]` records a mesh this
  machine did not start — one running on another machine, a shared broker, a hosted space — so
  `--space`, `cotal use` and a bare `cotal spawn` can reach it from any directory. The broker is
  probed before anything is written, so a wrong address or credentials that mesh will not accept fail
  at registration instead of at the first spawn; `--force` records without verifying and replaces an existing
  record. `cotal meshes rm <space> …` drops records (never stopping a mesh: a mesh running here is
  refused in favour of `cotal down`) and releases the `current` pointer when it pointed at one.

  Registry records now carry an origin, and an automatic prune only ever deletes records that
  `cotal up` wrote. A record added by hand cannot be reconstructed by this machine, so an unreachable
  broker under one is reported — `offline` in `cotal meshes`, and a preflight failure that names
  `cotal meshes rm` rather than `cotal up` — instead of silently unregistering a mesh that was live
  all along.

- 498055c: Stop paying one network round trip per record, and return the recent messages history claimed to return.

  Several read paths issued one sequential round trip per record, which is invisible against a loopback
  broker and ruinous on any ordinary cross-continent link. Measured against a mesh at 534ms RTT with
  healthy uplinks at both ends, reading the membership feed took 30 to 34 seconds for 89 entries; it
  now takes under a second for 93.

  - `liveKvEntries` is the one sanctioned full-bucket KV read: a single pass whose request count is
    independent of record count, which collapses by greatest revision with tombstones so a deleted key
    cannot resurrect, and which binds its own consumer so that an empty result is PROVEN by the
    bind-time pending count rather than inferred from silence. A pass that is cut short raises rather
    than returning what arrived. That distinction is load-bearing on the ACL path: read this way, a
    dropped link mid-scan would otherwise report a provisioned principal as having no ACL row, and a
    durable join would be refused as "not provisioned" instead of as "could not read". The membership
    feed, the members and channel registries, and the ACL alias enumeration all read through it. No
    change to broker authority: the same ordered push consumer over the same subject.
  - `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
    requested limit, while being documented as recent and rendered everywhere as the latest. They now
    return the newest, read through a bounded window rather than by draining the backlog.
  - `cotal status` started the Claude CLI twice for data one listing contains.

  Two optimisations were attempted and REVERTED during review, and are not part of this change: the
  dashboard's activity feed still fetches a full page per channel (the cheaper version dropped
  genuinely-newer messages, because saturation counts messages rather than recency), and control
  commands still open a probe connection before the real one (skipping it flattened typed auth
  failures and lost the probe's deadline).

  This is the read-path half of the work. The registry-safety half — a failed network probe must not
  delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
  `cotal meshes add`.

### Patch Changes

- Updated dependencies [531d37d]
- Updated dependencies [498055c]
  - @cotal-ai/workspace@0.16.0
  - @cotal-ai/core@0.16.0

## 0.15.0

### Minor Changes

- f89560a: New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer, in Codex's own TUI. A host-mode peer drives a `codex app-server` thread over JSON-RPC: inbound batches wake a real turn, and directed messages steer INTO a live turn mid-flight.

  `cotal spawn --agent codex` opens Codex's own TUI. The app-server runs as a loopback websocket listener guarded by a per-incarnation capability token (0600, inside the agent's private home), and the TUI attaches to the very thread the mesh drives, so mesh turns render as they happen and anything you type is a real user turn on that same thread. With no terminal (piped output, CI, a smoke) the host stays headless with an activity feed instead; `COTAL_CODEX_TUI=1|0` picks the mode explicitly when the tty check would guess wrong. Once Codex owns the terminal the host's own log moves to `host.log` in the agent's private home, and the handoff line names that path so a later failure is findable.

  The shared `cotal_*` tools are served by the host process itself over a bearer-authenticated loopback MCP endpoint, with the token passed to codex by env var name so it never reaches the process table. Because the app-server is the MCP client, the same tools work on a mesh-driven turn and on one typed into the TUI; the connector's own tools are pre-approved so an unattended agent never stalls on an approval prompt nobody is watching, and `mcp_servers.cotal.*` is reserved and refused rather than silently overridden.

  Autonomy defaults suit an agent woken by peer messages when nobody is watching: `approval_policy=never` (never ask before running a command, not refuse), `sandbox_mode=workspace-write`, and `sandbox_workspace_write={network_access=true}`. Network is on because Codex's own workspace-write default has it off, which breaks installing a dependency or pushing a branch with an error that reads like the task is impossible rather than the sandbox refusing; filesystem containment is kept, because a peer's message is a remote input that can make the agent run commands. The network default is applied only where the sandbox is actually `workspace-write`, so tightening the mode does not leave a network grant in the launch. All three are overridable per spawn with `--opt` (including `sandbox_mode=danger-full-access` for no sandbox at all), while an interactive `approval_policy` is refused loud rather than auto-answered on the operator's behalf.

  The guide states the sandbox's guarantee literally: it blocks out-of-workspace local filesystem writes, and does not block reads, exfiltration, or networked side effects. With the network on, a peer-driven turn can read broadly and send what it reads, reach loopback and link-local services, and act through any credential it can read, including irreversibly, via a force-push or an API delete. Containing filesystem writes is not the same as containing damage, and the docs say so rather than implying the residual is disclosure-only. The offline, tighter-mode, and separate-OS-user mitigations are named in both the autonomy section and Limits.

  At-least-once delivery with exact-id acks on turn completion: a failed turn retries with backoff, an interrupt redelivers, and an app-server crash restarts the child in place on the same mesh lifecycle and re-drives the un-acked batch (a crash loop is fatal, never an endless respawn). Presence from the event stream, an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (a resumed codex thread comes up without its configured MCP servers, so the agent would be mute on the mesh) and tool-sharing.

  Also fixes the seed reconciler, which treated a generation match alone as up-to-date: a built-in connector added at an unchanged generation would never seed on an already-installed workstation (`--agent codex` reporting no connector installed). Both fast paths now also require every `SEED_BUILTINS` entry to be present in the ever-seeded set.

  A connector can now declare `launchHint`, the one line a foreground `cotal spawn` prints about what to expect next. That text used to be hard-coded to Claude Code's first-run gate for every agent type, telling operators of other harnesses to press Enter at a prompt that never appears.

  The web dashboard gains Codex branding (the OpenAI mark, from Simple Icons), so a codex agent renders with an icon and a label instead of a blank badge. That map was hand-maintained with nothing tying it to the connector set, so it is now covered by a test: every official connector must have a complete entry, and a new connector cannot ship icon-less with a green suite again.

### Patch Changes

- Updated dependencies [f89560a]
  - @cotal-ai/core@0.15.0
  - @cotal-ai/workspace@0.15.0

## 0.14.11

### Patch Changes

- ca962f7: Fix `cotal setup` failing on every upgrade with `plugin <name>@cotal-mesh is at version <old>,
expected <new> (the update did not take)`. `installOrUpdatePlugin` ran `claude plugin update`
  only inside the install-failed branch, but `claude plugin install` reports "is already
  installed" and exits **zero**, so on an upgrade the update never fired, the Claude plugin cache
  kept the old version, and the verification step then threw. The update is now triggered by what
  `plugin install` reports rather than by an exit status that never comes, which is what closes
  the upgrade path for the `cotal` connector plugin and the `cotal-skills` plugin alike.

  Also correct setup's own Node preflight, which still checked for Node 20 and told the user
  "Cotal needs Node 20 or newer" while `cotal-ai` declares and enforces a Node 22 floor.

  - @cotal-ai/core@0.14.11
  - @cotal-ai/workspace@0.14.11

## 0.14.10

### Patch Changes

- @cotal-ai/core@0.14.10
- @cotal-ai/workspace@0.14.10

## 0.14.9

### Patch Changes

- a4c082a: `cotal down web` now works from any directory. The dashboard starts target-resolved (registry current mesh first) and records its pidfile under the target mesh's root, but a selective `down` only looked under the folder it ran in and reported "Nothing running for web" while the dashboard kept running. A `LocalProcess` can now declare `rootedAt: "target"`; `down` resolves such components through the same mesh-target resolution the start side uses, with a new `cotal down web --space <name>` to name the mesh explicitly. Bare `cotal down` remains a folder-scoped sweep, and folder-rooted components refuse `--space`.
- c88ef4c: `cotal spawn -f` now deploys to a remote manager: when the mesh's serving manager lives in another checkout or on another host, the resolved launch spec rides the `launch` control op inline — the manager validates it with the same untrusted-input contract as the file path and persists it under its own `.cotal/run/` (stale-restart and retained resume read one source either way). The ledger stays with the deploying checkout, so `down -f` works from there too. Also fixes a pre-existing re-apply edge: the transient persona file is now written atomic-replace instead of exclusive-create, so re-launching an agent after a partial deploy failure no longer dies on EEXIST.
- Updated dependencies [a4c082a]
  - @cotal-ai/workspace@0.14.9
  - @cotal-ai/core@0.14.9

## 0.14.8

### Patch Changes

- 84f6200: Per-agent `prompt:` in the mesh manifest — a kickoff message auto-submitted once the session is up, the declarative form of `cotal spawn --prompt`. Submitted on first boot and on stale-restart (hash-covered, so changing it marks a running agent stale); a reclaim of a still-live session does not re-submit. Imperative `--prompt` alongside a manifest launch is still rejected (one source). `topology view` marks agents that carry one.
- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8
  - @cotal-ai/workspace@0.14.8

## 0.14.7

### Patch Changes

- 12ad5e3: Close two attach defects: a capability issued for the wrong agent, and remote attach silently dying after a manager repair.

  **An attach capability could be issued for an incarnation nobody authorized.** `opAttach` resolved the
  agent name, awaited authorization — which on a user mesh performs a ledger read, a real async
  boundary — and then asked for a ticket by NAME. Ticket issuance re-resolved that name and bound
  whichever agent held the slot at that moment. A stop and same-name respawn landing inside the await
  therefore authorized one incarnation and handed out a valid terminal capability for its successor,
  which on a user-auth mesh can belong to a different owner. `url()` now requires the authorized handle
  and refuses when the slot has moved under it, and `opAttach` re-asserts the incarnation immediately
  after the await so the non-pty path shares the invariant. This is the same class as the name-binding
  fix in 0.14.4, one step earlier in the sequence: that closed the window at redemption, this closes it
  at issuance.

  **A manager replacement quietly demoted attach to loopback.** The bind host for the manager's
  attach/console face was passed only on the first `cotal up` and never recorded, so every later launch
  for the same mesh fell back to loopback: a same-root repair, adopting a preserved or restored
  listener, and a `spawn -f` manifest deploy. The broker, the agents, and the mesh all stayed up, so the
  only symptom was `cotal attach` failing to connect from another machine. It is not derivable after
  the fact — a broker dial address is deliberately not treated as a manager bind address — so the
  decision is now recorded on the mesh entry and read back by every manager launch. An explicit
  `--host` still wins, and a mesh that never asked for exposure records nothing and stays loopback-only.

  Also narrows `.cotal/manager.log` to 0600 (new and existing), since the manager's console URL is
  written there and that URL carries a credential reaching every agent's terminal.

- Updated dependencies [12ad5e3]
  - @cotal-ai/workspace@0.14.7
  - @cotal-ai/core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- @cotal-ai/core@0.14.5
- @cotal-ai/workspace@0.14.5

## 0.14.4

### Patch Changes

- eccf48c: Make `cotal attach` reach a manager on another machine, and credential that endpoint properly.

  The manager's attach face bound a hardcoded `127.0.0.1` and advertised that same literal in the URL
  it handed back over the control plane, so a remote operator dialed their own loopback and got
  `ECONNREFUSED`. Attach only ever worked when the manager happened to be on the same box.

  **Where it binds is now an explicit decision.** The endpoint takes a bind address, still loopback by
  default, so a bare `cotal supervise` and an embedded `Manager` keep exactly the machine-local
  endpoint they have always had. `cotal up` passes the address it bound the broker to (via a new
  `supervise --console-host`), which is what makes a remote attach work. The broker's _dial_ address is
  deliberately not reused as the _bind_ address: a manager may supervise a broker on another host and
  cannot bind that address at all, and a failover list's first entry need not be the server actually
  selected. Where the manager can only name loopback — a wildcard bind — the client substitutes the
  broker address its own control connection reached, so `up --host 0.0.0.0` works too instead of
  silently handing back an unreachable URL.

  **The endpoint is now credentialed, in two tiers.** It carries terminal read and write for every
  managed agent, plus the managed roster and the live mesh feed, so once it can leave the machine
  "unauthenticated but loopback-only" stops being a safe position. A mesh caller receives a **ticket**
  bound to the one agent the manager just authorized, single-use and short-lived; this is what makes
  the existing per-agent owner/admin check real, since a manager-wide token would let a caller
  legitimately authorized for its own agent swap the path and take over another owner's terminal. The
  **console token** is the operator's own, reaches every agent because the console drives all of them,
  and is printed solely to the manager's own output. The roster, feed, and PTY stream answer `401`
  without a credential; the static console shell stays open, since it describes no agent.

  Credentials never ride a cookie: cookies are host-scoped rather than port-scoped, so one set here
  would be sent to every other HTTP service on the same host and would collide between two managers on
  one box. The console URL carries its token in the fragment, which a browser never sends to a server,
  and the console page is served `no-store` with `Referrer-Policy: no-referrer`.

  Also fixes an IPv6 regression in the same area: `URL.hostname` returns an IPv6 literal bracketed
  (`[::1]`), which `listen()` treats as a DNS name and fails `ENOTFOUND`. Brackets are stripped for the
  bind and restored for the advertised URL. An address this host does not own now fails with the
  address named and the resolutions spelled out, rather than a bare errno from deep inside startup.

  Covered by a new `smoke:attach-auth` in the CI gate (38 checks), including the cross-agent path-swap
  that the first design allowed.

  - @cotal-ai/core@0.14.4
  - @cotal-ai/workspace@0.14.4

## 0.14.3

### Patch Changes

- fce3199: Report which machine an agent runs on, and fix three defects that only appear once a mesh spans hosts.

  **`meta.host` on the agent card.** A mesh can span machines: a manager on another box launches
  agents into its own host, so "where is this agent actually running" was unanswerable from the
  roster. Each session now publishes its own `os.hostname()` as `meta.host`, overlaid last like
  `meta.connector` so an agent file cannot claim a host it is not on. It is advisory display
  metadata only, never an authorization or routing input, and the dashboard renders it with no
  change (unknown meta keys already display generically). `SPEC.md` records it alongside the other
  reserved `meta` keys.

  **`cotal up --host <addr>` killed the broker it had just started.** The bind address and the
  broker URL were tracked independently, so `--host` bound one address while the readiness probe
  still used the loopback default. The probe found nothing, timed out, and the caller SIGTERM'd a
  broker that had started correctly, which made `--host` alone impossible to use. The two are now
  reconciled: with no explicit `--server`, the URL is derived from the host; a contradicting pair is
  refused with one sentence instead of starting something unreachable; and wildcard binds
  (`0.0.0.0`, `::`) correctly keep a dialable loopback URL rather than advertising the wildcard. The
  manifest path (`broker.host` without `broker.servers`) had the same defect and shares the fix.

  **One slow probe silently unregistered a live mesh.** `pruneStaleMeshes` deleted any registry
  entry that failed a single reachability check whose budget is 1s, which a healthy broker across a
  slow or jittery link misses routinely. Deletion is destructive and, for a mesh this machine did
  not start, unrecoverable, since only `cotal up` writes registry records. A first failure now only
  makes an entry a candidate; it is pruned only if a second, longer probe also fails. A genuinely
  dead mesh still prunes.

  **A timed-out request killed the whole dashboard.** `cotal web` passed an async listener to
  `createServer`, so a rejection inside any route (for example a JetStream call timing out against a
  slow broker) became an unhandled rejection and took the process down on the first slow request.
  The dashboard is a read-only observer: a failing route now returns 500 and the server stays up.

- Updated dependencies [fce3199]
  - @cotal-ai/workspace@0.14.3
  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- 5457b55: Require Node >= 22 and fail fast with a clear message on older Node.

  The bundled `nats-server` broker (`@eplightning/nats-server-*`) declares `engines.node >= 22`, and
  npm silently skips an optional dependency whose engine the running Node doesn't satisfy — so on any
  Node older than 22 the broker binary was never installed, surfacing later as a misleading
  "nats-server not found". Older Node also crashed the CLI outright on a Node-20+ regex in a transitive
  dependency, and only a non-fatal engine warning was emitted rather than a hard stop.

  The executable entry is now a thin Node-version preflight (`bin/cotal.ts`) that checks the running
  Node before any heavy import is parsed and hands off to the real composition root (`bin/run.ts`) only
  when it passes; on Node < 22 it prints an actionable message (upgrade Node; clear the npx cache if a
  stale install is being reused) and exits non-zero. The declared `engines.node` floor is corrected from
  `>=20` to `>=22` to match the broker's real requirement (Node 20/21 satisfied the old floor but
  never got the bundled broker), and the `nats-server` resolution error now names the root cause and
  the fix instead of a generic PATH hint.

  - @cotal-ai/core@0.14.2
  - @cotal-ai/workspace@0.14.2

## 0.14.1

### Patch Changes

- cf6b82f: fix(cli): re-offer the global install on a repeat `npx cotal-ai setup`

  `offerGlobalInstall` only ran on the first-run path (`runFirstRun`). The onboarded marker
  (`~/.cotal/onboarded.json`) is written once, so every later `cotal setup` routed to `runEnsure`,
  which never offered the install. Any machine that had already onboarded — declined or failed the
  install the first time, or onboarded before the offer existed — could re-run `npx cotal-ai setup`
  forever and never get a durable `cotal` on PATH. `runEnsure` now runs the same offer, gated by the
  same `isNpx()` + PATH scan, so it's a no-op for a dev clone or an already-installed `cotal` and only
  fires for the npx-without-`cotal` case it's meant to fix.

  - @cotal-ai/core@0.14.1
  - @cotal-ai/workspace@0.14.1

## 0.14.0

### Minor Changes

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

### Patch Changes

- ffbb43f: fix(cli): accept npm's array-form version output in `cotal update`

  `cotal update`'s "is a newer binary available" check parsed `npm view cotal-ai@latest version --json` as a bare JSON string. Real npm only returns a bare string while the registry holds a single published version; once more than one version exists it wraps the field in a JSON array (`["0.13.2"]`) even for the `@latest` tag. The strict string check then failed with `npm returned an invalid cotal-ai version`, so the whole command errored at the final step on every real install. The parser now accepts both the string and array forms and takes the highest valid semver, and still rejects empty/garbage output loudly.

- 8aee34e: Distribute Cotal's authored Agent Skills (`SKILL.md`), starting with `team-topology`, from one canonical source in the CLI package to every AI coding harness, with real central update and removal.

  - **Claude Code:** a skills-only `cotal-skills` plugin in the existing `cotal-mesh` marketplace, installed at user scope and independent of the mesh connector (it carries no code and no core dependency). Its plugin version is stamped from the running CLI release and `cotal setup` runs `claude plugin update`, so an upgrade actually replaces the cached skill; each plugin dir is rebuilt from an allowlist and swapped in, never merged, so no stale file rides in. It installs on first run and, fail-loud, on repeat runs, so upgraders are not left behind, and the install is verified via `claude plugin list --json` (exact id, scope/project, enabled, no errors, and expected version). `cotal status` gains a "Claude skills" row.
  - **Every other harness** (Codex, Cursor, OpenCode, Gemini CLI, Windsurf/Devin): `cotal setup` reconciles the cross-vendor `~/.agents/skills/` directory at the file level, tracked by a validated manifest under `~/.cotal`. Cotal owns exactly each skill's `SKILL.md`: before overwriting a copy you have edited it copies your version into a fresh `SKILL.md.bak` slot (never overwriting an existing or third-party backup), and on removal deletes only that file (then the dir if it is left empty), never a whole directory, never a user's other files, and never a third-party skill. Every managed write (skill file and ownership manifest) goes through a stage-and-rename with an exclusively-created temp (so a hard-linked or symlinked path is replaced, never written through to an outside inode), and a malformed or corrupt manifest fails loud. `cotal status` reports current/stale/missing/retired for the drop and current/stale/missing/broken for the Claude plugin.
  - The website Agent Skills discovery index is generated from the same canonical files and reconciled (a removed skill stops being served/indexed); a forward bet on the draft RFC, which no shipping harness consumes yet.

  A corrupt or empty skills bundle fails loud rather than silently shipping zero skills.

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/core@0.14.0
  - @cotal-ai/workspace@0.14.0

## 0.13.2

### Patch Changes

- c3afdaa: fix(renewal): prove the broker accepted a re-signed daemon credential before reporting it adopted

  `cotal doctor auth` could report a renewal "adopted" that the broker never accepted (a false green). The daemon's credential-reload path now proves acceptance on a disposable preflight connection before it adopts, and the record + `doctor` verdict only ever claim what was proven:

  - The delivery-admin `reloadCreds` reply narrows to `brokerAccepted` (identity/iat/exp actually accepted) plus a best-effort `residentSwap`, never an unwitnessed "adopted".
  - The passive 75% renewal timer and the explicit reload share one single-flight transaction and both preflight before installing a candidate, so a rejected credential in the store can never strand the live connection.
  - The whole daemon-side transaction is deadline-bounded (under the manager's request bound) with a late-commit fence, so a hung store fails loud instead of a silent "no responder".
  - `cotal doctor auth` now exits non-zero and says so when the last renewal was refused by the broker, instead of letting cred-file health alone stand as healthy.
  - The ephemeral generation fingerprint used to bind the expected generation is redacted at the persistence boundary, so it never lands in `.cotal/renewal.json` or logs.

- 9e3fdd6: cli: make installed extensions discoverable. Bare `cotal ext` now lists the inventory instead of erroring; `cotal ext list` and the `cotal status` Extensions section lead with the install prefix and state it is a cotal-owned store kept separate from npm's global tree (which is why `npm list -g` never shows these); a new `cotal ext root` prints just the path for scripts, and `status` always renders the section with an explicit empty state. Discoverability only: where extensions install and how they upgrade is unchanged.
- 2ed747d: feat(secret-store): migrate the membership feed's rw credential onto the store seam with proven standing renewal

  The broker-sourced graph feed's data-account (rw) credential now moves as a full read/write/delete kind through the `SecretStore` seam, so a hosted composition can renew it end-to-end (KMS/Vault) the way `delivery.creds` already does. Local `cotal up` is byte-for-byte unchanged (the default is the workstation FS store).

  - The feed's rw connection adopts credentials the way the endpoint does: an async source read outside the (synchronous) authenticator, a preflight-proven cache, a 75%-of-lifetime renewal timer, and a single-flight transaction bounded by an absolute deadline. Its authenticator now only ever presents the last **broker-proven** credential, so an incidental reconnect can no longer present an unproven or broker-refused generation and strand the feed.
  - The renewal owner (the manager) and the daemon now share one `SecretStore`: `Manager` takes an optional `secretStore` (defaulting to the workstation FS store) that feeds `remintDaemonCreds` and every per-agent secret kind, and `startMembership` reads the rw credential through the injected store. A hosted composition that hands the manager and the delivery daemon the same store renews both daemon kinds without a restart.
  - `cotal up` writes, and `cotal clean all` deletes, `membership-rw.creds` through the seam (never a raw filesystem write/remove), matching the `delivery.creds` discipline.
  - `credsRenewalDelayMs` (the 75% renew-early convention) is shared from `identity` so the endpoint and the feed compute it identically.

- 9625ec6: Add `cotal update` to reconcile first-party connectors and extensions to one generation, report third-party extensions, and check or opt into a serialized, verified global CLI upgrade.
- 6960658: The web dashboard now ships and versions with the `cotal-ai` binary. Previously `@cotal-ai/web` was fetched separately on its own version line, so upgrading the CLI (`npm i -g cotal-ai@new`) left the dashboard stale, and the documented `cotal ext add @cotal-ai/web` could not cross the 0.x caret to reach the new release, leaving customers on an old dashboard with no clean way forward.

  web is now a bundled first-party extension alongside the connectors: it is carried inside the `cotal-ai` package and the boot reconcile installs and version-refreshes it from that bundled payload at the binary's own version. So `npm i -g cotal-ai@X` brings the dashboard to X automatically and offline on the normal upgrade path, exactly like the connectors (a deliberate operator pin or a rollback is the operator's choice, same as any connector). To make this possible, web is repackaged to be self-contained — its marked/DOMPurify browser builds are copied into its own `dist` and served from there instead of resolving `node_modules` at runtime — so it seeds with no runtime dependencies.

  The bundle path is hardened so the update stays clean and verifiable: the prepack asserts every seeded payload's `name` and `version` match the umbrella (the `fixed` group keeps them lockstep), the reconcile verifies each (re)installed extension is recorded, on disk, and at the generation version before it stamps success (a version-skewed payload fails loud), and web publishes a `vendor-manifest.json` (name/version/license/sha512) of its bundled marked/DOMPurify so the shipped browser libs stay auditable.

- Updated dependencies [c3afdaa]
- Updated dependencies [2ed747d]
- Updated dependencies [9625ec6]
- Updated dependencies [6960658]
  - @cotal-ai/core@0.13.2
  - @cotal-ai/workspace@0.13.2

## 0.13.1

### Patch Changes

- 5fb7b23: Add `cotal -v` / `cotal --version`: print the binary version plus each installed extension's, then exit. `cotal status` gains the same report — the Machine section leads with the `cotal-ai` version, and a new Extensions section lists each installed extension with its pinned version, so version skew across the seeded connectors is visible at a glance.
  - @cotal-ai/core@0.13.1
  - @cotal-ai/workspace@0.13.1

## 0.13.0

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

### Patch Changes

- Updated dependencies [5491661]
  - @cotal-ai/core@0.13.0
  - @cotal-ai/workspace@0.13.0

## 0.12.0

### Minor Changes

- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.

### Patch Changes

- be66729: Add offline full-space and registry-only backup, preservation cuts, authenticated operation-isolated
  restore, conservative checkpoint recreation, same-principal resume, and explicit fallback cleanup.
  Remove the incomplete channel export surface.
- 47d2584: Foreground `cotal spawn` now provisions the full durable footprint (read-ACL row included), so a foreground agent gets the delivery daemon's durable backstop instead of silently running live-only and permanently losing every channel message posted while its connection blips. `--live-only` restores the old behavior explicitly. A foreground exit now also retires the agent's creds and broker footprint, mirroring the manager's despawn.
- Updated dependencies [be66729]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/core@0.12.0
  - @cotal-ai/workspace@0.12.0

## 0.11.6

### Patch Changes

- 7b24953: Rebind extension peer links to the current Cotal host before lazy import, allowing global installs and source worktrees to share one extension prefix. Keep the Hermes launcher self-contained so it does not resolve a mutable host peer after launch.
- Updated dependencies [7b24953]
  - @cotal-ai/workspace@0.11.6
  - @cotal-ai/core@0.11.6

## 0.11.5

### Patch Changes

- 446ccc4: Resolve package-manager bin symlinks before locating the connector seed generation and bundled payloads.
  - @cotal-ai/core@0.11.5
  - @cotal-ai/workspace@0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4
  - @cotal-ai/workspace@0.11.4

## 0.11.3

### Patch Changes

- @cotal-ai/core@0.11.3
- @cotal-ai/workspace@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/core@0.11.2
- @cotal-ai/workspace@0.11.2

## 0.11.1

### Patch Changes

- 5b2863a: feat: `cotal clean` - one configurable cleanup verb (history / store / all)

  `cotal down` deliberately preserves the on-disk JetStream store, so stale broker state (e.g.
  durables minted by an older, incompatible Cotal generation) survived every down/up cycle and made
  a new-generation `cotal spawn` fail with `consumer already exists`. `cotal clean <history|store|all>
--force` is the operator reset:

  - **history**: purge the retained message backlog on the running broker (channels, plus DMs with
    `--dms`) over the least-privilege purger cred; `cotal history clear` stays as a thin alias.
  - **store**: delete the stopped mesh's JetStream store (`.cotal/nats` or `--store-dir`).
  - **all**: store + the space identity (`.cotal/auth`), every locally persisted cred/marker tied to
    it, crash residue a normal `down` would have swept, and this root's registry entries; the next
    `up` mints a fresh identity.

  Hardening that shipped with it: one shared pidfile probe for `down`/`clean`/`status` (pid > 0
  only; EPERM reads as alive), `down` no longer erases the record of a process it cannot stop nor
  presents a failed stop as clean, registry teardown keys on the canonicalized project root
  everywhere (a named open mesh can no longer delete another mesh's entry), and stale-store failures
  plus `cotal status` now name the reset recipe.

- Updated dependencies [5b2863a]
  - @cotal-ai/workspace@0.11.1
  - @cotal-ai/core@0.11.1

## 0.11.0

### Minor Changes

- 9061d0e: feat: per-user authentication (owner+actor identity, IdP login, credential death)

  Add per-user auth as a first-class mesh mode. A mesh brought up with `cotal up --user-auth --idp <url>`
  authenticates humans against an identity provider and issues short-lived, ledger-scoped bearers through an
  auth callout, in place of long-lived static credential files.

  - **owner+actor identity.** An instance's wire identity becomes the two-token principal `(owner, actor)`:
    every subject carries the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id`
    re-key onto the pair. Cross-owner and same-owner cross-actor forge/read isolation is enforced by the
    broker; the connection nkey survives only as the transport credential.
  - **Login and delegation.** Humans sign in with `cotal login --idp <url>` (device-code); operators grant
    access with `cotal actor grant`. Agents are spawned under the signed-in human as managed `(owner, actor)`
    children whose scope is a subset of the spawner's (the delegation envelope rule). Agent identities live in
    a separate managed-actor ledger space, exchanged via their own per-agent secret, so they outlive the
    human's login session.
  - **Credential death.** Every managed credential is now lifetime-bounded, with supervisor and delivery
    standing renewal, `$SYS` rotation-renewal, live connection eviction on revoke, and a `cotal doctor auth`
    repair surface. On a user-auth mesh, static agent creds are retired (the flip): revocation closes the live
    window at the next connect.
  - **Elevated operator surfaces.** `cotal web`, `console`, `history clear`, `channels set/default`, and
    `spawn -f` come online in user mode via server-authored elevated view bearers, minted only by the
    signed-in human exchange and gated on ledger scope (`admin` / `spawn`); `ps` and `status` are
    owner-domain scoped.
  - **Connectors.** Add the `cotal_docs` tool (version-exact Cotal docs the agent reads natively) and an
    opaque `launchOptions` raw passthrough for the Claude Code, OpenCode, and Hermes adapters.

### Patch Changes

- Updated dependencies [9061d0e]
  - @cotal-ai/core@0.11.0
  - @cotal-ai/workspace@0.11.0

## 0.10.1

### Patch Changes

- e3a53e3: Add a connector-agnostic model/variant selector: the `cotal models` command, a `--variant` flag on spawn, and the core `listModels` / `ModelCatalog` + `LaunchOpts.variant` contract. OpenCode discovers its models and variants from the installed CLI; Claude and Hermes reject variants (fail loud) and set `COTAL_MODEL` when a model is given.
- Updated dependencies [e3a53e3]
  - @cotal-ai/core@0.10.1
  - @cotal-ai/workspace@0.10.1

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.

### Patch Changes

- Updated dependencies [6c40280]
  - @cotal-ai/core@0.10.0
  - @cotal-ai/workspace@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [14510c3]
  - @cotal-ai/core@0.9.1
  - @cotal-ai/workspace@0.9.1

## 0.9.0

### Minor Changes

- 1bcc154: feat: manager least-privilege — no allow-all credential — plus session resume

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — the message
  schema is unchanged and `protocolVersion` stays `0.2`; this release is about who the manager is
  allowed to be on the broker, plus a new way to bring an existing session into the mesh.

  **Security — the manager is no longer an all-powerful credential**

  Until now every manager action ran under a single, blanket `manager` credential that could do almost
  anything on the broker — read any DM, tamper with any stream, publish as any agent. That credential
  is **gone**. Manager work now runs under a set of small, purpose-built credentials, each able to do
  only its own job and nothing else:

  - The **always-on supervisor** can serve control requests, hold its lease, and publish presence — but
    it **cannot read anyone's messages, create arbitrary consumers, or delete/purge streams**.
  - **Spawning, teardown, and history-purge** each run on their own short-lived, tightly scoped
    credential that exists only for that operation.
  - The **CLI verbs** (`send`, `spawn`, `channels`, `up`, `join`, `down -f`, …) each connect as the
    least-privileged profile for the job — an operator posts only as itself and can never forge another
    agent.

  The practical effect: a leaked or compromised manager credential can no longer read message bodies or
  meddle with other agents' streams — the blast radius is contained to exactly what that one credential
  was scoped to. Control replies are bounded per caller, `cotal join` now self-provisions its own inbox
  (no more `ConsumerNotFound` on a fresh console), and `cotal down` tears down all of a space's streams
  and buckets rather than a subset.

  **New — resume an existing session into the mesh**

  `cotal spawn --resume <id>` and `cotal start --resume <id>` fork an existing `claude` session — its
  deep context and long transcript — into the mesh, instead of always starting an agent from scratch.
  It **forks, never hijacks**: the meshed agent gets a _new_ session branched off that transcript, and
  the original is left untouched. Connectors that can't support this (`opencode`, `hermes`) are
  **rejected up front, before any provisioning**, with a clear error rather than a half-provisioned
  space.

  **Fixes & UX**

  - **`cotal attach` shows the real screen on (re)attach to a full-screen agent.** Re-attaching, or
    attaching late, now reconstructs and repaints the agent's current screen instead of leaving you on
    a blank or partial one.
  - **Mouse-wheel scrolling works in full-screen agents over `cotal attach`.**
  - **The `pty` runtime fails loud under Bun.** It isn't supported there, so it now says so clearly
    instead of misbehaving silently.
  - **Removed the `face:` viewer that had leaked from the frontier-faces example into shared connector
    code**, so an OpenCode persona with a `face:` field boots normally. Face rendering lives entirely
    in `examples/04-frontier-faces`.

  **Migration — re-`up` spaces created before this release**

  The supervisor now records its lease in a per-space manager bucket that older spaces don't have. A
  space that was brought up on an earlier version must be re-`up`'d (a fresh `cotal up` is fine);
  otherwise the supervisor throws `stream not found` on its first lease write. Nothing on the message
  wire changed, so running agents and clients are otherwise unaffected.

### Patch Changes

- Updated dependencies [1bcc154]
  - @cotal-ai/core@0.9.0
  - @cotal-ai/workspace@0.9.0

## 0.8.3

### Patch Changes

- Updated dependencies [a10ed79]
  - @cotal-ai/core@0.8.3
  - @cotal-ai/workspace@0.8.3

## 0.8.2

### Patch Changes

- @cotal-ai/core@0.8.2
- @cotal-ai/workspace@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [15fb826]
  - @cotal-ai/core@0.8.1
  - @cotal-ai/workspace@0.8.1

## 0.8.0

### Minor Changes

- cce0a6a: feat: mesh manifests, the tmux runtime, and a new `@cotal-ai/workspace` layer

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays `0.2`; this release is all tooling, packaging, and hardening. The new publishable
  `@cotal-ai/workspace` package joins the lockstep group.

  **New**

  - **Mesh manifests — describe and launch a whole topology from one `cotal.yaml` (`kind: Mesh`).**
    The file is organized by channel (each lists `subscribe`/`allowSubscribe`/`allowPublish` —
    Cotal's native verbs, holding agent names); a top `agents:` table resolves each name to a persona
    (bare path / file + overrides / fully inline) and a connector (`agent:`, per-agent or a top-level
    default — no silent default). Under `personaPermissions: include` a persona's own channel grants are
    inherited for channels the manifest doesn't declare.

    - `cotal up -f <cotal.yaml>` brings up a **fresh** mesh — broker + seeded channels + booted agents —
      and owns the whole space (`cotal down` tears it down). A broker already reachable at the
      manifest's address is refused with a redirect to `spawn -f`, never re-seeded as fresh.
    - `cotal spawn -f <cotal.yaml>` deploys a manifest **additively** onto a mesh that's already
      running: brand-new channels are seeded and owned, already-present ones are left untouched
      (`exists-unmanaged`), and exactly what it created is written to a creation-only ledger
      (`.cotal/manifests/<runId>.json`). A re-declared agent whose policy changed is **stale** and
      exits non-zero unless `--allow-stale <names>`; unmanaged actors with access to a declared channel
      are surfaced as a SECURITY warning.
    - `cotal down -f <cotal.yaml>` (or `--run <id>`) tears down **only** what a `spawn -f` run created —
      never foreign actors on the shared mesh. The ledger is treated as untrusted input and validated
      whole before any deletion; an owned agent is stopped only when its recorded name **and** id match
      the live one, cred paths are derived from the auth root and deleted without following symlinks,
      and an owned channel is removed only when no other members remain. Local-only: same checkout/host
      that created the run.
    - `cotal topology view -f <cotal.yaml>` validates a manifest and renders its access graph
      (per-channel and per-agent subscribe/read/post, persona-inherited scopes, warnings) — read-only,
      no broker needed. `--dry-run` previews `up -f`/`spawn -f` and mutates nothing.

    Resolved agents boot via a transient, non-authoritative launch artifact under `.cotal/run/` (no
    generated personas in `.cotal/agents/`), handed to the manager through a new **operator-only**
    `launch` control op that reads the run spec by id, never an arbitrary path.

  - **`@cotal-ai/tmux` — a tmux Runtime and `TerminalLayout` extension.** Each agent spawned via
    `--runtime tmux` gets its own window in a shared per-space tmux session, with P3 `env -i`
    isolation; a `TerminalLayout` provider lets `cotal setup` open and close tmux windows from the
    ambient `$TMUX` session. Self-registers on import (`import "@cotal-ai/tmux"`), exactly like
    `@cotal-ai/cmux`. `cotal setup` now offers a tmux demo when run inside a tmux session.

  - **Web graph — hide offline members by default**, with a toggle to show them. Backed by
    broker-sourced authoritative channel membership.

  **Architecture**

  - **New `@cotal-ai/workspace` package — the machine-local workstation layer, split out of
    `@cotal-ai/core`.** Core is now strictly the wire standard (endpoint, subjects, message types,
    extension contracts) and depends on nothing else in the repo; the `~/.cotal` mesh registry, target
    resolution, preflight, `.cotal/` auth-path I/O, and the `cotal …` command-copy renderer now live in
    `@cotal-ai/workspace`. Dependencies flow one way:
    `examples → implementations → workspace → core ← (peer) extensions`. A `smoke:core-boundary` guard
    (in `pnpm check` and CI) fails the build if core ever imports workspace.

    **Migration (importers only — no runtime/wire change):** `mesh-registry`, `mesh-target`,
    `preflight`, and the auth-path helpers (`authDir`/`findCotalRoot`/`loadSpaceAuth`/`saveSpaceAuth`)
    now import from `@cotal-ai/workspace` instead of `@cotal-ai/core`. Mesh-target failures throw a
    typed `MeshTargetError` (with a `code` and structured `details`); detect it with the exported
    `isWorkspaceTargetError(e)` guard rather than `instanceof`. The `cotal …`-flavored error copy is
    rendered through a single `renderWorkspaceError(...)` over a `target | preflight | reachable`
    union.

  - **`cotal ps` / `start` / `stop` / `attach` now resolve their broker from the mesh registry** — the
    same way `send` / `channels` / `console` / `web` and the manifest verbs already do — instead of
    silently defaulting to `nats://127.0.0.1:4222`. `--space <name>` finds the recorded broker (and
    mints the privileged `manager` cred from that mesh's own recorded root); `--server` stays an
    override and `--creds` a raw off-registry escape hatch. The shared mesh-target preflight is now
    used by both the transient commands and the manager control commands.

  **Fixes & hardening**

  - **Manager forwards the resolved channel ACL to spawned connectors**, so a manifest-spawned agent
    actually subscribes to the channels its persona grants (no missing `COTAL_SUBSCRIBE`).
  - **Never prune a recorded mesh on an explicit `--server` override** — an off-registry target no
    longer evicts the registry entry it didn't come from.
  - **Web graph correctness** — mode chips filter persistent edges (not just animation), hidden nodes
    stay hidden under the visibility filters, and dashboard assets are served with
    `cache-control: no-cache` so the UI doesn't get pinned to a stale build.
  - **`cotal attach` restores terminal modes on detach** — focus-reporting is reset and stdout writes
    are guarded against a dead pipe, so detaching no longer leaves the terminal in a wedged state.
  - **Security hardening** — symlink-safe run directories, launch-policy re-validation at spawn,
    tightened launch-spec validation, and the operator-only manager `launch` op (above).
  - **CI** — the security/protocol smoke suite (`smoke:ci`) and the mesh-resolution / spawn-from-anywhere
    / core-boundary smokes are gated in the `check` workflow.

  **Runtime defaults (carried from the tmux work)**

  The built-in `tmux` manager runtime is gone — `tmux` is resolved from `@cotal-ai/tmux`, exactly like
  `cmux`. The default `auto` mode is deterministic `pty`; tmux and cmux are never auto-selected. Choose
  them explicitly with `--runtime tmux`/`cmux`, which fails loud with a clear
  `"import @cotal-ai/<runtime>"` error if the matching extension isn't imported — no silent fallback to
  pty.

### Patch Changes

- Updated dependencies [cce0a6a]
  - @cotal-ai/core@0.8.0
  - @cotal-ai/workspace@0.8.0

## 0.7.0

### Minor Changes

- a6a0a8d: feat: agent orientation, spawn-from-anywhere, live space graph, model-aware spawning

  A coordinated minor across the workspace (lockstep `fixed` group). No wire break — `protocolVersion`
  stays 0.2.

  **New**

  - **`cotal_orientation`** — a self/context card MCP tool: an agent's identity, the channels it can
    read and post to, its capabilities, available tools, and who's present. Claude Code, OpenCode, and
    Hermes connectors all point new agents at it on boot for the same first-turn orientation.
  - **Spawn from any directory** — `cotal spawn` resolves a running mesh from a registry, so agents can
    be spawned outside the project directory. The registry self-prunes space-mismatched and stale
    `current` entries; its dir is locked to `0700` so space names aren't world-readable.
  - **Model- and harness-aware spawning** — `cotal start --model` overrides the model, the harness CLI
    is preflighted before spawn, and the harness/model knobs are shared across both spawn doors (CLI
    `cotal spawn` and MCP `cotal_spawn`).
  - **Live space graph** — a force-directed graph view of a space in the web UI, backed by
    broker-sourced authoritative channel membership (offline agents drop from the graph immediately).

  **Fixes & hardening**

  - **Manager persona spawn is fail-loud and ACL-correct.** A spawn (`start` op / `cotal_spawn` /
    roster boot) now treats its argument as a persona ref (a filename in `.cotal/agents`), takes the
    mesh identity from the file's `name:` (auto-numbered on collision), fails loud on a missing persona,
    and always provisions read/post ACLs from the loaded persona. Previously a miss silently minted
    default creds (read `general` only, default-deny publish, no capabilities), so a persona spawned by
    display name, a typo, or a renamed file became a live agent with silently-wrong ACLs.
  - **Mesh-connect resolution unified** — `web`/`console`/`join` (and the transient commands) route
    through a shared `resolveMeshTarget` + preflight: the recorded server/mode is honored (open ≠ auth),
    the `--server`+`--space` raw escape works again for open remote meshes, the `channels` subcommand is
    validated, and a silent wrong-mesh fallback is refused rather than connecting to the wrong broker.
  - **`cotal web` no longer holds the account signing seed.** The dashboard used to keep the space
    `SpaceAuth` (which can mint _any_ identity/role) in scope for the whole session, re-minting on every
    channel delete — a compromise of the loopback process could mint anything for the account. It now
    pre-mints one scoped `manager` cred at startup for the lone write path (channel delete) and lets the
    seed fall out of scope, shrinking the blast radius from "mint anything" to "purge channels as one
    manager". Open / `--creds` modes are unaffected (no seed; they use the connection creds).

### Patch Changes

- Updated dependencies [a6a0a8d]
  - @cotal-ai/core@0.7.0

## 0.6.0

### Minor Changes

- ba5e622: feat(delivery): server-side delivery daemon for the Plane-3 durable backstop, + auth-by-default

  Extracts the durable backstop (the offline catch-up tier) out of the manager into a standalone,
  least-privilege, server-side **delivery daemon** (`@cotal-ai/delivery`, the `deliver` command). The
  manager is now lifecycle-only (spawn/despawn/stop/attach/ps); the daemon owns all of Plane-3 — the
  fan-out writer + trusted reader, the durable-membership registry, the runtime durable join/leave/list
  ops (on a new `ctl.delivery` control service), activation catch-up, and a single-flight lease — and
  re-authorizes durable delivery against a durable read-ACL registry. Live channel reads are unchanged
  (native NATS, broker-enforced). No wire break (`protocolVersion` stays 0.2).

  - The daemon is part of the server: `cotal up` starts it by default and it is coupled to the broker
    (it exits if the broker is gone; `cotal down` / `cotal up` shutdown stop it).
  - **The mesh is now JWT-authed by default** — `cotal setup`/`go`/`up` bring up an authed mesh with the
    durable backstop; pass `--open` for the previous frictionless open, live-only mesh.
  - `cotal_channels` reports honest durable-delivery health (membership + lease aware).

  Hardened over multiple review rounds (sender-bound `ctl.delivery` replies, reconnect-safe responder +
  KV handles, ACL-independent leave so revocation closes the §7 boundary, signer-free daemon runtime,
  responder-after-bind readiness, pid-bound cutover marker), each with a guard smoke.

### Patch Changes

- Updated dependencies [ba5e622]
  - @cotal-ai/core@0.6.0

## 0.5.0

### Minor Changes

- 58f2d41: Self-serve channel join + durable backstop (SPEC v0.3 delivery rebuild)

  Agents whose read ACL allows a channel now join/leave its **live** feed themselves over a native NATS core subscription — manager-free, broker-enforced by `sub.allow` (join = subscribe, leave = unsubscribe). A manager-hosted **Plane-3 durable backstop** (a privileged fan-out writer → a trusted reader that re-authorizes every entry against the current read ACL and membership interval → a per-member DELIVER durable the agent acks natively, SPEC §8) ensures a post still reaches a busy or offline agent on its next turn. Channel membership moves to a privileged cursored KV registry (`cotal_members_<space>`), and channels carry explicit `live`/`durable` delivery classes (default `durable`; a space with no manager is live-only).

  The legacy per-instance `chat_<id>` live-tail durable and the mediated filter-move are removed — one clean model with no coexistence code. This is a wire-protocol change (SPEC bumped to v0.3): new and old clients do not interoperate on channel delivery.

### Patch Changes

- Updated dependencies [58f2d41]
  - @cotal-ai/core@0.5.0

## 0.4.0

### Minor Changes

- 878f406: Persona management, friendlier entrypoint, and spawn auto-numbering

  - `cotal personas` management with dynamic shell completion.
  - Bare `cotal` now prints help; `cotal setup` is an explicit command.
  - `cotal spawn` auto-numbers names against the live mesh so they don't collide.
  - The demo operator persona is granted the `spawn` capability.

### Patch Changes

- Updated dependencies [878f406]
  - @cotal-ai/core@0.4.0

## 0.3.2

### Patch Changes

- @cotal-ai/core@0.3.2

## 0.3.1

### Patch Changes

- @cotal-ai/core@0.3.1

## 0.3.0

### Minor Changes

- df8e64c: Add `cotal-ai` — a guided, two-tier setup. The composition root (`bin/`) ships as the
  publishable `cotal-ai` package, so `npm i -g cotal-ai` / `npx cotal-ai <cmd>` works (bare
  `cotal` runs `setup`). The **first run** is a narrated, branded flow (`@clack/prompts` UI,
  wordmark splash, a live pane that streams the mesh booting) that checks prerequisites, locates
  the NATS server (bundled platform binary via `@eplightning/nats-server-*`, or one already on
  PATH), then a **connector picker** (Claude / OpenCode — only Claude installs a plugin; OpenCode
  auto-wires at spawn), and writes two default Cotal experts you can chat with — **david — the
  engineer** (how it works) and **sven — the guide** (what to build) — plus **me**, the session
  you drive. The finale is cmux-aware: inside cmux it opens a manager tab that pre-spawns david/sven
  into their own tabs alongside a console + driving session, otherwise a background manager
  pre-spawns them and the terminal is handed to your session. **Later runs** are a compact
  ensure+status card; `cotal setup --full` forces the full flow, and `cotal setup --yes` runs it
  non-interactively (agents/CI) — installs the plugin, writes the experts, starts the web, and exits
  non-zero with the log path on failure. Each failed interactive step offers a Claude handoff
  (skippable with `COTAL_SKIP_ASSIST=1`) that carries the failure context and resumes setup on
  `/exit`.

  Supporting changes across the stack:

  - **core** — `Connector.pluginRoot` (find a connector's installable plugin assets without
    importing the extension), `LaunchOpts.prompt` (an auto-submitted first message), a `TerminalLayout`
    extension contract (a host-side, not-wire contract: open/close editor tabs from a backend-agnostic
    `Tab` — panes as argv + an optional split — resolved by name from the registry), and `findCotalRoot`
    (walk up to `.cotal/`, so `cotal` runs from any subdirectory).
  - **connector-core** — `cotal_purge`, an agent-driven request that has the manager clear the
    space's retained chat backlog (the privileged `STREAM.PURGE` regular agents are denied).
  - **manager** — pre-spawn teammates at startup (`cotal cmux --spawn a,b`, staggered on presence),
    the `purge` control op (native JetStream purge), and a WS attach endpoint.
  - **cmux** — a self-registering `TerminalLayout` provider (plus `listWorkspaces`/`workspaceRefs` on
    the driver) that translates the agnostic `Tab` into cmux's native layout, so `cotal setup`
    opens/closes cmux tabs through the registry without depending on the package or building any
    cmux-shaped layout itself.
  - **connector-claude-code** — MCP isolation for spawned sessions (`--strict-mcp-config` +
    `--mcp-config`, channel ref `server:cotal`), `prompt` passthrough, and the plugin manifest files
    shipped in the published package.

  Adds `cotal up --detach` + `cotal down` for a background mesh. `cotal up` now pre-creates the
  space's JetStream streams + KV buckets for **both** modes (open connects without creds), so
  anything that touches a stream before an endpoint has joined — `cotal spawn`'s DM-inbox
  provisioning, `cotal_purge`, `history clear` — works on a fresh open mesh instead of failing with
  StreamNotFound. When run via `npx` without a global
  `cotal`, setup offers to `npm i -g cotal-ai` (default yes; non-interactive takes the default),
  best-effort — and the status-card hints render the right prefix (`cotal` / `npx cotal-ai` /
  `pnpm cotal`) for how you ran it.

### Patch Changes

- Updated dependencies [df8e64c]
  - @cotal-ai/core@0.3.0

## 0.2.0

### Minor Changes

- 73b030f: Add the `cotal_feedback` sender: a connector tool (always exposed) and a `cotal feedback "<summary>"` CLI mode. With a `COTAL_FEEDBACK_KEY` feedback routes to the keyed broker intake as before; without one it goes to the public intake at `https://cotal.ai/v1/feedback`, which requires a contact email (`COTAL_FEEDBACK_EMAIL` → git config → ask). `COTAL_FEEDBACK_URL` overrides either URL for self-hosted intakes.
- 739649a: Spaces model, operator console, cmux onboarding, personas, and faces (PRs #15–#20).

  - **cli** — a lazygit-style Ink `console` over a shared `MeshView`, plus `setup`/`supervise`/`cmux`/`demo` onboarding.
  - **manager** — registry-resolved runtimes (the manager no longer depends on cmux), graceful stop, and `definePersona`.
  - **cmux** — a self-registering `cmux` `RuntimeProvider` with real teardown.
  - **connector-core** — `cotal_persona` and `cotal_despawn` tools.
  - **connector-opencode** — an optional animated face viewer (avatar id read from the agent file's `meta.face`).
  - **core** — space discovery (`listSpaces`/`deleteSpace`), a pluggable `Runtime` extension contract, `DEFAULT_SPACE`, `saveAgentFile`, and a generic `meta` passthrough bag (kept a patch to avoid force-majoring the connectors that peer-depend on core).

### Patch Changes

- Updated dependencies [b3a790e]
- Updated dependencies [739649a]
  - @cotal-ai/core@0.1.3

## 0.1.3

### Patch Changes

- 246c9b9: Add the `cotal_feedback` beta egress: a `COTAL_FEEDBACK_KEY` config plus `feedbackLine()` guidance folded into the Claude/Codex connector instructions, and a `cotal feedback` authenticated intake server (tester keys, JSONL source of truth, republish to an internal `#feedback` channel). Note: the agent-side `cotal_feedback` tool registration is still pending.

## 0.1.2

### Patch Changes

- 5f9e171: Publish all packages: add repository field for OIDC provenance, plus in-flight changes (cmux runtime exec-via-env fix, manager runtime selector, .gitignore product/, etc.).
- Updated dependencies [5f9e171]
  - @cotal-ai/core@0.1.2

## 0.1.1

### Patch Changes

- 18c271f: Publish all packages: configure GitHub Actions changesets workflow with npm OIDC trusted publishing.
- Updated dependencies [18c271f]
  - @cotal-ai/core@0.1.1
