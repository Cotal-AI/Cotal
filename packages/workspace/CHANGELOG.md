# @cotal-ai/workspace

## 0.132.6

### Patch Changes

- @cotal-ai/core@0.132.6

## 0.132.5

### Patch Changes

- @cotal-ai/core@0.132.5

## 0.132.4

### Patch Changes

- c0e9b6f: Let `cotal ext seed --reset` and `--repair` finish when the extensions manifest records a package whose directory is gone, such as one npm pruned as extraneous. `ext add`, `ext remove` and each seed now warn with the package, its path, the command that reinstalls it and `cotal ext remove <package>`, and keep its manifest entry. For a third-party package that command is `cotal ext add <original-spec>` with the placeholder left in, so the warning does not print a recorded spec that may be a URL carrying a credential. They no longer fail on it. A package directory without a readable `package.json`, a dangling package link and a corrupt `package.json` still fail. A seed that failed this way in an earlier release is finished by `cotal ext seed --repair`, after which `cotal ext remove` drops the entry.
- @cotal-ai/core@0.132.4

## 0.132.3

### Patch Changes

- Updated dependencies [35eb67a]
  - @cotal-ai/core@0.132.3

## 0.132.2

### Patch Changes

- 6e0f8d1: Share the IdP URL policy between manifest preflight and auth login while preserving their diagnostics and normalization.
- Updated dependencies [ebabb1e]
  - @cotal-ai/core@0.132.2

## 0.132.1

### Patch Changes

- @cotal-ai/core@0.132.1

## 0.132.0

### Minor Changes

- 5b197c0: Remove the deprecated `removeIdentityPin` export. This is a breaking API change: consumers must use `removePidPair(pidfilePath, recorded)` after proving the recorded process is gone, passing the original trimmed record rather than a fresh read. The supported helper locks the record and preserves a different successor record. See `docs/UPGRADING.md` for migration guidance; no on-disk state migration is needed.

### Patch Changes

- 7613605: Share comma-list parsing across spawn, mint and persona commands. Preserve absent flags, explicit empty overrides and each command's validation rules.
- 2f0e7c8: Share dashboard bound-address formatting between the web service and CLI status, keeping IPv6 brackets, readiness URLs and the branded default unchanged.
- @cotal-ai/core@0.132.0

## 0.131.6

### Patch Changes

- @cotal-ai/core@0.131.6

## 0.131.5

### Patch Changes

- Updated dependencies [e78de30]
  - @cotal-ai/core@0.131.5

## 0.131.4

### Patch Changes

- @cotal-ai/core@0.131.4

## 0.131.3

### Patch Changes

- @cotal-ai/core@0.131.3

## 0.131.2

### Patch Changes

- @cotal-ai/core@0.131.2

## 0.131.1

### Patch Changes

- @cotal-ai/core@0.131.1

## 0.131.0

### Minor Changes

- 0e65b6f: `ProcessRecord` carries only the fields its state has. A missing or empty record is `absent` and carries nothing. A record that is not a pid is `unattributable` and carries that content. `dead` and `unknown` carry the pid. `alive` and `foreign` carry the pid and, when the command line was read, the command. A caller that reads `pid` on an absent or unattributable record, or `content` on any other state, fails to compile. `readProcessRecord` already returned these shapes, and its results are unchanged. The manager and delivery refusals name the same pid they named before.

### Patch Changes

- daff420: Inspect user-auth state-directory and provider-pin entries without following symlinks at those entries. Regular pins still count. The directory/pin entry checks treat ENOENT as absence and propagate other inspection errors; this does not change ancestor-path or auth-directory enumeration behavior.
- Updated dependencies [f7c2c28]
  - @cotal-ai/core@0.131.0

## 0.130.2

### Patch Changes

- @cotal-ai/core@0.130.2

## 0.130.1

### Patch Changes

- @cotal-ai/core@0.130.1

## 0.130.0

### Patch Changes

- Updated dependencies [025d175]
- Updated dependencies [27250e3]
  - @cotal-ai/core@0.130.0

## 0.129.9

### Patch Changes

- b94f83a: Say that a project's trust folder must be one this account can read and enter. A `.cotal/auth` that
  lists its files but cannot be entered, such as one at mode 0600, is refused with
  `DEPENDENCY_UNAVAILABLE`, and its next step said only to make it a folder this account can read,
  which a folder at 0600 already is. The next step now says to make it a folder this account can read
  and enter, or to name a space with `--space <name>`. The error code, the folder named, and every
  other next step are unchanged.
- Updated dependencies [1a59b0a]
  - @cotal-ai/core@0.129.9

## 0.129.8

### Patch Changes

- 43b7cb9: Report a project's unusable trust folder truthfully. A readable account record in a project folder's
  `.cotal/auth` that will not load, such as an `auth.json` that is not JSON, made a command that would
  target that folder refuse with `TARGET_AMBIGUOUS` and the empty message `multiple meshes running: `,
  with no mesh running. It now refuses with `DEPENDENCY_UNAVAILABLE`, names each such record by path,
  and says to repair or remove it or to name a space with `--space <name>`. This includes the
  `--server` path. A `.cotal/auth` that lists its files but cannot be searched, such as one at mode
  0600, refused the same empty way and is now refused as a folder this account cannot read. When this
  account cannot enter a folder on the way to `.cotal/auth`, such as the project's `.cotal`, the next
  step now names that folder instead of saying to make `.cotal/auth` readable. Several valid account records, explicit `--space`, a selected space, and missing or
  readable projects are unchanged, and no record or mode is changed.
- @cotal-ai/core@0.129.8

## 0.129.7

### Patch Changes

- 853005f: Stop reporting an unreadable project folder as several running meshes. When this account cannot read a
  project folder's `.cotal/auth`, for example because it cannot enter the folder's `.cotal`, a command
  that would target that folder used to refuse with `TARGET_AMBIGUOUS` and the empty message
  `multiple meshes running: `. It now refuses with `DEPENDENCY_UNAVAILABLE` and names the folder and the
  read error, with `--space <name>` as the next step. This includes the `--server` path. The account
  inventory now treats only a missing auth folder as empty; any other read failure propagates. An
  unreadable `.cotal/auth` no longer renders as `space "undefined"`. Explicit `--space`, a selected
  space, and readable or absent projects are unchanged.
- @cotal-ai/core@0.129.7

## 0.129.6

### Patch Changes

- @cotal-ai/core@0.129.6

## 0.129.5

### Patch Changes

- @cotal-ai/core@0.129.5

## 0.129.4

### Patch Changes

- @cotal-ai/core@0.129.4

## 0.129.3

### Patch Changes

- Updated dependencies [c6ddccc]
- Updated dependencies [565f465]
  - @cotal-ai/core@0.129.3

## 0.129.2

### Patch Changes

- @cotal-ai/core@0.129.2

## 0.129.1

### Patch Changes

- @cotal-ai/core@0.129.1

## 0.129.0

### Patch Changes

- de421cd: `cotal doctor auth --space <space>` for a space that was prepared and never started now says to start it with `cotal up` first, instead of telling the user to run the same command in the folder they are already in. From another folder, that step names the space's root with `--root`, quoted for a shell. The refusal and its exit code are unchanged.
- @cotal-ai/core@0.129.0

## 0.128.7

### Patch Changes

- @cotal-ai/core@0.128.7

## 0.128.6

### Patch Changes

- @cotal-ai/core@0.128.6

## 0.128.5

### Patch Changes

- Updated dependencies [1c86343]
  - @cotal-ai/core@0.128.5

## 0.128.4

### Patch Changes

- Updated dependencies [4bfbede]
  - @cotal-ai/core@0.128.4

## 0.128.3

### Patch Changes

- 76fcf89: Bound concurrent multi-space lane startup to four opens, preserving connection budgets and reading the current manifest before each batch. Report queued lanes separately from retries and overdue opens.
- @cotal-ai/core@0.128.3

## 0.128.2

### Patch Changes

- @cotal-ai/core@0.128.2

## 0.128.1

### Patch Changes

- Updated dependencies [20a5c96]
- Updated dependencies [985519f]
  - @cotal-ai/core@0.128.1

## 0.128.0

### Minor Changes

- 1f8bfe5: A restore made by an earlier release no longer has its cleanup delete another account's data without
  consent. Such a restore recorded no other accounts, so its cleanup named none and deleted the store it
  set aside, an open mesh's account included, with no `--discard-history`. `status`, the
  `backup cleanup-fallback` preview and the cleanup now read that store while it is still the recorded
  one and name the accounts the restore's auth mode rules out: every account but `$G` after an open
  restore, and `$G` after a static or user one. The preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`,
  and `backup cleanup-fallback` and `clean restore-fallback` refuse and delete nothing unless
  `--discard-history` is given. Which data account a static or user restore brought back is not
  recorded, so another data account in that store is still not named.
  
  The exported restore-summary helpers now require the record's `mode`. Library callers that passed
  only a partial record must pass the validated maintenance journal, including its mode. This is a
  breaking TypeScript API change for those callers.

### Patch Changes

- @cotal-ai/core@0.128.0

## 0.127.5

### Patch Changes

- @cotal-ai/core@0.127.5

## 0.127.4

### Patch Changes

- 9dc9bc4: A restore no longer leaves another account's data in the store it sets aside without saying so. When
  open and static meshes ran in one folder, their store holds both accounts, and a backup holds one, so
  a restore leaves the other account's streams only in the store it moves aside. The restore now
  journals those accounts. Its receipt names that store in `previousStore` and warns with
  `OTHER_ACCOUNTS_NOT_RESTORED`, or names the accounts in `otherAccounts` on the left-out warning it
  already gives. `status` and every next step that names the cleanup include `--discard-history`. The
  `backup cleanup-fallback` preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE` and names the accounts,
  and `backup cleanup-fallback` and `clean restore-fallback` refuse and delete nothing unless
  `--discard-history` is given. A restore made by an earlier release recorded no other accounts, so its
  cleanup does not name them.
- @cotal-ai/core@0.127.4

## 0.127.3

### Patch Changes

- 5ad71cb: Remove the 64 MiB reservation from each space's membership store, bound values per agent, reconcile legacy stores, and drop the CLI file-store floor.
- Updated dependencies [5ad71cb]
  - @cotal-ai/core@0.127.3

## 0.127.2

### Patch Changes

- @cotal-ai/core@0.127.2

## 0.127.1

### Patch Changes

- Updated dependencies [beade82]
  - @cotal-ai/core@0.127.1

## 0.127.0

### Patch Changes

- Updated dependencies [53fbd95]
  - @cotal-ai/core@0.127.0

## 0.126.3

### Patch Changes

- @cotal-ai/core@0.126.3

## 0.126.2

### Patch Changes

- 566b08f: `cotal status` run in a folder whose stack is blocked by an unconfirmed stop, while another space is selected, no longer opens with a note that says to run `cotal status` there. It shows the block under `This folder's space` with the `--abandon-stop` step first in Next, and its `--json` no longer carries that note as a `FOLDER_SPACE_NOT_RUNNING` warning. Other commands run there still head with the note, which names `cotal status`.
- @cotal-ai/core@0.126.2

## 0.126.1

### Patch Changes

- @cotal-ai/core@0.126.1

## 0.126.0

### Minor Changes

- 6481f8b: Expose each connector's event-plane support as a required typed Manager status fact, including declared inventory rows before import.

### Patch Changes

- @cotal-ai/core@0.126.0

## 0.125.0

### Patch Changes

- Updated dependencies [b2413e2]
  - @cotal-ai/core@0.125.0

## 0.124.3

### Patch Changes

- @cotal-ai/core@0.124.3

## 0.124.2

### Patch Changes

- 05eba85: A stack left blocked by an unconfirmed stop is now named the same way wherever it is reported. A `cotal down` interrupted after the member it signalled exited says that `up` and `down` refuse until `cotal down --abandon-stop <request-id> --yes`, and no longer offers `cotal down --yes`, which refuses there. `cotal status` in that folder while another space is selected shows the block under `This folder's space` with the `--abandon-stop` step first in Next. The note under the heading no longer says to restart a stack whose last `up` or `down` has no recorded outcome with `cotal up`, and names `cotal status` instead. With that space selected, `status` no longer ends with `run cotal up there to restart`.
- @cotal-ai/core@0.124.2

## 0.124.1

### Patch Changes

- @cotal-ai/core@0.124.1

## 0.124.0

### Patch Changes

- @cotal-ai/core@0.124.0

## 0.123.0

### Patch Changes

- @cotal-ai/core@0.123.0

## 0.122.0

### Patch Changes

- Updated dependencies [b318ddd]
  - @cotal-ai/core@0.122.0

## 0.121.7

### Patch Changes

- Updated dependencies [05ecb0d]
- Updated dependencies [912de5d]
  - @cotal-ai/core@0.121.7

## 0.121.6

### Patch Changes

- @cotal-ai/core@0.121.6

## 0.121.5

### Patch Changes

- @cotal-ai/core@0.121.5

## 0.121.4

### Patch Changes

- 672725a: Allow the first setup of a signed-in catalog space to bind its project root while retaining provider-owned credentials under the catalog custody root. Catalog refresh preserves the binding, existing client credential contexts keep working, and later setup refuses another project.
- @cotal-ai/core@0.121.4

## 0.121.3

### Patch Changes

- a90d7ba: Take the broker preset's `--log-file` as `cotal up --log-file` takes it: help shows `<path>`, `add` refuses an empty value or one with control characters and saves a relative path made absolute against the folder it runs in, the file need not exist yet, and its description no longer says only `cotal up` prepares it. A preset add's missing-option refusal and bare `service` now also name `--server <url>` when the space has no registered broker, so the printed line works as given. A schema or path refusal on a preset add names the flag typed, such as `--config`, instead of the adapter's option key, and a schema refusal gives the preset's `--help` as its Next. `service show` and `service remove` now resolve a preset name to the space's one service built on that preset, as the other service verbs do.
- d189272: Rewrite the pid-attribution doc comments in `@cotal-ai/workspace` (`pid.ts` and `liveness.ts`) and `@cotal-ai/cli` (`down.ts`) to state the contract rules without first-person revision and review history.
- Updated dependencies [fe38cbd]
- Updated dependencies [479895c]
- Updated dependencies [baf9576]
- Updated dependencies [6990d29]
- Updated dependencies [a77ac87]
  - @cotal-ai/core@0.121.3

## 0.121.2

### Patch Changes

- d98674a: Keep the signed sender principal stable across one-shot sends from the same OS login and host on a static-auth mesh. Each send retains a fresh, short-lived credential with the existing operator permissions. Explicit credentials and signed-in user identities are unchanged.
- Updated dependencies [af4b631]
- Updated dependencies [3d07896]
- Updated dependencies [1446ee9]
- Updated dependencies [f450bfe]
- Updated dependencies [ee93749]
  - @cotal-ai/core@0.121.2

## 0.121.1

### Patch Changes

- 44ff795: A report's section title wider than the terminal now wraps at its words, and each of its lines keeps the title's style. At 40 or 60 columns `cotal docs --search manager` drew hit titles of up to 77 characters, such as `Upgrading a running deployment › Starting the manager by name after 0.105.0`, on one line past the terminal's edge. A title that fits is drawn as before.
- @cotal-ai/core@0.121.1

## 0.121.0

### Minor Changes

- 5d01ea1: Add native nats-server file logging and rotation settings, persist them across controller stack restarts, and keep broker log and startup diagnostics files private.

### Patch Changes

- Updated dependencies [5d01ea1]
  - @cotal-ai/core@0.121.0

## 0.120.2

### Patch Changes

- @cotal-ai/core@0.120.2

## 0.120.1

### Patch Changes

- @cotal-ai/core@0.120.1

## 0.120.0

### Patch Changes

- @cotal-ai/core@0.120.0

## 0.119.5

### Patch Changes

- Updated dependencies [8f7d6dd]
  - @cotal-ai/core@0.119.5

## 0.119.4

### Patch Changes

- ed5c23f: Anything a line writes in backticks now wraps as one word on a terminal, whatever it starts with. At 80 columns the Next of `cotal daemon install --dry-run`, where no user manager answers, broke `` `systemctl --user show-environment` `` after `--user`; only a span that started with `cotal`, `pnpm`, `npx` or `cd` was kept whole, and only after other words. A span wider than the line keeps a line of its own, as a command does. A line that starts with a command outside backticks, such as a usage line, still wraps at its spaces.
- Updated dependencies [ed5c23f]
  - @cotal-ai/core@0.119.4

## 0.119.3

### Patch Changes

- Updated dependencies [8866e1e]
  - @cotal-ai/core@0.119.3

## 0.119.2

### Patch Changes

- 4c61283: A manager that fails while it starts now ends its line in a next step the operator can take, and the refusal that quotes the line keeps that step.
  
  The service controller quoted the last line a failed service logged cut at 400 characters, so the line of a manager that did not trust a local CA, over 500 characters long, lost its `; next:` part. The quote now holds a line up to 1000 characters whole, and a longer line keeps its start and its last `; next:` step, with its length where the middle was cut. When the error a manager's startup fails on ends in a certificate this machine does not trust, such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, the line keeps Node's message as the cause and its next step is to set `NODE_EXTRA_CA_CERTS` for the command that starts the manager. A seat-cap record that cannot be read names its path, and the line gives one next step, to remove or repair that record. The generic step the startup failure's message repeated is gone. Under `--foreground` on a terminal, the manager's line wraps at the terminal's width as the CLI's own lines do; in its log it stays on one line.
- @cotal-ai/core@0.119.2

## 0.119.1

### Patch Changes

- 7c52767: A stopped space's last operation now names its command in backticks, as in "its last operation, `cotal down`, completed", so `status`, `use`, `space` and `space show` no longer split it after `cotal`. With a 36-character space name, `status` at 80 columns broke inside `cotal down`, and `use` broke the same way at 40 columns. `--json` carries the same text, so `lastOperation` and the selected space's `message` now hold the backticks. The `--on` help of `run` and its `start`, `show`, `answer` and `amend` verbs, and the refusal for a malformed `--on`, now write `` `cotal ps` ``, and the `--launch` help of `supervise` writes `` `cotal up -f` `` and `` `spawn -f` ``.
- f57bc1f: Redirecting stderr no longer leaves ANSI color in the file. Color under `auto` was decided by stdout alone, so `cotal spawn 2>err.txt` on a terminal wrote `Mesh:` headings and `✗` refusals to `err.txt` with their color codes, and `cotal spawn >out.txt` left the refusal on the terminal uncolored. Each stream is now colored only when it is a terminal, so a pipe or redirect of either stream is plain text. Reports, help, warnings and failure reports take their color from the stream they are written to, as do most error lines. Some other lines a command writes directly, such as progress notes, are colored only when stdout and stderr are both terminals. `always`, `never`, `--no-color`, `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb` keep their meaning for both streams.
- 3431be6: `cotal up --max-payload <bytes>` sets the broker's own message size limit, a positive integer up to 67108864. `up` renders it as `max_payload: <bytes>` in the broker config and records it in `.cotal/broker-policy.json`, which `readBrokerPolicy` reads back, so a later `cotal up` on the root renders it again without the flag, after `cotal down` or a preserved resume included. A running broker refuses a different value, and `--open`, `-f` and `--restore` refuse the flag. Service endpoint caller grants need at least 2098176 bytes, so a smaller value beside `--service-endpoints` refuses before anything starts. `SERVICE_CALLER_PAYLOAD_FLOOR` and `SERVICE_CALLER_PAYLOAD_OVERHEAD` now come from `@cotal-ai/core`, so the flag's validation and the auth host's assertion read one number. Before, `serverConfig` took a `maxPayload` that no `up` ever passed and no record kept, so a limit written into `server.conf` by hand was lost the next time `up` wrote the file.
  
  Caller issuance now survives a broker configuration reload. A reload keeps the same incarnation serving and moves VARZ `config_digest`, and issuance was bound to the digest the bootstrap observed, so every reload refused every later caller issuance until the auth plane was reopened. On a multi-tenant broker that is every tenant sign-up. The verifier now treats a moved digest as a trigger to re-measure: when the fresh observation proves the same broker incarnation and auth store, and proves the standalone topology, the payload floor, the control line, the system account and an uncapped auth stream again, it re-asserts the payload record under the held plane claim by CAS on the exact prior row and continues. A reload that breaks any of those still refuses, a `max_payload` below the floor included, a restart is a new incarnation and still refuses, and a withdrawn record is never overwritten.
- Updated dependencies [9f32677]
- Updated dependencies [3431be6]
  - @cotal-ai/core@0.119.1

## 0.119.0

### Patch Changes

- ba731fe: Keep a command wider than the terminal line on one line, so a copied line is the whole command.
  
  On an 80-column terminal the exec-endpoint `next:` of `cotal service` broke before `--handler <file>`, and the remedy of `cotal service add <name> --preset exec-endpoint` broke before its last `<file>`, both in the refusal line and in the `--plain` report's Next. Copying the first line gave a command without its last option, and copying both ran two commands. A command cell now overflows the line as one line, and so does a remedy that is one whole command: `CommandFailure` takes `remedyIsCommand`, which every terminal remedy path honours. A remedy that starts with a command and goes on as prose still wraps at its spaces. `--json` output is unchanged.
- @cotal-ai/core@0.119.0

## 0.118.3

### Patch Changes

- @cotal-ai/core@0.118.3

## 0.118.2

### Patch Changes

- @cotal-ai/core@0.118.2

## 0.118.1

### Patch Changes

- @cotal-ai/core@0.118.1

## 0.118.0

### Patch Changes

- @cotal-ai/core@0.118.0

## 0.117.1

### Patch Changes

- @cotal-ai/core@0.117.1

## 0.117.0

### Patch Changes

- Updated dependencies [c93dded]
  - @cotal-ai/core@0.117.0

## 0.116.5

### Patch Changes

- e9edf03: On a terminal, the source a `→ using`, `→ wrote` or `→ removed` line names now wraps as one word, however many spaces it holds. A path such as `<root>/proj/with space/.cotal/agents/default.md` that does not fit after the label goes whole on the line under it, wider than the line if it must be. It used to be split at its spaces, so no line held the whole path to copy. The label still wraps at its spaces, and written to a pipe or a file the line is unchanged.
- @cotal-ai/core@0.116.5

## 0.116.4

### Patch Changes

- afcfc54: A remedy, Next line, hint or message that names a `cotal` command after other words now writes it in backticks, so a terminal wraps the command as one word and never splits it across lines. At 80 columns the timed-out `invoke` Next used to break inside `cotal invoke manager ps --timeout 10000`, the `TARGET_UNAVAILABLE` Next inside `cotal service --space <space>`, and the note about a folder's stopped space inside its `cotal up`. At 60 columns the `up` and `spawn` option help broke inside `cotal down` and `cotal team deploy <file>`. `--json` carries the same text, with the backticks; no key changed. A command that holds a shell-quoted path or value is named between double backticks when it holds a backtick itself.
- @cotal-ai/core@0.116.4

## 0.116.3

### Patch Changes

- ed72118: A multi-space host no longer acknowledges a manifest that drops a space while that space's open is still running past the pass deadline. Since the bounded lane opens of 0.115.2 such an open sat outside the lane map, so `<manifest>.applied` named the manifest at once; the open then settled, the host took the lane, and only the next pass closed it, so a writer that fences on the acknowledgment before tearing a space down could see a lane come up after it was told there was none. The host now holds the record until that open has settled and any lane it produced is closed, the same way it already holds it for a lane whose close did not confirm, and names the space it is holding for. Spaces the manifest still names are unaffected, and the other spaces keep opening and serving while one removal is held. A late open that fails releases the hold at once instead of waiting out the reopen interval.
- Updated dependencies [1819877]
  - @cotal-ai/core@0.116.3

## 0.116.2

### Patch Changes

- 64add96: On a terminal, a `→ using`, `→ wrote` or `→ removed` line now wraps at spaces like the CLI's other notices, each continuation line under the text after the arrow. A path too wide for the rest of the line, such as the one `cotal spawn` names after `→ using persona:`, goes on the next line whole. It used to be one line however wide, so an 80-column terminal broke the path mid-word. Written to a pipe or a file the line stays one line, unchanged.
- @cotal-ai/core@0.116.2

## 0.116.1

### Patch Changes

- 211c572: Removing a pid record whose identity pin path holds a directory now refuses with a message that names the directory and keeps the record. It used to end with Node's raw `ERR_FS_EISDIR` text, so `cotal down` printed a filesystem error instead of saying what was wrong and what to do.
- f561850: Teardown now refuses a live recorded process whose `<pidfile>.identity` pin exists but cannot be read, such as a pin the stopping user has no permission to read or a directory at the pin path. Any pin read error used to count as a missing pin, so `cotal down` and the manager, delivery and auth-service stops warned that the record predated identity pinning and signalled the process without the identity check. Only a missing pin takes that legacy path now. `verifyIdentityPin` reports the new `unreadable-pin` verdict with the read error, and `identityUncertaintyRefusal` names it. The record and pin are preserved, and a record whose pid is already dead still clears.
- Updated dependencies [31cb8e5]
- Updated dependencies [c6be6dd]
- Updated dependencies [331ea96]
- Updated dependencies [b695d8a]
  - @cotal-ai/core@0.116.1

## 0.116.0

### Patch Changes

- 81a6062: A pinned fetch that the policy refuses, a target that is not https and not a loopback http literal, or an answer that is a redirect, now throws `PinnedFetchRefused` with an unmarked message. A transport failure still escapes as whatever `fetch` threw. `meshes add`, `meshes add --from` and `space add --from` tell the two apart with `instanceof` and add `✗` where they print, instead of sniffing the glyph in the message. The policy refresh no longer strips that glyph before rethrowing. A bundle whose agent-provisioning URL fails the same rule still carries `✗` on the check the front end prints, like every other bundle refusal.
- fee5f39: A multi-space host stopped by SIGINT or SIGTERM while a pass is still opening a space waits for that open, bounded by the open deadline, and closes the lane it produces before the host ends. Before, the lane joined the map after the stop had snapshotted the lanes to close and was never closed: a delivery host stopped in that window left the space's lease row in place until its TTL, and a restart was refused with "a live lease already exists".
- Updated dependencies [3c60b76]
- Updated dependencies [2e7cdfd]
- Updated dependencies [5b85487]
- Updated dependencies [ff23d2d]
- Updated dependencies [c19eaf9]
- Updated dependencies [c8072d6]
- Updated dependencies [726cd81]
- Updated dependencies [352ee27]
- Updated dependencies [cf3218f]
- Updated dependencies [ff12daa]
- Updated dependencies [a8a49b7]
  - @cotal-ai/core@0.116.0

## 0.115.4

### Patch Changes

- 352d94d: A multi-space host (`auth-service --spaces`, `auth-service --callout-only --spaces`, `deliver --spaces`) opens its spaces' lanes together, and waits at most 30 s for any one of them: an open that hangs no longer holds back every later space in the manifest, the ready line, or the acknowledgment of a removal. The hung open keeps running and is not started again; its lane is taken when it settles, or closed if the space left the manifest or the host refused meanwhile. The ready line names such spaces as "still opening", apart from the ones being retried. The default startup refuses such a space at the deadline, as it refuses one that fails to open.
- @cotal-ai/core@0.115.4

## 0.115.3

### Patch Changes

- 4e84742: `identityUncertaintyRefusal` now accepts only a torn pin, a torn pairing, or an unpinned live pid. A match, a gone pid, a legacy record, a mismatch, or a pidfile with no pid is a compile error instead of a refusal that names the identity state as unsupported. The three refusing kinds keep their own sentences. A stop whose verification rereads the pidfile and finds no pid refuses before any signal and keeps the record.
- @cotal-ai/core@0.115.3

## 0.115.2

### Patch Changes

- Updated dependencies [fe37cb4]
  - @cotal-ai/core@0.115.2

## 0.115.1

### Patch Changes

- @cotal-ai/core@0.115.1

## 0.115.0

### Patch Changes

- @cotal-ai/core@0.115.0

## 0.114.1

### Patch Changes

- 12f2b47: `cotal down --abandon-stop <id> --yes` given an ID that no stack member retains, such as the operation ID of the `down` that sent the stop, refused `TARGET_NOT_FOUND` with that ID in its fields as `Original request`, the label the `LIFECYCLE_BLOCKED` refusal over a retained stop gives the real stop request ID. The refusal now shows it as `Given ID`. Other refusals keep `Original request`, and the `--json` shape is unchanged: `target.requestId` still carries the given ID.
- @cotal-ai/core@0.114.1

## 0.114.0

### Patch Changes

- @cotal-ai/core@0.114.0

## 0.113.3

### Patch Changes

- Updated dependencies [d4a9361]
  - @cotal-ai/core@0.113.3

## 0.113.2

### Patch Changes

- 09f2707: A user-auth mesh whose broker is down is refused with the same unreachable sentence as every other mode. A mesh this machine only registered, by hand or from a catalog, is told to start it where it runs or unregister it. A mesh this machine started is still told to run `cotal up` at its recorded root.
- @cotal-ai/core@0.113.2

## 0.113.1

### Patch Changes

- 51d8642: `cotal down` attributes a recorded pid through the component's own command check, and it does that at one point. A record whose identity pin names another process start is refused and kept, for the delivery daemon and the manager alike. A record with no pin whose live command is not that component's is removed without a signal, and the two stops print one line for it.
- Updated dependencies [14c4333]
  - @cotal-ai/core@0.113.1

## 0.113.0

### Patch Changes

- f3460b3: The user-mode control connect decides its `--creds` and non-user-mode refusals once. `connectUserControlOrExit` prints that sentence and exits, so it can no longer drop the recovery clause or skip the `--creds` refusal.
- Updated dependencies [38fc031]
- Updated dependencies [c1ff7d8]
- Updated dependencies [29c67fe]
- Updated dependencies [a9cd2f5]
- Updated dependencies [41fb2de]
  - @cotal-ai/core@0.113.0

## 0.112.0

### Minor Changes

- 1924ecd: Serve several spaces from one auth service process as their full primary. `cotal auth-service --spaces <manifest> --server <url>`, without `--callout-only`, holds one lane per space: the space's callout, authority plane and plane claim, its loopback exchange and JWKS on a port of its own, recorded in that space's `auth-service.json`, and the public face its manifest entry names. Lanes share the process and nothing else, so one space's keys never sign for another, and a fence or a lost broker connection closes that space's lane alone; the host reopens it every 5 seconds while it fails. Lane lines carry a `[<space>]` prefix. An embedder passes its secret store to `runAuthService(args, store)` with `spaces` in `args`, as it does for one space.
  
  The manifest for this host is version 2, one object per space: `{"version": 2, "spaces": [{"space": "<s>", "exchangePublicPort": 7451, "exchangeTrustedProxy": true}]}`. An entry takes `exchangePublicPort`, `exchangePublicUrl`, `exchangeTrustedProxy`, `advertisedServer` and `agentProvisioningUrl` under the rules of the flags they replace, and two spaces naming one port refuse the manifest. `--port` and the public-face flags refuse with `--spaces`; `--server`, `--auth-timeout` and `--service-endpoints` apply to every lane. A changed entry closes that space's lane and opens it again. At startup the host serves every space it can, names each one it cannot, and retries those, so one tenant's fault does not keep the others down at a restart.
  
  Every multi-space host, `auth-service --callout-only --spaces` and `deliver --spaces` included, now writes `<manifest>.applied` beside its manifest, holding the SHA-256 of the manifest it applied, once every space that manifest does not name has no lane left. Removing a space from each manifest that names it and waiting for each acknowledgment stops one space without stopping the others. A lane that does not confirm its close holds the acknowledgment back until a retry closes it, and its space is not opened again meanwhile. A refused all-or-none startup no longer reopens the lanes it closed.
  
  **Breaking:** a host writes `<manifest>.applied` before it opens any lane and refuses to start when it cannot, so the manifest's directory must be writable by the host. This applies to existing `auth-service --callout-only --spaces` and `deliver --spaces` hosts too: give the host write access to its manifest's directory before upgrading.
  
  `parseSpaceManifest` takes an optional settings parser for version 2 manifests, and `runSpaceHost` takes per-space settings and a `startup` policy; the callout and delivery hosts keep their version 1 manifests, and the callout host keeps all-or-none startup. `auth-service --spaces` runs now say to keep the entry, since the `auth-service` service preset has no form for `--spaces`.

### Patch Changes

- @cotal-ai/core@0.112.0

## 0.111.1

### Patch Changes

- @cotal-ai/core@0.111.1

## 0.111.0

### Minor Changes

- d367269: Bound the issued-authority stores. A generation now carries its horizon in its first 8 hex digits, every issued and accepted row is written with a NATS per-message TTL that removes it 60 seconds after that horizon, and both stores set `allow_msg_ttl`. Every resolution, renewal and retirement refuses a generation at or past its horizon before it reads the store, so a removed key that is written again is never read. Horizons are the bearer expiry for a user-auth `manager-caller` view, the instrument expiry for a control-caller instrument, the assignment expiry for a platform supervisor, and 30 days after spawn for a managed static seat, whose renewals stop there (rotation is tracked in #4942). The `issuer` credential gains `STREAM.INFO` on the accepted store, and every issuer and resolver (the one-shot and held issuer sessions and the manager) checks both stores' shape when it binds. Breaking: a space's `KV_cotal_issued_<space>` and `KV_cotal_accepted_<space>` created by an earlier release are refused by every binder before it reads or writes them. Stop the space's auth service, callout replicas and managers, back up both streams with `nats stream backup`, remove them with `nats stream rm`, and start this release to recreate them. Generations issued before the upgrade refuse afterwards.

### Patch Changes

- b5b0960: Two next steps now run as written. Bare `cotal`'s Start here row for a stack whose recorded store cap is below the floor names `cotal up --max-file-store 67108865`, with the label saying a store cap of 67108865 or more, instead of a command that ends in "or more" and fails on it; the folder note keeps its sentence. The width wrapper keeps a backticked command that starts with `cd` whole, as it already did for one that starts with `cotal`, so the manager-start refusal's `cd <folder> && cotal manager start` never breaks across lines.
- Updated dependencies [d367269]
  - @cotal-ai/core@0.111.0

## 0.110.0

### Minor Changes

- 927e512: Serve several spaces from one delivery process. `cotal deliver --spaces <manifest> --server <url>` holds one delivery lane per space the manifest names, so a host runs one delivery process instead of one per space. A lane is the daemon `deliver --space` runs, held by the host: it reads its own space's credential from the root, dials on its own connections into that space's account, and holds its own lease, broker watchdog, timer writer and membership feed. One space losing the broker, its credential or its lease closes that lane alone, and the host reopens it every 5 seconds while it fails. A lane writes no pidfile, and its lines carry a `[<space>]` prefix.
  
  The host serves every space in the manifest or none, and names the space it could not serve. It rereads the manifest when it changes on disk, on `SIGHUP`, and on a backstop interval, opening or closing the difference; a manifest that does not read or parse whole is reported and the open lanes are kept. `--space` and `--spaces` are alternatives, `--spaces` requires `--server`, and `--creds`, `--dev-mint`, `--shard`, `--shards` and `deliver pending` refuse with it. `deliver --space` is unchanged. The `deliver` deprecation warning now says to keep `cotal deliver` for `--spaces`, which the `delivery` service preset has no form for.
  
  The manifest grammar and the reconcile loop move to `@cotal-ai/workspace` as `parseSpaceManifest` and `runSpaceHost`, and the auth callout host runs on them. Its behavior and lines are unchanged, except that a signalled callout host now closes its lanes at once rather than one after another, and closes the lanes it opened before refusing on a manifest directory it cannot watch.

### Patch Changes

- @cotal-ai/core@0.110.0

## 0.109.25

### Patch Changes

- dbfc90b: Every command's help now shows its most common uses. `cotal <command> --help` puts an Examples section right after Usage and Shorthands, before Commands and Options, and each example is a command that works as written with a short note on what it does, such as `cotal spawn -d` to launch an agent through a manager and return. Every command and subcommand `cotal help` lists has one to three. An example's command is never wrapped; its note sits beside it, or under it on a narrow terminal. A command's `examples` entry is now `{ command, note }`; a bare string is still accepted and shows with no note. `cotal manager <verb> --help` shows the manager's own examples.
- Updated dependencies [dbfc90b]
  - @cotal-ai/core@0.109.25

## 0.109.24

### Patch Changes

- 0bffcb0: In a folder that holds another space's stopped or prepared stack, bare `cotal` with a prepared or stopped selection labels the selection's `cotal up` as "Start this space" and offers no `cotal spawn`, as it does from any other folder, instead of calling it this folder's space.
  
  Bare `cotal` names `cotal up --max-file-store 67108865` or more, as `status` does, for a stopped stack whose recorded file store cap is below the floor, both in its line on what the folder holds and in Start here, instead of a bare `cotal up` that fails on that cap.
  
  A refusal in such a folder, as from `ps` or `send` while the selection is stopped, keeps the note under its heading whole, with the `cotal up` that restarts this folder's space, as `status` and the `FOLDER_SPACE_NOT_RUNNING` warning already do.
- @cotal-ai/core@0.109.24

## 0.109.23

### Patch Changes

- @cotal-ai/core@0.109.23

## 0.109.22

### Patch Changes

- @cotal-ai/core@0.109.22

## 0.109.21

### Patch Changes

- @cotal-ai/core@0.109.21

## 0.109.20

### Patch Changes

- ffeaa32: `cotal manager start` on a user-auth space with no sign-in no longer launches a manager it cannot confirm. On a space the folder hosts, `manager start` and `manager restart` without a signed-in, granted login refuse `AUTH_REQUIRED` (exit 2) under a `Mesh: <space>` heading before anything is saved or launched, and Next names `cotal login`, then the command again. A manager left running without a sign-in stops: in the folder that hosts the space, `cotal manager stop` and `cotal down` read the manager's stop impact from its own local receipt, so the folder's owner needs no sign-in.
  
  `cotal supervise` refuses before it connects with exit 2, a `Mesh:` heading and a code, and writes nothing in the folder. A space whose own stack in this folder is stopped names `cotal up` there and, with `--server`, the folder whose `cotal up` started that broker. A user-auth space that another folder hosts names the folder that hosts it.
  
  The deprecation notice of `supervise` and the other deprecated daemon entries wraps at the terminal width with each command kept whole. The manager prints its boot inventory once it is up, so a refused start prints no boot line, and the line for no available connector is in plain words.
- @cotal-ai/core@0.109.20

## 0.109.19

### Patch Changes

- @cotal-ai/core@0.109.19

## 0.109.18

### Patch Changes

- @cotal-ai/core@0.109.18

## 0.109.17

### Patch Changes

- Updated dependencies [dc382c0]
  - @cotal-ai/core@0.109.17

## 0.109.16

### Patch Changes

- @cotal-ai/core@0.109.16

## 0.109.15

### Patch Changes

- @cotal-ai/core@0.109.15

## 0.109.14

### Patch Changes

- Updated dependencies [60e6671]
  - @cotal-ai/core@0.109.14

## 0.109.13

### Patch Changes

- @cotal-ai/core@0.109.13

## 0.109.12

### Patch Changes

- @cotal-ai/core@0.109.12

## 0.109.11

### Patch Changes

- e85774c: Bare `cotal service` marks a definition a forgotten space left in another folder as `inherited from <root>` in its State column, and its Next names the `cotal service remove` that forgets it rather than a start that refuses.
  
  The console palette's managed-seat suggestions name a working seat `mesh working · progress unknown`, as `:status` does, through one shared helper.
  
  With another space selected, the note in a folder whose stopped stack recorded a store cap below the floor names `cotal up --max-file-store 67108865` or more, the up that starts it, as `status --space` does, instead of a bare `cotal up` that fails on that cap.
- @cotal-ai/core@0.109.11

## 0.109.10

### Patch Changes

- e9f4793: The broker record and the user-auth pidfile template each have one name. `@cotal-ai/workspace` exports `NATS_PIDFILE`, and `cotal up`, the nats descriptor, `cotal status`, the broker service, the controller-stack checks and the `clean` sweep all take the broker record from it. The sweep takes the user-auth record from `AUTH_PIDFILE`. Renaming either constant moves every site that writes or reads that record.
- @cotal-ai/core@0.109.10

## 0.109.9

### Patch Changes

- 841d980: A folder whose `cotal up` was interrupted before it registered the space, with its broker still running, is the target of the commands run there again when another space is selected. Since a folder's space captures those commands only while it runs, such a folder was taken for a stopped one: `cotal status` there headed with the selection and said to restart the folder's space with `cotal up`, which refuses `LIFECYCLE_BLOCKED` until `cotal down --yes` stops that broker, and `cotal ps` asked the selection. Now a folder whose own stack journal records an `up` or `down` with no outcome while a member it started still runs stays the target, as with nothing selected. `status` there reports it as `Half started` or `Half stopped` under `This folder's space`, with `cotal down --yes` and then `cotal up --root <root>` under Next for an `up` cut off before registration. `--json` names it in `target.space` and `meshes.folder` and carries no `FOLDER_SPACE_NOT_RUNNING` warning, and bare `cotal`, `ps` and the other commands there name it the same way. A folder whose stack is stopped, or whose interrupted operation left nothing running, still leaves the commands to the selection.
- @cotal-ai/core@0.109.9

## 0.109.8

### Patch Changes

- 36b0c06: In a copy or a moved project folder, with another space selected, `cotal status` marked the selection in its Spaces list, then headed a `Selected space` section over the folder's records of another space, and printed no `Mesh:` line, while `ps` and `send` there refused under `Mesh: <space>`. It now reports the space the folder's records name, as those commands do: under its `Mesh:` heading and in `target.space`, marked in the Spaces list, in a `This folder` section that says what the folder holds, with the step those commands name under Next. `--json` also names the recorded folder as `selected.recordedRoot`. Bare `cotal` there named nothing the folder holds and went straight to Usage. It now says on one line what the folder holds, with that step: a copy of a controller stack, a legacy root's records and the folder that space is registered for, or records moved from their recorded folder. A refused `cotal up --server <url>` from a running legacy project's subfolder printed `Mesh: <space>` on stdout as the receipt heading and again on stderr with the refusal. The space is now checked before the receipt starts, so the heading prints once, with the refusal on stderr. `--json` is unchanged. `@cotal-ai/workspace` gains `recordsElsewhereText`.
- Updated dependencies [c592eb8]
  - @cotal-ai/core@0.109.8

## 0.109.7

### Patch Changes

- @cotal-ai/core@0.109.7

## 0.109.6

### Patch Changes

- @cotal-ai/core@0.109.6

## 0.109.5

### Patch Changes

- a32425e: A copy, a moved project folder and the folder a later `up` took a space's name over from keep the store of a stack that runs from another folder, and that store can hold the space's only history. `cotal clean store` and `cotal clean all` there, dry runs included, now refuse `TARGET_UNAVAILABLE`, exit 2, naming that folder and the step the reads there name, and remove nothing. `cotal status` there no longer offers `clean store`. Before, in a folder the legacy launcher started, both removed `.cotal/nats` and exited 0. A bare `cotal up` in such a folder now refuses `CONFLICT`, as `cotal down` there does, instead of taking the name over. When the recorded folder is gone and the space's broker does not answer, it also names `cotal up --space <space>`, which takes the name over to run the stack from this folder. The refusals that commands such as `ps` and `send` give in a copy or a moved folder now head with `Mesh: <space>` and carry `target.space`, naming the space the folder's records name, as `up` and `down` there do. Bare `cotal` in a folder whose registered space is not the selection, and whose own records show its stack stopped, as after `cotal down`, now names the selected space and what the folder holds, as it does for a prepared folder. `@cotal-ai/workspace` gains `recordsElsewhereError`, `targetErrorSpace` and `folderSpaceStopped`.
- @cotal-ai/core@0.109.5

## 0.109.4

### Patch Changes

- @cotal-ai/core@0.109.4

## 0.109.3

### Patch Changes

- @cotal-ai/core@0.109.3

## 0.109.2

### Patch Changes

- 4f6f406: A manager imports an installed runtime extension on demand when a managed seat names it with `spawn --runtime <name>`, and when it resumes a retained seat that was launched on one, through the same installed-extension lookup `up --runtime` uses. A `pty` manager started after `cotal ext add @cotal-ai/tmux` used to refuse `spawn -d --runtime tmux` as an unknown runtime, because its process had imported only its own runtime. An additional runtime removed with `cotal ext remove`, one other than the manager's own, is refused for the next seat even while an earlier import keeps it registered; the manager's own runtime and seats already on the removed one keep their backend. The manager's refusal for an uninstalled runtime now names the official package, from the same table and wording the CLI uses, which moved from the CLI into `@cotal-ai/workspace`.
- @cotal-ai/core@0.109.2

## 0.109.1

### Patch Changes

- @cotal-ai/core@0.109.1

## 0.109.0

### Patch Changes

- Updated dependencies [82cb60d]
  - @cotal-ai/core@0.109.0

## 0.108.1

### Patch Changes

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
- @cotal-ai/core@0.108.1

## 0.108.0

### Minor Changes

- 7657395: The manager and the built-in services start without being added first. `cotal manager start` starts the manager for this folder's or the selected space with the pty runtime and its registered broker, and `cotal manager stop`, `status`, `logs` and `restart` act on it; after `cotal up` it reports the manager `up` started and starts no second one. `cotal service` lists every built-in service, started or not, with the command that starts it, and `cotal service start <preset>` starts one from its defaults, refusing with the exact flags when it needs a file that has no default, such as the feedback form's tester keys and broker credential. A service preset can declare those defaults: a literal, the space's registered root or broker, or a private file the space already keeps. `cotal service add <name> --exec "<command>"` adds a program of your own without a definition file, splitting the command into words without a shell and refusing pipes, redirection, variables and globs.
  
  `cotal supervise` is deprecated again and is removed in 1.0.0 with the other daemon entries. It keeps its flags and behavior and prints one line on stderr naming `cotal manager start`, or, when it is given `--execution`, `--spawn`, `--seat-cap` or a resume flag that `manager start` does not take yet, saying to keep `supervise` for that run. `cotal manager start` and `restart` install first-party connectors on first run, as `supervise` does. `cotal manager install` refuses before any effect and names a unit of your own running `cotal manager start --foreground`. The `deliver`, `auth-service` and `feedback-intake` warnings now name `cotal service start <preset>`.

### Patch Changes

- @cotal-ai/core@0.108.0

## 0.107.0

### Patch Changes

- @cotal-ai/core@0.107.0

## 0.106.1

### Patch Changes

- @cotal-ai/core@0.106.1

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

- 54a2996: `cotal update` and `cotal update --self` no longer refuse the software update over registrations that hold no manager on this machine. A space prepared here that never started (`cotal setup --configure-only`, `space create`), whether it is this folder's space, selected or named, is named and skipped like a stopped one instead of answering "is prepared but not started - start it with cotal up". A folder that holds several registrations, such as two remote spaces registered there with `space add --from`, is read one registration at a time, each by name, instead of refusing with "multiple meshes running" and reading none; the resolver's per-folder ambiguity now carries the space names for that.
- Updated dependencies [ba25fb6]
  - @cotal-ai/core@0.106.0

## 0.105.1

### Patch Changes

- @cotal-ai/core@0.105.1

## 0.105.0

### Minor Changes

- c49bced: Omit `path` from absent process records, including missing files and empty pidfile husks. Narrow `ProcessRecord` by `state` before reading its evidence fields. Non-absent records keep the path that was read, including pre-upgrade spellings.

### Patch Changes

- Updated dependencies [6e16f06]
  - @cotal-ai/core@0.105.0

## 0.104.2

### Patch Changes

- @cotal-ai/core@0.104.2

## 0.104.1

### Patch Changes

- @cotal-ai/core@0.104.1

## 0.104.0

### Patch Changes

- e0c4e6e: Correct the documentation page by page against the implementation, including CLI commands, connector delivery and activity sharing, authentication, observer surfaces, hosted composition, telemetry and historical design status. Refresh package guides and generated tool and HTTP references while preserving existing links and normative contracts.
- Updated dependencies [e0c4e6e]
- Updated dependencies [b7d4f22]
  - @cotal-ai/core@0.104.0

## 0.103.4

### Patch Changes

- e6af269: A project the legacy launcher started writes no stack journal, so a copy of one, the folder a later
  `up` took its name over from, and one moved away from its recorded path all read as a folder whose
  own stack was merely stopped: `status`, `ps` and the other reads named this folder's last broker
  address and said to run `cotal up` here, which then refuses the name or takes it over. While this
  machine registers that space for another folder, they now name that folder and the step that
  reaches it, or the way back when it no longer exists, and a bare `cotal down` there says the folder
  holds the space's records and no stack of its own. A registration added by hand never redirects the
  folder. `cotal spawn --dry-run` carries the same sentence and next step in place of reporting only
  that a target could not be resolved, for a controller project's copy as well.
- @cotal-ai/core@0.103.4

## 0.103.3

### Patch Changes

- Updated dependencies [2b59b43]
  - @cotal-ai/core@0.103.3

## 0.103.2

### Patch Changes

- 2f74981: A read whose recorded broker answers and refuses the connection now keeps its registration when
  another registered space names that same address, and refuses `CONFLICT`, exit 2, naming the space
  that holds the address, the `cotal space forget <space>` that frees it and the
  `cotal up --server <url>` that moves this one. `cotal status` reports that space as `address held`.
  The rejection used to count as a stale record and delete it, which left the folder naming no space,
  so nothing there said which space its commands meant.
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
- Updated dependencies [68377b0]
- Updated dependencies [1608ae7]
  - @cotal-ai/core@0.103.1

## 0.103.0

### Patch Changes

- @cotal-ai/core@0.103.0

## 0.102.0

### Patch Changes

- 9a75f1b: Clients now treat the exchange's rate limit as one. The 429 names the bucket that ran out as `limit`,
  `actor` or `owner`. A CLI command prints the auth service's sentence and exits 2 as
  `DEPENDENCY_UNAVAILABLE`, with a remedy saying whether only that actor or the whole account is
  limited and `RATE_LIMITED`, the seconds and the `limit` in its JSON cause, where it used to report
  `PERMISSION_DENIED`. `cotal agent-bearer` prints `retry-after <n>` on stdout and exits 2, and an
  endpoint asks a bearer source again when a `retryAfterSeconds` it was given has passed, not before.
  When the broker refuses an endpoint's bearer, the warning says so and names where the reason is, and
  the reconnect backoff is randomized so endpoints refused together spread their retries.
- Updated dependencies [9a75f1b]
- Updated dependencies [bf8978b]
- Updated dependencies [10ad6d3]
- Updated dependencies [d0d9e66]
  - @cotal-ai/core@0.102.0

## 0.101.7

### Patch Changes

- 668ef6a: `cotal agent-bearer` now runs before the rest of the CLI loads. A spawned seat execs it at the spawn preflight, at its first connect, at every bearer renewal and for every manager call, and loading the whole command surface made each run take about 400 ms. It now takes about 60 ms, close to the 50 ms of a bare exchange. It reads none of the CLI's preferences, extensions or config folder. A command line it cannot parse still goes to the full CLI, which refuses it with the command's help as before. The command lives in `@cotal-ai/auth/agent-bearer`, and `@cotal-ai/core/command`, `@cotal-ai/core/loopback`, `@cotal-ai/core/subjects` and `@cotal-ai/workspace/liveness` export the parser and checks it uses without loading either package root.
- Updated dependencies [668ef6a]
- Updated dependencies [ae43b58]
  - @cotal-ai/core@0.101.7

## 0.101.6

### Patch Changes

- 52832dc: `space create` and `up` no longer refuse a project folder that sits beside the records of a home `COTAL_HOME` redirects. 0.101.x treated every path under the Cotal home as its control directory, so the hosted layout, whose space root lives at `$COTAL_HOME/cotal`, could not start its broker and a cutover refused with `CONFLICT`. Under a redirected home only the home itself and its record entries (`meshes`, `prepared`, `services`, and the rest `homeRecordEntries` names) are control paths; the default `~/.cotal` still refuses every child, and a project's `.cotal` is unchanged.
- 49cf781: `cotal up --auth-timeout <seconds>` sets how long a user-auth space's broker waits for the auth callout, from 1 to 60 seconds. `up` renders it as `authorization { timeout: N }` in the broker config and starts the space's auth service with the same value as its callout deadline, so the two never differ. The value is recorded in `.cotal/broker-policy.json`, and a later `cotal up` on the root renders it again without the flag, after `cotal down` or a preserved resume included. A running broker refuses a different value. Before, the broker config had no `authorization` block and no flag set one, so a hand-applied timeout was lost the next time `up` wrote the config. `serverConfig` takes the timeout as `authTimeout`, and renders no block without it, so existing configs are unchanged. The auth-service daemon, a `--callout-only` replica included, takes `--auth-timeout <seconds>`.
- Updated dependencies [49cf781]
  - @cotal-ai/core@0.101.6

## 0.101.5

### Patch Changes

- Updated dependencies [e6f1f4d]
  - @cotal-ai/core@0.101.5

## 0.101.4

### Patch Changes

- Updated dependencies [0642c8f]
  - @cotal-ai/core@0.101.4

## 0.101.3

### Patch Changes

- c54a604: `cotal help`, and `cotal --help` and `cotal -h` with it, now lists every command group under the entry screen, so no flag is needed to see what the CLI can do. Bare `cotal` keeps the compact entry screen and points to `cotal help` for the rest. `cotal help --all` is no longer needed; it still works and prints the same list. A hidden command, such as a deprecated daemon entry, is still left out of the list and still runs.
- 330127a: `cotal supervise` is no longer deprecated. Help lists it under its own Run a manager group, it prints no deprecation warning, and it is not removed in `1.0.0`. Without `--space` it now supervises the space every other command targets: `COTAL_SPACE`, else the space this folder hosts or is registered for, else the one `cotal use` selected. A bare `cotal supervise` with a hosted space selected used to target the default space and refuse that it was neither hosted nor registered. A manager started for a selected space keeps its records in the folder that space is registered at, so a start from any folder is the same manager. The CLI docs gain a section on starting a manager for a hosted space.
- Updated dependencies [a677726]
  - @cotal-ai/core@0.101.3

## 0.101.2

### Patch Changes

- 9acfc57: A manager command such as `cotal ps`, `cotal stop` or `cotal spawn --on`, and `cotal send` with the other commands that open a one-shot connection, now connects again when the broker refuses the connection or it does not open within 5 seconds: nothing was sent, so up to 4 attempts are made 1 second apart. A view the auth service refused for a moment, or an auth service that answered after the broker's callout timeout, now just works. These commands used to stop at the first refusal, or wait 20 seconds and end as `OPERATION_UNKNOWN` (exit 3) with a bare `timeout`. When every attempt fails, the command says nothing was sent and is refused, exit 2: `PERMISSION_DENIED` when the broker refused each attempt and `TARGET_UNAVAILABLE` when none opened in time. An endpoint takes a `transportConnectTimeoutMs` option for its first connect.
- 427f28b: A command in a project folder whose stack is stopped with no registration, as after the `down` of a
  space not named after its folder or in a moved project, now refuses `TARGET_UNAVAILABLE` with another
  space selected too, naming the space its account names and `cotal up` there. It used to reach the
  selected space, so `send` stored the message there and `ps` listed that space's manager.
- Updated dependencies [9acfc57]
- Updated dependencies [d57e596]
  - @cotal-ai/core@0.101.2

## 0.101.1

### Patch Changes

- 091498f: A detached custodian can hold one Windows program's job and answer authenticated status and terminate requests over a named pipe.
  A connection that sends a malformed proof or a frame over 64 KiB is dropped, and the custodian keeps
  serving.
- 446fd91: On Windows, a recorded process that has exited reads as gone even while another process still holds
  a handle to it. Before, its creation time stayed readable through that handle and it read as running.
- bdafbf9: The Windows native binding can start a program inside a new job object that ends every member when its last handle closes, and it reads this account's SID.
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
- @cotal-ai/core@0.101.1

## 0.101.0

### Minor Changes

- fc17f8f: `cotal auth mint` now gives a fixed-profile credential a 24-hour lifetime by default. It used to issue one with no expiry claim, which `cotal doctor auth` then reported as a finding for good. `--expires-in` and `--expires-at` still set another lifetime. The new `--no-expiry` issues an unbounded credential and records that request beside the file, in `<file>.no-expiry.json`. `doctor auth` reports such a credential as a `CREDENTIAL_UNBOUNDED_BY_REQUEST` warning with its ways out and exits 0, while any other unbounded agent credential stays a finding. Endpoint callers (`auth mint --endpoint`) keep their behavior. A process that reads a newly minted file for more than a day, such as a dashboard given `--creds`, needs a longer lifetime or `--no-expiry`; see the upgrading guide.
- dedb739: Separate liveness reporting from mismatch pruning. `pruneMesh(space)` now serves only
  mismatches, without a reason argument or `PruneReason` type. `pruneStaleMeshes()` keeps
  registrations and returns only `offline`, removing the always-empty `MeshSweep.pruned`
  field and redundant registry reads. Callers handling an unreachable target must report
  it offline without calling `pruneMesh`.
- 77c915a: A command run without `--space` inside a project folder whose root has one space now targets that space, even when another space is selected, and the note under its `Mesh:` heading says the selection applies outside the folder. Before, it targeted the selection with a `SELECTION_NOT_FOLDER_SPACE` warning, which is now given only in a folder with several spaces. `cotal up` also says when it selects the space it started.
- eabc54d: `cotal service add` now saves a definition with the root of the space it is added in. A definition a
  forgotten space of the same name left in another folder refuses `service start`, `restart` and
  `install` there with `CONFLICT`, naming that root and `cotal service remove <name> --space <space>
  --yes`, instead of running in the forgotten project's folder. `cotal service` marks such a
  definition `inherited from <root>` in a new `Added in` column, `service show` lists `Added in`, and
  `--json` gives each definition its `root` and `rootMatch`. A definition file that sets `root` is
  refused `SCHEMA_INVALID`. Definitions saved before this release start as before and show `root not
  recorded`. An earlier release refuses a definition that records a root; see the upgrading guide.

### Patch Changes

- ff99364: A refused service adapter path names each unprotected folder once. The refusal repeated the
  shallowest folder at the end with its owner and mode, after already naming it with its reason.
- 39e0c7a: `auth mint --identity` keeps the read channels, post channels and role of the agent credential it names, unless a flag replaces one, and the mint receipt and JSON list the grants. `auth mint --out` records the file it wrote, without the credential, and `doctor auth` lists each such file with its state and expiry, naming the mint that renews it or, for a revoked key, a mint with a new key.
- e7cb03f: `cotal auth mint <label> --replace` replaces the label's standing credential when it has expired or has no expiry claim, and removes the no-expiry record beside it. Before, an expired or unbounded label could be cleared only by removing its file inside `.cotal` by hand. A still-valid credential refuses `CONFLICT`, naming its expiry. `cotal doctor auth` names that command for an expired or unbounded label's file, and the refusal for an existing label says `--replace` replaces one that has expired.
- 0d1dfc3: `cotal auth revoke-credential <public-key | creds-file>` stops one credential that `auth mint` wrote and keeps the space's store and every other credential. Until now the only way to stop a leaked minted credential was to rotate the space identity with `reset space`, which also removes the store and its history. The command records the key in the space's account JWT `revocations`, so the broker refuses it from its next start. It works on a stopped space, and on a running one it refuses and names the route: `cotal down`, the revocation, then `cotal up`. `auth mint --identity` refuses a revoked key. `auth retire`'s next step and doctor's guidance for an unbounded credential now name the revocation first and the identity rotation as the wider step.
- d0c3cd7: On a terminal, a command whose quoted path holds a backtick now wraps as one word. The `team boot`
  refusal on a running stack and the `status` hint after `space forget` name such a command between
  double backticks, as Markdown writes code that holds a backtick, and the wrap keeps it whole to the
  matching pair. Before, at 80 columns in a folder named ``tick`q "dq" $(x)``, the path's own backtick
  ended the command and the line broke inside the quoted path. The command between the backticks is
  unchanged.
- c74a853: `backup verify`, `backup restore` and `up --restore` refuse an artifact that another local account
  could write. A copy whose folder and files were group-writable verified and restored without a
  word, although its hashes cannot show a consistent rewrite. The artifact directory, each file in it
  and each directory above it now follow the protected-path rule `space create` applies to a project
  root: an unsafe one refuses `PERMISSION_DENIED` (exit 2) before a restore stages or changes
  anything, naming every such path and one remedy such as `chmod g-w <paths>`.
- fff2909: A `backup create` that loses to another operation now says what holds the root. One that finds the
  maintenance lock held names the operation, such as another `backup create` or a restore, its process
  and since when it has held the lock, and asks to wait for it. One that runs during a restore names
  that restore attempt and its process and asks to wait, where it used to suggest rolling the restore
  back. These refusals name no attempt of their own, because they journaled none. A refusal that names
  a running restore or backup process now also says when it started.
- 0c9e498: A refusal that repeats an over-long argument, such as an unknown command or subcommand, a space name given to `use` or `--space`, or a run id, now shows its first 128 characters and its length. A 100000-character value used to print a line as long as itself. The command still checks and uses the whole value.
- 1e75421: `space add`, `meshes add` and the `meshes add` prompt refuse a broker URL with a user name or password in it in the words every command uses for such a `--server`, with the same next step: name the broker URL without `user:password@`, and pass the credential with `--creds`, a login or the space's own trust. Before, a connection bundle's server and a typed address were refused with an older sentence and no next step. A value that does not parse as a broker URL is no longer echoed in part when it carries a user name.
- ea76a77: Shell completion no longer writes a warning, such as the one for a prepared space record it skips,
  unless `COTAL_COMPLETE_DEBUG` is on. Unset, empty, `0`, `false` and `off` keep it quiet, as they do
  for a completion's errors. The docs now say the shell stubs discard stderr, so a completion's
  diagnostics show only when `cotal __complete <words>` runs by hand.
- 0282994: `run start --file`, `run simulate --handler`, `auth mint --out` and `--identity`, and `--creds` on a
  command with no completer of its own complete from the shell's file names. A flag declares that with
  the new optional `FlagSpec.completion: "files"`. `spawn` completes the personas of a prepared space
  that is not started, as `persona show` does.
- dbbd7f5: Shell completion now offers the values the CLI knows without contacting the mesh. Every `--space` offers the spaces registered or prepared on this machine, as `cotal use` does. `config get`, `set` and `unset` offer the keys, and `config set color` and `config set harness` offer the values a write accepts. `docs` offers its pages, `watch --view` its views and `space add --mode` its modes. `history` and `channel show`, `members`, `set` and `remove` offer the channels the target space's personas declare, as `send -c` does.
- 7d489d2: Shell completion offers values the CLI already knows offline. `config get`, `set` and `unset`
  complete the preference keys, and `config set color` and `config set harness` their values.
  `docs` completes page names. `watch --view` and `space add --mode` complete their values, and a
  `--space` value completes from the registered and prepared spaces on every command.
- cfeaddd: `cotal completion` receipts now say what happened. A repeated install says nothing needed changing, rather than that owned material was changed. An uninstall blocked by a hand-added line that sources the stub names the startup file and the line. A failure whose confirmed changes are file paths lists them, rather than a receipt count with advice to choose structured output.
- afec9b6: A file where the Cotal config folder belongs no longer breaks every command with a misleading
  "corrupt extensions manifest" error. Help, version and docs run, and every other command is refused
  with `SCHEMA_INVALID` naming the file and how to move it aside, with the envelope under `--json`.
- 7c8564e: A missing `--yes` outside an interactive terminal now refuses in two lines, the refusal and a
  remedy that names `--yes`, as `down` does. `history clear`, `persona remove`, `channel remove`,
  `space delete`, `reset store`, `reset space`, the service and team removals, and the other
  confirmed commands printed the whole command help after the refusal, and several gave no remedy.
- 66d2f93: A connector session now refuses a `COTAL_SERVERS` with a user name or password when it starts. The NATS client kept only the URL's host and port, so the session dialed without them, failed authorization in a loop with nothing saying why, and printed the URL with the password in the `cotal_roster` and `cotal_channels` not-connected lines. The refusal names the variable without repeating its value, and says to pass the credential in `COTAL_CREDS`, `COTAL_TOKEN` or a `COTAL_LINK`. The URL check moves from workspace to core so the connector can use it.
- 5cc55a7: A project folder whose path contained a control character, such as a tab, a newline or an escape character, could be prepared with `space create` but never started: `up` wrote its stack journal and then refused it as an unsupported shape, and every next step led back to `up`. `space create` and `up` now refuse such a path, and a path with a bidirectional formatting mark, with `USAGE_INVALID`, exit 1, before anything is written, naming the character and saying to rename the folder. A folder renamed from such a path is told to adopt its journal with `space create <space> --adopt` and is no longer told to move back.
- 3a12438: `space create` and `up` refuse a folder that is, or is in, a control directory, such as a running project's `.cotal`, judged by the path given and by the path its links lead to. They used to prepare and start a second stack there, writing a `.cotal` among that project's credentials and records. The refusal names the project folder to run from.
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
- 09d905f: A credential that expires more than about 24.8 days away no longer turns off reconnect as soon as an endpoint starts. The endpoint's pre-expiry fence passed the whole remaining time to `setTimeout`, which Node runs after 1 ms for any delay above 2^31-1 ms, printing a `TimeoutOverflowWarning`. A command run with such a credential printed that warning, for instance with one of the space's own 30-day store credentials or an `auth mint --expires-in` of a month or more passed to `--creds`. A longer expiry now waits in steps. `auth mint` also refuses an `--expires-in` or `--expires-at` that ends after the last date Cotal can represent, in the year 275760, before anything is written. Before, it minted the credential and the receipt showed the expiry only as raw seconds.
- 286bccd: A credential file that does not exist now refuses `TARGET_NOT_FOUND` and names the file, in the
  message and the JSON target, wherever a command checks a credential file it is given, such as
  `auth revoke-credential <file>` and `auth mint --identity <file>`. A path that cannot be checked
  refuses `DEPENDENCY_UNAVAILABLE` and names the file and the cause. Before, both gave one pathless
  "missing or unreadable" refusal. A credential file another account can read now has `chmod 600` on
  it as its Next, or a private copy when another account owns it. `auth revoke-credential` given a
  word that is not a user public key and names no file says both.
- 4b2eb30: A `--creds` file in a folder another local account can write, or below one, is now refused `PERMISSION_DENIED` before it is read, as `auth mint` refuses to write a credential there. The refusal names the folder, and its next step is the `chmod`. Until now every command that reads `--creds` used such a file silently.
- 855e595: A credential for another space used with `--server` at the wrong broker now points at a step that works. The refusal's next step says to use `--space <owner>` without `--server`, naming the broker that space is registered at. Keeping `--server` with `--space <owner>` used to end on the generic "credentials rejected … check your creds", and now says the space is registered at another address and to drop `--server` or point it there.
- 1c978f9: A `--creds` credential the broker rejects now names the space it belongs to when its own permissions name one other space: `credentials rejected at <server>: <file> is a credential for space "<owner>", not "<space>"`, still `PERMISSION_DENIED`, exit 2. The Next is `--space <owner>`, and with `--space` given it also names `cotal auth mint` for the space that was asked for. Before, every such rejection said only "check your creds, or the broker wants different auth". The structured target carries `credentialSpace`.
- f0d3143: A command given `--creds` without `--space` or `--server` now uses the selected space, or else the space of the project it runs in, as it does without `--creds`. It used to send the credential toward `main` and refuse with "the default space "main" is not registered here" from the space's own folder and with that space selected. `join --creds` and `join --token` take the selected space the same way. When that space is not registered here, the refusal names it as the selected space or this folder's space, and puts it under `target`.
- 5703dfb: A command about a space whose prepared record cannot be read now names `cotal space forget <space>` as its remedy, without repeating what the file holds, and `status` names a skipped prepared record once instead of twice.
- a62d32d: A prepared space record that cannot be read no longer stops every command. Commands about other spaces skip it with a `PREPARED_RECORD_SKIPPED` warning naming the file, a command about its own space still refuses, `cotal space forget <space>` removes it, and `status` lists it as unreadable.
- 5f312f7: `@cotal-ai/workspace` has a macOS process identity binding beside the Windows one. It reads a process's
  start time in microseconds, its process group and whether it is stopped with `sysctl`, a process
  group's members with `KERN_PROC_PGRP`, and the machine and boot UUIDs with `gethostuuid` and
  `kern.bootsessionuuid`. A build on macOS compiles it against the checksum-pinned Node headers for
  macOS 11.0 and later and records a verified build receipt, as the Windows binding does.
- 057e96d: A packed or published `@cotal-ai/workspace` now carries the macOS process identity binding for
  x64 and arm64 beside the Windows pair. Its prepack refuses unless all four bindings are present and
  match the committed source and their build receipts. The release builds the macOS pair natively on
  Intel and Apple silicon runners and assembles it with the Windows pair, so an upgrade on a Mac never
  arrives without the binding that its process pins depend on.
- 41db374: On macOS, a process identity pin now records the process start in microseconds through the bundled
  binding, in place of the `ps -o lstart` start date, which has only second precision and could not
  tell apart a pid reused within the same second. A pin an earlier release wrote still verifies with
  the `ps` reader it was written with, so `down` after an upgrade stops a stack the earlier release
  started. The process group and stopped-process readers that the service stop and the stack's broker
  checks use now answer on macOS too, and a failed macOS group read throws rather than reading as empty.
- 700695c: Process services, and with them a prepared stack's `cotal up` and `cotal down`, run on macOS. The
  direct-process driver pins the machine's hardware UUID, the boot session UUID, the OS user and each
  process's start in microseconds, read through the bundled binding, where Linux pins its machine ID,
  boot ID and start ticks. A background start leads its own process group, and a stop signals and
  waits for that whole group, as on Linux. The manager's native child, its stop reservation and the
  native service identity records accept the same pins. Before, each of these refused with
  `UNSUPPORTED` on macOS. Windows still refuses.
- 2ed3641: `help --all` and the help of `supervise`, `deliver`, `auth-service` and `feedback-intake` now mark
  each deprecated entry, with its removal release and the service preset that replaces it. They listed
  the entries with no label, so only a run's warning said they were deprecated.
- 9aa4be8: `cotal doctor auth` no longer refuses the whole diagnosis with "the saved local record is not owned and private", naming no file, when one of the space's own store credentials, such as `membership-observer.creds`, is readable by other accounts. That file is a finding like any other credential file: it names the mode and gives `chmod 600 <file>` as the repair, and every other file is still checked.
- 35ec68e: `cotal doctor auth --fix` mints a delivery or membership-rw credential the NATS client cannot parse again under a new identity when no broker answers, and says so in its result row. Every row that is not a plain re-sign has a `reason`. A refusal because the manager holds the renewal lease names `cotal down`, then `cotal doctor auth --fix`, and `cotal up` warns when it starts with such a membership-rw credential. A missing `membership-observer` or `connection-evictor` credential is a finding, with `cotal down` then `cotal up --rotate-sys` as its repair.
- e5ea994: Bare `cotal` and `cotal help` in a started space's project folder, with nothing selected, now lead with that space, as the commands there target it. `cotal setup` leads only on a machine with no space; with spaces elsewhere and none selected, the screen names `cotal use <name>` and `cotal space`.
- 0b638b8: A labeled field whose value has a word too wide to fit beside its label, such as an identity or a long display name, starts on the line under the label on a terminal instead of running past the width. `channel members`, `endpoints` and `who --all` no longer print lines wider than an 80-column terminal.
- 817f353: A FIFO or another file that is not regular, where a state file belongs, no longer makes a command
  wait forever. A `preferences.json` like that is refused with `PERMISSION_DENIED`, naming it, by
  every command that reads preferences. A `.cotal/channels.json` like that refuses `up` with
  `USAGE_INVALID`, and `persona` lists such a catalog file as unreadable and names it, as `persona
  show` already refused it.
- b7d985d: Two first `up`s started together in a fresh folder no longer let the loser fail with a raw `EEXIST`
  on `.cotal/maintenance` and an unknown outcome. Both create that folder safely, and the loser refuses
  `LIFECYCLE_BLOCKED` naming the other command's pid, as documented.
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
- 2dcc119: `cotal history --follow` now ends on its own when its credential can no longer connect, because it expired or because the broker rejects it, as after `reset space`. It ends with the refusal a one-shot command with that credential gets, `AUTH_REQUIRED` or `PERMISSION_DENIED` with its Next, and with `--json` it writes that `error` record and then its `end` record. Before, it printed the raw broker text and "re-establishing" and then waited forever. A lost connection is now one line, or one `TARGET_UNAVAILABLE` error record, while the follow re-establishes it, so a follow still outlives a broker restart. A credential past its own expiry is refused before any dial, since a broker still takes it during its last second.
- 5521d3f: A credential file or saved private record that the shared file guard refuses with
  `PERMISSION_DENIED`, because it is not an owned private regular file, is not private, or cannot be
  opened without following a link, now names the file in the message and in the JSON target. Every
  command that reads such a file through the guard gets this, such as `auth handle inspect`,
  `feedback --key-file` and `up --manager-name`. Before, the text named no path.
- 332d20e: Ctrl-C or `SIGTERM` during `space delete`, `reset store`, `reset space`, `clean store` or `clean all`
  now reports what the command left and exits 130 or 143, instead of exiting with no output. The
  reset and clean routes release the maintenance lock first. A command that takes over a maintenance
  lock left by a process that is no longer running now says so with a `MAINTENANCE_LOCK_TAKEN_OVER`
  warning.
- 9901303: A `.cotal/channels.json`, `--channels` file or `preferences.json` that begins with a UTF-8 byte-order
  mark, as some Windows editors write, now reads as the JSON after it. Before, `cotal up` refused the
  channels file, and such a preferences file stopped nearly every command, with a parser message that
  showed the mark as an invisible character.
- e264d3c: In a folder whose `.cotal` is a link to another project's `.cotal`, `up` and `down` said the folder was copied from that project, `status` printed two inventory warnings without a cause, and `space create` said the folder held copied or moved records. Each now names the link: `up` and `down` refuse `CONFLICT` and say to use the stack from the project it leads to, `status` gives one warning that it did not read the attempt inventories through the link, and `space create` names the link.
- af0a0bc: When a project's `.cotal` was moved to another folder and linked back, `up`, `down` and `status` in
  the project, and every command in the folder the records were moved to, no longer send you from one
  folder to the other. They name the way back: remove the link, then move that `.cotal` back in its
  place, which keeps the history. Nothing is moved for you.
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
- 0decd7a: `cotal auth mint` refuses a label or `--role` its grammar does not take by naming the character, the value and the characters allowed, with a Next that names a value it takes, such as `p_agent` for `p-agent`. Before, every such refusal said only "use a valid credential label and role without path or terminal controls" and printed the command's help. The grammar is unchanged.
- 240dbf4: A controller project folder moved after its stack stopped got contradictory next steps: `up` and `down` said to move it back, while `status`, `send` and `history` said to forget the space and prepare it again with `space create --root <dir>`, which `space create` then refused. Every command run there now names the same next step. A folder moved on this machine is told to move back. When this machine records neither the space nor an instance of its stack, as for a copy brought from another machine, moving back would not start it, so `up` and `down` now name only `space create <space> --adopt`, as `status` already did. When the space is prepared or registered here, they name moving back or forgetting the space and adopting the journal.
- 1de8abb: Renaming a project folder while its stack ran stranded it. The running broker created empty store folders at the old path within seconds, so `up` and `down` in the renamed folder said it was a copy and to use the stack from the old path, and `send`, `history` and `service stop` said the seed under the old path was missing. The broker configuration now names a store inside the project folder relative to it, and the broker runs from that folder, so a renamed folder keeps the broker's writes and the old path is not created again. `up`, `down`, `send`, `history`, `ps`, `service status` and `service stop` in a moved folder now refuse `CONFLICT`, say it was moved, and say to move it back, moving aside anything found at the old path first.
- 0c7e317: On a terminal, more Next lines now keep each command whole when they wrap. Four of them name their
  commands in backticks now: `space delete` of a running space, `run answer` with a step name that
  matches an open request, `down` and `down --dry-run` beside a running service, and `up` in a moved
  folder that `space create --adopt` takes over. Before, at 80 columns, the `space delete --dry-run`
  Verdict of a space with a long name printed `cotal reset store` at the end of one line and the
  name on the next.
- b8ef19b: A command run in a folder whose `.cotal/` names no space, as after `cotal space forget`, no longer heads its refusal `Mesh: main` or lists `Space: main`. The refusal names the folder, and its JSON `target` now holds only `root`, because the default space was only assumed there.
- 788bf15: On a space registered as open, `auth mint` and `auth signer` refused `AUTH_REQUIRED` about missing static signing trust, with no next step, as if something were missing. They now refuse `UNSUPPORTED` and say why: an open space authenticates no one and issues no credentials, so nothing was minted or exported. The next step is to connect without credentials. A root with no signing trust and no open registration keeps the earlier refusal.
- 2093a48: `cotal space create` and `cotal down` for a root whose controller stack runs under another `COTAL_HOME` now refuse `TARGET_UNAVAILABLE` and name the home to run with, like `cotal up`. `space create` used to prepare a space there that could never start, after which `status` reported it as prepared and stopped naming the other home, and `down` refused with a missing member definition and no next step. `status` now names the other home even when this home prepared a space at that root.
- 7b97877: An over-long service argument now names its position and the limit. A `service add --file` definition whose launch argument is over 8192 characters refuses `SCHEMA_INVALID` with "launch argument 2 (launch.args[1]) has 8193 characters, and a launch argument holds at most 8192"; it used to say only that the input did not match the schema at `launch`. A preset's array option, such as the exec-endpoint `--handler-args`, whose argument is over its declared length refuses `USAGE_INVALID` naming that argument's position and length, before the adapter's schema is checked.
- 2f7657c: More hints that name a path now quote it when a shell would split or expand it, so they can be pasted: the `chmod u+w` that a preferences folder, `up` and `down` name for a folder they cannot write, the home screen's `cotal up --root <dir>` row, the `cotal space create <name> --root <dir>` that `status`, an unreachable folder naming no space, and `up` for a forgotten space name, and the `cotal space create <space> --adopt --root <dir>` remedies for a moved folder.
- 9323110: Three hints that name a project path now quote it when a shell would split or expand it, so they can be pasted: the `cotal space create <space> --root <path>` that `status` names after a forget, the `chmod u+w` a persona catalog that cannot be written names, and the `cotal up --root <path>` that `status` names to restart a stack's stopped members.
- 101e4f1: In a folder a space is prepared for, a command given a `--server` that no registration names now
  names that prepared space, as `cotal up` there does. The persona commands read and wrote the
  folder's catalog but labelled it `main`, a space that existed nowhere.
- 70e9a65: Publishing a pid record over a pidfile that exists but cannot be read now throws an error naming the pidfile before anything is renamed. It used to read that pidfile as a first start, so the bridge pin dropped the old record's line and the publish replaced the unreadable pidfile without reporting the read error.
- ea1b582: A preferences folder that another local account could write is no longer trusted silently. It
  follows the protected-path rule `space create` applies to a project root. Every command that uses
  the saved preferences still applies them, with a `PREFERENCES_FOLDER_UNPROTECTED` warning naming
  the folder and the `chmod` that fixes it, and `cotal status` lists that `chmod` under Next.
  `config set` and `unset`, `setup` and the preference removal in `space forget` refuse such a folder
  with `PERMISSION_DENIED` (exit 2) before anything is written.
- 998477a: `cotal config set` and `unset` now say when they replace a `preferences.json` whose mode was not `0600`, such as a read-only `0400`. The write still replaces it with a private `0600` file, and the receipt names the old mode in a `PREFERENCES_MODE_CHANGED` warning. It used to change the mode without a word.
- 062cdfd: A file where `~/.cotal/prepared` belongs is now refused as `<path> is a file, not a folder`, with the step that moves it aside, instead of as an unreadable mesh registry record to restore from backup.
- e3979fe: A space prepared in a project folder and not started yet counts as that folder's space: a command run there with another space selected targets the prepared space, as it targets a registered one, so a `send` there before the first `up` no longer lands in the selected space unannounced.
- b5017a7: A `~/.cotal/prepared` that exists and cannot be read, such as a regular file in its place, is now refused by that folder with `SCHEMA_INVALID`, exit 1, and the remedy to restore or remove it, as an unreadable mesh registry folder is. `space`, `space create`, `use`, `space show`, `whoami`, `space forget`, `status` and `up` gave a raw `ENOTDIR` as `OPERATION_UNKNOWN`, exit 3.
- b1397f4: A record in `~/.cotal/prepared` that does not parse or is not a prepared space record is now refused by its file with `SCHEMA_INVALID`, exit 1, and the remedy to restore or remove it, as a damaged mesh registry record is. Every command that reads prepared spaces reported it as `OPERATION_UNKNOWN`, exit 3.
- 3a3d489: The refusal for a folder or file other local accounts can write now names one step when the path is writable by its group and by every account: `chmod go-w <path>`. It used to name `chmod o-w`, and on a host where the group could not be proven private the next run refused again with `chmod g-w`. The other group and world gaps in the same refusal join that one command. `auth mint --out`, a `--creds` read and every other command that checks a path for other local writers share this refusal.
- 4f1ade7: `cotal ps` while an `up` is still starting the stack's manager now refuses `TARGET_UNAVAILABLE` saying the manager is starting, with a Next to run `cotal ps` again once `up` reports it started. It used to say no manager was running and point at bare `cotal up`, or fail with the raw "has no live registered instances" error once the manager process ran but had not registered. It reads the stack journal's unsettled `up` and checks that a live process holds the root's maintenance lock, so an `up` that died keeps the no-manager refusal. `@cotal-ai/workspace` adds `maintenanceLockHolder`.
- b77865a: A service definition whose `readiness` broke the schema, such as one with no `timeoutMs`, a `timeoutMs` of 0, an unknown `type`, an `http` readiness with no `url`, a status out of range or an extra field, was refused with "input does not match the version-1 definition schema at readiness" and no next step. The refusal now names the field and the rule it breaks, such as "readiness.timeoutMs must be a whole number of milliseconds from 1 to 120000", without echoing the value, and its Next says to correct readiness and add the definition again.
- 8c019ae: A refusal in a project folder whose space is not the selected one now keeps the note under its
  `Mesh:` heading that says the selection applies outside the folder. In a folder prepared for its own
  space and not started yet, `who`, `send` and `ps` refused under a bare `Mesh: <space>` heading, so
  nothing said why the selected space was not the target.
- 985f634: Refusals that named no next step now carry a remedy, in the JSON envelope's `error.remedy` and under Next in the text report: an unknown or missing `config` key, a `config` value, space name or `--space` it refuses, `persona show` and `persona remove` for a persona that does not exist, `persona create` for one that does, `run validate` of a file that cannot be read, and `service show` or `service remove` of a definition that is not saved. The envelope reference now says that `remedy` is present when a refusal names a step.
- 2f4f747: A registry-only restore no longer leads to deleting the only copy of the history it left out. The restore journal now records the restore's selection. For a registry restore, `backup cleanup-fallback` refuses with `USAGE_INVALID` and deletes nothing unless `--discard-history` is given, and its `--dry-run` warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`. `backup restore --only registry`, or a restore of a registry-only artifact, adds a `HISTORY_NOT_RESTORED` warning saying that chat and DM history start empty, and its result names the `previousStore` that holds the only copy of that history. `up --restore --restore-only registry` prints the same two lines. The receipt's Next says that deleting that store needs `--discard-history`.
- 0abbc55: `auth retire`'s next step, `doctor`'s guidance for an unbounded credential and `reset space --dry-run` now say that rotating the space identity with `reset space` also removes the space's store, with its workflow runs, channel history and stored messages. The dry run and the apply's confirmation have the Store contents section `reset store --dry-run` has, and `--json` carries it as `storeContents`. Before, the next step named only the credentials it stops, and the dry run said only that it removes the stopped store.
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
- 4725a7f: A full restore of a backup made before the state it replaced was preserved now says that it left
  out the chat and DM history and workflow runs written after the backup, and keeps their only copy.
  Its receipt warns with `NEWER_HISTORY_NOT_RESTORED` and names the store it set aside. The
  `backup cleanup-fallback` preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`, and
  `backup cleanup-fallback` and `clean restore-fallback` delete that store only with
  `--discard-history`, as they do after a registry restore.
- 4dcdc62: A full restore of a backup made before the state it replaced was preserved now names each workflow
  run it rolled back, and each step that was answered after the backup and is open again, in its
  receipt, in `cotal status` and in the `backup cleanup-fallback` preview. It says that answer is
  only in the store the restore set aside. To read it, the restore copies that store and reads its
  run journals on one more isolated broker, through a new read-only maintenance login on the step
  journal stream.
- d5e1e1f: A `--creds` file whose key the space's account on this machine revokes is refused naming the revocation, such as `credentials rejected at <server>: the key <key> in <file> was revoked at <time> with auth revoke-credential`, with a Next that mints a new key with the grants the file held. Before, `send`, `history` and `who` said only "credentials rejected … check your creds". `cotal whoami --creds` reports `revokedAt`. A channel post refused for a `--creds` agent file names that file's own post grant, where before it said this machine cannot read the grant.
- 789de43: Cotal's own runtime Node is usable as an executable-endpoint handler after an older installer left
  its install group-writable under a umask of 0002. `cotal update`, run through the installer's
  launcher, and a new run of the installer remove group and other write from the folders and files
  you own in Cotal's install root, without following links. When every unsafe folder of a declared
  adapter path is inside that install, the refusal says so and names `cotal update` as the fix.
- 7e56bcd: Only a service instance record that is not valid JSON is refused with the `mv` that moves it aside.
  Any other saved record, such as a native install, uninstall or unit-action attempt or a supervisor
  receipt, keeps the plain `SCHEMA_INVALID` refusal with no step, since it can be what holds a native
  step back.
- d12f4bc: An operator command whose target is the selected space, or the space registered at its project's root, no
  longer probes every other recorded broker before it connects. An unrelated registration whose broker
  does not answer slowed `send`, `history`, `who`, `ps` and the other commands in the selected space by
  several seconds. A command that picks among the running meshes still probes them once.
- 6a9b881: `cotal send --file` refusals begin with the mesh the send was aimed at and end with a Next that keeps the destination, as a refusal after connecting does. A missing file says it does not exist. `connectSpace` names the space `connectOrThrow` would connect to from local records, without a probe or a dial.
- 4d577e6: A command that connects to a static-auth space whose stack folder was deleted while the stack ran,
  such as `send` or `history`, no longer says to restore the seed at that checkout. It says the
  folder is gone with its seed and names `cotal down --space <space> --yes`, the stop `status`
  already offers. Its JSON refusal now carries the space and folder as its target.
- df1abff: A command given `--server` and no `--space` no longer dials the brokers this machine records at
  other addresses before it dials the one `--server` names. Its liveness sweep now probes only the
  records at that address, the only ones its resolve reads, so `history`, `who`, `ps` and the other
  commands that resolve this way connect to the `--server` address alone. `status --server <address>`
  no longer checks the selected space's recorded address when `--server` names another, and that
  row reads `not checked`. `status --all` still checks all recorded addresses because that flag asks for them.
- d7bb55f: When `service` or `service logs` cannot read a service record folder, they now refuse
  `PERMISSION_DENIED`, exit 2, naming the folder and a safely quoted `chmod u+rwx <folder>` step.
  Previously they ended with an unconfirmed outcome and a raw permission error, without repair
  guidance. `status` keeps its partial result and warns with the same code. No permissions change
  automatically; write paths and other error classifications are unchanged.
- 8704be1: A service record folder that this account can read but not write, as the `chmod u+rx` of a read
  refusal leaves it, now refuses a write or a held record there, such as `service add` or
  `service start`, `PERMISSION_DENIED`, exit 2. The refusal names the folder and only the owner bits the
  write lacks, such as `chmod u+w <folder>`, and nothing is written. Before, these ended with an
  unconfirmed outcome and the raw permission error on a lock file, with no folder or step. The docs
  now say which reads name `chmod u+rx` and which name `chmod u+rwx`.
- 440ce81: `cotal service stop` and `restart` now signal the process group a background start leads and wait
  for the whole group to exit. A server that a shell backgrounded no longer outlives the stop and
  keeps the service's port. When a saved service's HTTP readiness address still answers while none
  of its instances runs, `service stop`, `service status`, `cotal service`, `cotal status` and
  `cotal down` print a `SERVICE_ADDRESS_HELD` warning naming the address and the process of this
  account that listens there.
- aa3ff60: A service or `cotal down` refused because the service root, registered space and broker do not resolve to one target now names what disagrees, such as the registered broker address and the one the stack runs on, and gives a next step: see the registration with `cotal space show <space>`. It used to name neither and carry no next step.
- 9c86a40: `cotal auth signer --out <file>` into a folder that does not exist no longer ends in a raw `ENOENT … lstat` with exit 3 and "Outcome unconfirmed". It refuses `TARGET_NOT_FOUND` before anything is written, names the folder, and gives `(umask 077 && mkdir -p <folder>)` as the next step, which makes every missing folder private. No folder is created for signing material.
- f2e0c06: `space add` and `meshes add` refusing a public address or a host name without required TLS now say the connection must require TLS and name the `tls://` form of the same address, or `wss://` for `ws://`, as the next step, instead of asking for the address itself. A user-auth space from a bundle whose broker does not answer now gets the same diagnosis as a `--server` one: a host name that does not resolve, a port that takes no connection, or a broker under another scheme.
- 73930b2: A space `cotal space add --force` registers without checking its broker now records that its mode was not checked. `cotal space`, `cotal space show` and `cotal status` show the mode as not checked, with `modeChecked: false` in `--json`, and `cotal whoami` reports a partial result with `MODE_NOT_CHECKED` instead of stating that the broker authenticates nothing.
- c63f6d8: `cotal space add --server <url>` with no broker answering at that address now says why, with a remedy. It says when nothing takes a connection at the port, and gives the port check as the remedy. When a broker answers at the same host and port under another scheme, such as `nats://` for a `tls://` address, it names that address, says when it has no TLS, and offers it as the next `--server`. It used to say only that no broker answered, with no remedy.
- 6682bcb: `space add --server` with `tls://`, `ws://` or `wss://` against a port that greets as a plain NATS
  broker now says the scheme failed and names the URL to register. It used to say that no broker
  answered, as it does for an address where nothing listens.
- d205ad2: A stopped controller project copied to another machine could never start there: `status` said to run `cotal space create <space> --root <copy>`, which refused because the folder was already the root of that space, and `up`, `down` and `clean all` said to use or move back to a folder that machine does not have. `cotal space create <space> --adopt` now takes over the copied stack journal: it rewrites it to name the new folder and the broker store under it, and records a stack that never ran there, so the next `cotal up` starts it from the copy with its store. It refuses, writing nothing, when the folder's `.cotal` is a link, when the recorded folder still holds the journal, when this machine records an instance of that stack, or when the space is prepared or registered here. Without `--adopt`, `space create` still refuses, and that refusal, `status` and the `up` refusal in a moved folder name the exact `--adopt` command.
- 531b374: When a space's streams are gone from a broker that still runs, `cotal status` says so and names the
  way back, and `send`, `history` and `run ps` refuse with that cause. On an open space that another
  machine deleted under a running stack, status showed the space as reachable, `send` exited 3 with
  "may have been stored", `history` reported an empty conversation and `run ps` printed a raw
  contract-store error. Status now shows `Space streams: not on the broker` and leads its Next with
  `cotal down --yes`, then `cotal up`, or with `cotal up` when the stack's other members are stopped.
  The three commands refuse `TARGET_UNAVAILABLE` with the same remedy.
- 88c64a0: The docs allowed space names of 1 to 200 characters, but every local file that carries a space spells its name twice over, and a file name holds at most 255 bytes. `space create` of a name longer than 116 characters failed with a raw `ENAMETOOLONG`, exit 3, and `cotal up` of a space named with more than 100 characters failed partway, with a delivery daemon that exited or a broker that was never defined and no cause recorded. A space name now holds at most 64 characters. `space create` and `cotal up --space` refuse a longer one with `USAGE_INVALID`, exit 1, naming the limit and its reason, before anything is written, and `cotal up` refuses a longer name an earlier release prepared the same way, naming `cotal space forget`. The `--max-file-store` docs no longer say a controller stack keeps the cap across `down --preserve-state`, which it refuses; it keeps the cap across `cotal down`.
- 83c2b1b: A managed spawn that a manager cannot run because it has no agent application installed is now
  refused with `DEPENDENCY_UNAVAILABLE`, as a spawn in this terminal is, whether it is pinned with
  `--on` or sent unpinned with `-d`. Both refusals name the manager and the host its status reports,
  and say to add the application where that manager runs, then restart it.
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
- ff650ba: A prepared space whose controller stack ran and was stopped read as "prepared but not started", the words for one that never ran. `status`, and every command that refuses a space that does not run, now says it is stopped, with its last operation and how it ended. When that stack recorded a file store cap below 67108865, `status` shows the cap in a `Store cap` row, and Next names `cotal up --max-file-store 67108865` or more instead of a bare `cotal up`, which would fail on that cap.
- a923eaa: On Linux, a broker on a loopback address whose process is stopped by a signal, such as SIGSTOP, is
  named with its pid instead of waited on. Once the first dial times out, the refusal names the pid
  and gives `kill -CONT <pid>`, without the longer confirm, so `run ps` returns in about 3 seconds
  instead of 35. `cotal status` shows the connection as `broker process <pid> is stopped` and offers
  the same command, and `down` refuses at once from the broker's recorded process state.
- b505ad6: A command run in a folder whose stack was stopped with `cotal down` no longer dials the default broker address `127.0.0.1:4222`. That `down` drops the folder's registration, and commands such as `send`, `history`, `ps` and `who` then fell back to the default address and presented the folder's credentials to whatever listened there. They now refuse with `TARGET_UNAVAILABLE`, naming the address the folder's last start configured, with the bare `cotal up` that starts it there again as the Next.
- 457d771: After `cotal down`, `space`, `space show` and `use` read the space as stopped, with its last operation, such as `cotal down, completed`, as `status` does. Before, they called it prepared and not started, and `space` said no space had been started yet. `space --json` adds `state` and `lastOperation` to each prepared entry, and `use --json` adds `preparedState` and `lastOperation`.
- 03858ae: A path refused because a symlink is in it, such as `cotal space create <name> --root <link>`, now names the physical path it resolves to as the remedy, `use the physical path <path>`, in place of the general advice to use a path without symlinks. The refusal itself stays.
- 73d6301: On a terminal, a command in a report's command list, and a command a sentence names in backticks
  after other words, from its `cotal` to its closing backtick, now wrap as one word, so a line copied
  from Verdict, Next or a warning is never part of a command. The Next of `space delete` for a prepared space, of
  `persona create` over an existing persona and of a `team boot` on a running stack name their
  commands in backticks. Before, `reset store <long name>
  --dry-run` at 80 columns printed `cotal reset store` on one line and the name on the next.
- 260ff6d: A command given a `--server` nothing answers at, such as `send` or `history`, now says that nothing
  answered at that address, and names the broker recorded for the space when the command runs from
  its root or with `--space`. It used to say the space's mesh was recorded there but not running and
  to run `cotal up`, which answered that the stack was already running, and in a folder with no space
  it named a `main` mesh recorded there that was never recorded. The recorded broker is still never
  dialed in its place.
- 8e35b7c: `cotal status` in a folder this account cannot read now says so, naming the folder and `chmod u+rx` on it, instead of reporting an unreadable `auth.json` that does not exist. A local record that cannot be opened for lack of permission names the folder that withholds it, so `cotal down --dry-run` there no longer says the record "could not be opened without following links".
- 5cb1819: The `chmod u+r` and `chmod u+rx` steps named for a saved local record this account cannot read, or
  for the folder that withholds it, quote the path when a shell would split it, as under a Cotal home
  whose path has spaces. They used to print it bare.
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
- d74686f: `cotal auth signer` now refuses `UNSUPPORTED` on a per-user-auth space, as `cotal auth mint` does, and writes nothing. It used to export the space's data-account signer there.
- 24769e9: A file saved as UTF-16, as Windows PowerShell 5.1 writes by default, is now refused by its encoding,
  with the step to save it as UTF-8. That covers a persona file in the catalog, in `persona show` and in
  `persona create --file`, a team manifest, a `.cotal/channels.json` or `--channels` file, and
  `preferences.json`. Before, each reported a generic invalid definition, schema shape or JSON error,
  with no word about the encoding.
- d407e4b: `cotal down` over an empty manager pidfile no longer warns that an older manager may have reaped its managed agents. No manager ran there and nothing was signalled. `verifyIdentityPin` now answers `no-pid` for a pidfile that is absent, empty or holds no pid, where it used to answer `legacy`, the verdict for a live record written before identity pinning. A pidfile it cannot read for any reason other than its absence now throws, naming the file.
- 89f14f2: A warning on stderr, such as the one that says a command targets the selected space instead of the folder's own, now wraps to the terminal at spaces like the report it precedes, instead of running past the terminal's width on one line.
- b6681bc: `cotal whoami --creds <file>` reports what a credential file may do: the space its permissions
  name, its profile, principal and agent lifecycle, when it was issued and when it expires, the
  channels it may read and post to, and whether it may read every DM, only its own, or none. It
  decodes the file's own claims and contacts no broker. No command showed this before: `whoami` had
  no `--creds`, and `auth handle inspect` refuses a credential file, whose Next now names
  `whoami --creds`.
- Updated dependencies [0d1dfc3]
- Updated dependencies [b0257f2]
- Updated dependencies [0c9e498]
- Updated dependencies [b58bf37]
- Updated dependencies [0af0377]
- Updated dependencies [9736397]
- Updated dependencies [0282994]
- Updated dependencies [dbbd7f5]
- Updated dependencies [66d2f93]
- Updated dependencies [c2503db]
- Updated dependencies [09d905f]
- Updated dependencies [30f0900]
- Updated dependencies [89d5637]
- Updated dependencies [75476c5]
- Updated dependencies [71e91d8]
- Updated dependencies [d4afe89]
- Updated dependencies [b6cfff1]
- Updated dependencies [b8304ce]
- Updated dependencies [71eeb1c]
- Updated dependencies [2343ae8]
- Updated dependencies [62c4874]
- Updated dependencies [b3f0edd]
- Updated dependencies [d38a3e0]
- Updated dependencies [66af07b]
- Updated dependencies [4dcdc62]
- Updated dependencies [e5ddaed]
- Updated dependencies [b3426bb]
- Updated dependencies [cc023f7]
- Updated dependencies [7aa9d14]
- Updated dependencies [531b374]
- Updated dependencies [48431ca]
- Updated dependencies [a8c3461]
- Updated dependencies [e16a6a5]
- Updated dependencies [d6f9f7a]
- Updated dependencies [d0d885a]
- Updated dependencies [447b7eb]
- Updated dependencies [bd52202]
- Updated dependencies [09dd488]
- Updated dependencies [24769e9]
- Updated dependencies [914b1f1]
- Updated dependencies [78a2035]
  - @cotal-ai/core@0.101.0

## 0.100.2

### Patch Changes

- bb4145f: `cotal telemetry <level>` now reports `ok` when the run creates the settings file, even at the default level. With no `telemetry.json`, `cotal telemetry regular` or `on`, also under `COTAL_TELEMETRY=minimal`, created the file and reported a `no-op`.
- Updated dependencies [8d81c12]
  - @cotal-ai/core@0.100.2

## 0.100.1

### Patch Changes

- Updated dependencies [8bb8900]
- Updated dependencies [546b661]
- Updated dependencies [b1d2cb5]
  - @cotal-ai/core@0.100.1

## 0.100.0

### Patch Changes

- 7e62dcf: A declared adapter path that other local writers could change is refused with every unsafe entry
  at once, the reason group write is not accepted, and the one `chmod` that fixes them. Before, the
  refusal named only the shallowest directory, with no reason and a Next that pointed at
  `cotal service`. An install made by `npm i -g` under umask 0002 left the bundled `nats-server` and
  each of its directories group-writable, so a controller `up` refused one directory per attempt.
- 0aa2ca7: `cotal service add` now says plainly when a declared adapter path crosses a symlink, such as `--handler /bin/sh` or `--handler /usr/bin/python3` for the `exec-endpoint` preset. It names the link and what it points to, and its Next names the physical path to use instead. The refusal used to report the symlink's own mode, 0777, as if group or others could write it, and a symlinked file was refused as `DEPENDENCY_UNAVAILABLE`. A symlink on any part of the path now refuses as `PERMISSION_DENIED`, because a link could be repointed after the check.
- 9eed6bc: Output is no longer colored on a terminal whose `TERM` is `dumb`, unless `FORCE_COLOR` asks for it,
  and `FORCE_COLOR` set to `false` in any letter case, such as `FALSE`, now turns color off as `false`
  does.
- f5424e1: `--creds` reads and checks its file before dialing. A missing, empty or malformed file (CRLF line
  endings, a truncated JWT, no seed block) and a directory are refused naming the file and the cause,
  instead of reporting a serving broker as unreachable or dumping the command's help. A file other
  accounts can read is still used, with a warning that names `chmod 600`.
- 3ec07a5: A command given `--creds <file>` and no `--server`, such as `cotal send` or `cotal history`, no longer presents that credential to the default address `nats://127.0.0.1:4222`. It goes to the broker the `--space` is registered at (`main` when no space is named), with that registration's TLS requirement. A space not registered here is refused with `TARGET_NOT_FOUND` before anything is dialed. Before, the registration was ignored and the credential was offered to whatever listened on the default port.
- a4e37f4: `COTAL_DEBUG=1` now prints a stack trace for a command that fails with a reported error, such as a failed `ep describe`, as docs/config.md says. It prints the failure's stack and then the stack of each error that caused it, so an endpoint call's underlying error, for example `no describe reply ... within 10000ms`, is visible. It used to print nothing for these failures. The JSON envelope is unchanged.
- 72c4595: `backup cleanup-fallback` now retires the journal of a restore made with `--accept-missing-source`.
  That restore replaced a missing source and keeps no old store, so cleanup refused with an unknown
  outcome, every other recovery route refused too, and the root could never start another backup
  cycle. Its plan, prompt and receipt now say that nothing is removed, and `clean restore-fallback`
  does the same.
- 869d26f: A controller stack no longer stays blocked after a `cotal down` exits partway through a member's stop, for example because it was killed or its terminal closed. A manager stop that the dead `down` had not yet handed to the manager is settled by the next bare `up` or `down`, and the stop reservation that `down` left is released once its pid has exited. A reservation held by a live process is refused with that pid named. A broker or delivery daemon that the dead `down` left `stopping` is named in the refusal with `cotal down --abandon-stop <request-id> --yes`, which now takes that stop once the process is gone. Before, every `up`, `down`, `--abandon-stop` and `service stop` refused.
- 2c21df1: `cotal down` of a controller stack keeps a selection that names its space. The stopped space stays prepared at its root, so the next command run without `--space` refuses with `TARGET_UNAVAILABLE` and names the root to start it in, as the docs describe. It used to clear the selection, so that command quietly ran against another running space.
- ba5a685: A paired endpoint caller file from `cotal auth mint <name> --endpoint <class> --out <file>` now works with `ep describe`, `ep invoke` and `invoke` under `--creds <file>`. The mint recorded the endpoint's wire token in `<file>.issuance.json`, and reading that intent back refused the token, so every such call failed with "the endpoint contract read did not complete" before any request was sent. The intent now keeps the dotted endpoint name. An intent written by an earlier release is refused with `SCHEMA_INVALID` and a remedy to issue a new caller.
- c8550cc: `config`, `config get` and `status` now warn with `PREFERENCE_INVALID` when a variable such as
  `COTAL_DETACH_KEY`, `COTAL_DEFAULT_AGENT` or `COTAL_DEFAULT_PERSONA` holds a value `config set`
  refuses, naming the variable and the reason. The variable still wins.
- ac5a105: A command such as `cotal channel` run in the folder of a forgotten prepared space, with no broker at the default address, now says that no space is registered or prepared for that folder and names `cotal space create <name> --root <root>`. It used to say that mesh `main` was recorded there on 127.0.0.1:4222 and to run `cotal up` to restart it, though nothing recorded `main` there.
- d235fb0: After `space forget` on a stopped controller stack, `status` and every command in that root now say
  to prepare the space again with `cotal space create <space> --root <root>` before `cotal up`. Before,
  they said to run `cotal up`, which refuses there until the space is prepared again.
- 0e729b5: A broker that accepts the connection and never answers, as a stopped or overloaded one does, is no longer reported as not running, and `status` no longer hangs on it. `ps`, `who`, `send` and `history` refused such a broker with "no mesh running at <url>; ... recorded at <root> but not running". They now say it "accepted the connection but is not answering", keep the registry entry, and name checking that the broker is not stopped or overloaded. `cotal meshes add` and a raw `--server` connect use the same wording. `status` printed its report and then never exited, because its manager service probe dialed the broker without first reading its greeting and the client library left that socket open. `status` and `status --components` now read the greeting first, report the manager service as unchecked or refused, and exit.
- 28f3ca0: A `backup create` stopped by Ctrl-C now says what it left and how to clear it, and the claim it leaves no longer locks the cut for 30 minutes. Interrupted after it claims the cut, it exits 130 (143 for SIGTERM, 129 for SIGHUP) and prints its attempt id, the partial artifact and `cotal backup recover <attempt> --yes`. `backup recover` now takes a create's `backup-<uuid>` as well as a restore's id. Once the backup process and the broker it started are proven gone, which takes seconds, it removes the partial artifact, the clone and the broker files, each matched by inode, and returns the cut to ready. A create to another directory does the same first. While the claim is live, `up`, another create and `backup recover` refuse `LIFECYCLE_BLOCKED` (exit 2) and name the backup process and the deadline, where `up` used to say "follow the recorded recovery" without naming one and a new create exited 3. `cotal status` shows the create's own attempt and its next step. A create naming the partial artifact refuses `CONFLICT` and names the recovery, and `backup verify` or `backup inspect` on a directory with no `manifest.json` calls it an incomplete artifact.
- 73cd25b: A `backup restore` (or `up --restore`) stopped by Ctrl-C no longer locks its root for 30 minutes without saying so. Interrupted inside its pre-commit window, it now exits 130 (143 for SIGTERM, 129 for SIGHUP) and prints its attempt id and `cotal backup recover <attempt> --yes`. The claim it leaves is stale as soon as its restore process and every broker it started are proven gone on this host, which takes seconds because each broker's watchdog stops it when the restore process exits. So that recovery, `clean restore-attempt`, or a rerun of the restore rolls it back at once. The 30-minute deadline still applies when a broker cannot be proven gone. While the claim is live, `up`, a repeated restore and `backup recover` refuse `LIFECYCLE_BLOCKED` (exit 2) and name the restore process and the deadline, rather than exiting 3 with an unknown outcome. A restore or recovery that finds the root's maintenance lock held names the pid holding it. The status and receipt hints now say `--yes`, which the apply needs, and `status` no longer offers `clean store --force` while a maintenance journal holds the store.
- cdceff6: Under a locale whose character set is not UTF-8, such as `LANG=C`, `POSIX` or ISO-8859-1, reports,
  refusals and usage errors now write their marks and punctuation in ASCII, as `--plain` does, and
  keep their color. With no locale variable set, the marks stay UTF-8.
- 773e6d3: A managed verb such as `cotal ps`, `stop`, `attach` or `spawn` that cannot choose between several of your live managers now shows the choice. It used to refuse with only the instance ids inside one sentence. It now lists each manager on its own row with its instance id, host, activity (which names its runtime) and the time its process started, and its Next gives your own command again with `--on <instanceId>` for each one. The code and the exit code stay as they were, and `--json` carries the rows under `error.cause.detail.managers`.
- 42d9ea1: `cotal auth mint --expires-at` refuses a time that is not in the future, before anything is written. It used to write a credential the broker already refused, under a label that was then taken, and `doctor auth` reported it as expired.
- 152e236: `cotal persona --server <address>` with an address that no registered space uses no longer turns the current folder into a catalog. Outside a project it listed an empty catalog for a space named `main`, and `persona create` wrote `.cotal/agents/<name>.md` into whatever folder you were in. It now refuses with `TARGET_NOT_FOUND` and writes nothing. In a project it still reads that folder's catalog, as launch does. `@cotal-ai/workspace` exports `isGenuineSpace` for this check.
- afb587c: `config set` and `config unset` in a preferences folder you cannot write are now refused with
  `PERMISSION_DENIED`, exit 2, naming the folder and how to make it writable. Before, they reported
  a raw `EACCES` as an unknown outcome, exit 3, although nothing had changed.
- ca4ce70: A `preferences.json` that is a symbolic link is now refused, naming its target, as a private
  record's link is. `config set` used to replace the link with a regular file while the file it named
  kept the old value.
- b9ddce8: A selected prepared space whose project folder was deleted now says the folder no longer exists and
  names `cotal space forget <space>`. Before, `use`, `status`, `ps` and `up --space` said to start it
  with `cotal up` in the missing folder, `persona` refused with no path or remedy, and `space forget`
  said the files under that folder were kept.
- af26abf: A command that targets the selected space from inside a project whose root has a different
  registered space now says so before it acts. It warns on stderr and in its JSON `warnings` with
  `SELECTION_NOT_FOLDER_SPACE`, naming both spaces and the `--space` that targets the folder's space.
  `send`, `status`, `who`, `ps`, `whoami`, `endpoints` and a named `down <service>` used to act on the
  selection there with only a `Mesh:` header to show it.
- 85213b4: `cotal space forget` now removes the per-space preferences saved under the name it forgets, so a later space with the same name no longer inherits them. The receipt lists each removed key and value with the `config set` that restores one. The removal takes the preferences file's lock and revision check; when it fails after the record is gone, the run is partial and names the `config unset` that finishes it.
- 4f58a3c: When a root's controller stack runs under another `COTAL_HOME`, `status` and `up` now say so, name the
  Cotal home in use and tell the operator to run with the one the stack was started under. `status`
  said to start the stack with `cotal up`, and `up` refused its own members as legacy pidfile-owned
  processes with no next step.
- 0caaa99: `cotal status` in the folder of a forgotten prepared space now names `cotal space create <name> --root <root>` as the next step. It used to name a bare `cotal up`, which started the default space `main` there and then blocked preparing the forgotten space in that folder again.
- d29311b: A refusal of a mesh target now names the space and root it concerns under `target` in `--json`, where they are known. A stopped space's `ps`, `who`, `whoami`, `endpoints` and `history` refusals carried `"target": null` although the message named the space, so a script had to parse the message to tell which space refused.
- 28a9e11: `cotal up` now refuses a project root that other local accounts can write, with the same check `space create` applies, before it writes anything. In a group-writable folder on a host without a private-group proof, such as one whose `/etc/nsswitch.conf` names `sss`, `space create` refused but `up` started a legacy `main` stack, and bare `down` then refused "the additive attempt inventory could not be read" with no cause and no next step. The refusal from every command that checks a path now names every unsafe entry in its chain at once, with one remedy such as `chmod g-w <project> <parent>`. Bare `down` and `status` also name that cause for a stack an earlier release started there.
- Updated dependencies [a78af23]
- Updated dependencies [f5424e1]
- Updated dependencies [0e729b5]
- Updated dependencies [0934f70]
- Updated dependencies [8360fbf]
- Updated dependencies [f0aebea]
- Updated dependencies [047b289]
- Updated dependencies [b24190d]
- Updated dependencies [6471d27]
- Updated dependencies [b079d7d]
- Updated dependencies [9234229]
  - @cotal-ai/core@0.100.0

## 0.99.3

### Patch Changes

- 15effd7: An invalid `preferences.json` no longer stops `cotal help`, `cotal --help` or `cotal completion`. The docs say such a file stops every command except help and shell completion, but both exited 1 with `SCHEMA_INVALID`, so a person with a broken file could not read the help. Every other command still refuses. The refusal's next step now reads "fix or remove <path>; nothing resets it".
- Updated dependencies [96325dc]
  - @cotal-ai/core@0.99.3

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
- Updated dependencies [74a688d]
  - @cotal-ai/core@0.99.2

## 0.99.1

### Patch Changes

- 1708ce5: Create a missing Cotal config directory with mode 0700 from every writer, not only the extension
  writer. Under a group-writable umask, `config set`, the seed store and lock files made it 0775, and
  `completion` and `ext seed` then refused the directory cotal had just created. A completion file
  that cannot be read now names why instead of a bare PERMISSION_DENIED.
- Updated dependencies [1708ce5]
- Updated dependencies [50de78d]
  - @cotal-ai/core@0.99.1

## 0.99.0

### Minor Changes

- 6999190: Telemetry counts a person once. The settings file with the install id now lives in the OS user's own Cotal directory (`~/.cotal/telemetry.json`, or `%LOCALAPPDATA%\Cotal` on Windows), which `COTAL_HOME` no longer redirects, so every workspace one person runs under their own account reports the same install id instead of a new one per `COTAL_HOME`. At `regular`, the `command` and `install` events carry a new `account` field: a sha256 hash of the IdP URL and subject id of the home's cached sign-in, cut to 32 hex characters, so one person on several machines counts once; the id itself is never sent, and the field is `null` without a sign-in. `cotal telemetry` reports the hash. A level set earlier in a `COTAL_HOME` file is not read any more; set it again with `cotal telemetry <level>`.

### Patch Changes

- 8aac50d: `cotal attach` keeps reconnecting when the user-auth service does not answer its base bearer exchange, as it already did for the manager-caller exchange and an unreachable broker. The base exchange's failure was classified as a permanent refusal, so a reconnect that reached a slow or restarting auth service exited with `the user-auth service ... did not answer` instead of trying again. A first attach still exits on it, and a refused base exchange or a sign-out still ends a reconnect.
- @cotal-ai/core@0.99.0

## 0.98.0

### Patch Changes

- Updated dependencies [b6e3fba]
- Updated dependencies [c445511]
  - @cotal-ai/core@0.98.0

## 0.97.1

### Patch Changes

- Updated dependencies [aa8d11e]
  - @cotal-ai/core@0.97.1

## 0.97.0

### Minor Changes

- 1321eb8: Own-broker service caller issuance. `cotal up` retains the system-account signing seed in the root's secret store, beside the seed-free trust record, at space creation and at `--rotate-sys` (the successor's seed replaces the retired account's). An auth service started with `--service-endpoints` composes the caller payload bootstrap from that record when it names the trust record's system account and the seed derives it: each bootstrap mints one 60 s VARZ-only observer credential, and the seed never leaves the broker-owning auth service process; the machine daemon, participant clients, connectors, bundles and sandboxes never hold it. A root with no retained seed opens the engine and door without caller issuance and says why; a record for another account refuses the start. `@cotal-ai/workspace` exports `retainSystemSigningSeed`, `readSystemSigningSeed` and `systemSigningSeedKey`.

### Patch Changes

- Updated dependencies [624e71f]
- Updated dependencies [ec7dbfc]
- Updated dependencies [352bbe7]
- Updated dependencies [030fba8]
- Updated dependencies [9c193e5]
- Updated dependencies [d03c223]
- Updated dependencies [a5b5731]
  - @cotal-ai/core@0.97.0

## 0.96.1

### Patch Changes

- @cotal-ai/core@0.96.1

## 0.96.0

### Patch Changes

- Updated dependencies [083205e]
  - @cotal-ai/core@0.96.0

## 0.95.2

### Patch Changes

- @cotal-ai/core@0.95.2

## 0.95.1

### Patch Changes

- @cotal-ai/core@0.95.1

## 0.95.0

### Minor Changes

- b7acdcc: Add anonymous, opt-out usage telemetry to the `cotal` CLI. Each command sends one small event as it exits (command name, outcome, exit code, duration, version, OS, architecture, Node major, CI flag; at the default `regular` level also the registered subcommand, flag names, the typed error code, whether stdout is a terminal, the shell and terminal program names, plus one install summary per UTC day). It never sends arguments, flag values, paths, mesh, space, agent or user names, environment values, error text or message content. `cotal telemetry` shows the level in force, its source, the random install id and the intake URL; `cotal telemetry off|minimal|regular` sets it. `DO_NOT_TRACK=1` and `COTAL_TELEMETRY_DISABLED=1` force it off, `COTAL_TELEMETRY` names a level, and `COTAL_TELEMETRY_URL` points a self-hosted intake. A one-time notice prints on the first interactive run. The settings live in `<home>/telemetry.json`; `@cotal-ai/workspace` gains its reader and writers.

### Patch Changes

- @cotal-ai/core@0.95.0

## 0.94.7

### Patch Changes

- @cotal-ai/core@0.94.7

## 0.94.6

### Patch Changes

- ba9155a: A controller stack whose manager stop has no terminal receipt can be unblocked. When a manager is killed before it answers a stop request, every later bare `up` and `down` refused `LIFECYCLE_BLOCKED` and no command cleared it. `cotal down --abandon-stop <request-id> --yes` now abandons that request once the manager and the `down` that sent it have both exited: it removes the request, the stop reservation and any `--with-agents` shutdown intent that stop armed, records the manager `failed`, and stops the rest of the stack with a `STOP_ABANDONED` warning, because whether the manager stopped its agents' seats is not confirmed. The refusal's remedy names the command with its request ID.
- Updated dependencies [520c66b]
  - @cotal-ai/core@0.94.6

## 0.94.5

### Patch Changes

- 4b64fe7: A manager that refuses a stop request after `cotal down` stopped waiting no longer blocks the stack. The manager refuses because the `down` that published the request has exited, and it keeps running. The next bare `up` or `down` now reads that `refused` receipt, removes the request, releases the stop reservation and returns the manager's record to `running`. `down` then stops the manager, and `up` reuses it.
- @cotal-ai/core@0.94.5

## 0.94.4

### Patch Changes

- 464413c: A manager stop that completes after `cotal down` stopped waiting no longer blocks the stack. The next bare `up` or `down` reads the stop's own receipts, records the manager `stopped` when it recorded the stop completed and its process is gone, releases the stop reservation, and continues. A stop with no completed receipt still refuses `LIFECYCLE_BLOCKED`.
- @cotal-ai/core@0.94.4

## 0.94.3

### Patch Changes

- @cotal-ai/core@0.94.3

## 0.94.2

### Patch Changes

- @cotal-ai/core@0.94.2

## 0.94.1

### Patch Changes

- @cotal-ai/core@0.94.1

## 0.94.0

### Patch Changes

- Updated dependencies [1caaf63]
  - @cotal-ai/core@0.94.0

## 0.93.0

### Patch Changes

- Updated dependencies [e27c44c]
- Updated dependencies [69b0538]
- Updated dependencies [6703917]
  - @cotal-ai/core@0.93.0

## 0.92.2

### Patch Changes

- Updated dependencies [43a5715]
- Updated dependencies [736207e]
  - @cotal-ai/core@0.92.2

## 0.92.1

### Patch Changes

- 5a0b741: A broker probe now reports `auth-required` when the broker's greeting asked for auth and the connection was then reset during the handshake. On Windows that reset can discard the broker's authorization error, so `cotal who` against a running auth broker with credentials it rejects said the mesh was not up and suggested unregistering it. The verdict is marked as inferred: it changes the message, but it never removes a registry record and does not verify a `cotal meshes add` registration.
- Updated dependencies [5a0b741]
  - @cotal-ai/core@0.92.1

## 0.92.0

### Minor Changes

- 88cc5a1: A Linear account with no record now refuses with `TARGET_NOT_FOUND` and the `cotal linear account add` route, in `linear account show` and when a `linear` service starts. The service refuses in its launch plan, so no child is started and no failed process exit is reported. A record that exists but cannot be read is still `DEPENDENCY_UNAVAILABLE`. The service checks the account in the Cotal home of the process that starts it, and refuses with `UNSUPPORTED` before a child when `COTAL_HOME` is unset and the definition's `envRefs` set `HOME` (on Windows, `LOCALAPPDATA` or `USERPROFILE`), because the child could read another home. A service adapter's launch hook now receives the definition's `envRefs` names, never their values. The endpoint name is checked when the service starts.

  `cotal update --check` and the version read in `cotal update` run npm with a temporary cache that is removed afterwards, no log files and no npm update notifier, so they leave nothing in npm's cache, log directory or notifier stamp. From a source checkout, the `update --self` hint says it installs a separate global copy.

  `service add --preset` offers no `--no-<option>` flag for a boolean option whose schema admits only true, so the web preset no longer lists `--no-read-only`. An absent `web` preset names `cotal ext add @cotal-ai/web` in its remedy. A background `service start` ends with the `service logs` command for the new instance. Re-adding an existing definition names the remove-and-add route, and an `ext remove` blocked by service instances names each one. A managed dashboard logs an endpoint error or warning by its class, the error's name and code, and never its message.

### Patch Changes

- 88cc5a1: Fix the backup and restore journey. A full restore now starts: the delivery daemon binds the fanout and reader durables a restore recreates at their recorded start sequence, and still refuses a durable that differs in any other setting. When a delivery daemon that `up` launched exits, the error quotes the failure the daemon logged and no longer blames a lost lease, and a failure on a root that holds a restore or preserved cut never suggests `clean store`. A restore with no preserved cut refuses before it takes the maintenance lock and leaves no state, and `up --restore` refuses the same way instead of reporting an unknown outcome. `up` refuses to take over a space name whose root holds a maintenance journal, whose root or journal cannot be read, or whose recorded root is not an absolute path, and says when it takes over another root's dead registration. A recorded root matches only by the folder it resolves to on disk, so a path that names this root only as text, through a link behind an unreadable folder, keeps its name. A root counts as gone only when it no longer exists or is not a directory, and a readable root with no maintenance journal also gives up its name. These refusals end `refused` with exit 2 on both the controller stack and the retained launcher, with the reason and the next step, where they used to end as an unknown outcome with exit 3. Restore failures, `cotal status` and the recover and cleanup refusals show the `restore-<uuid>` attempt id and the next step for its state. A detached `up` from the machine home names `cotal down --preserve-state`, which is the stop that works there. `backup create` refuses before any claim with the reason and next step, and a destination that already exists is a `CONFLICT` refusal. `backup verify` names the file that is missing, undeclared or does not match its declared size and SHA-256.
- 88cc5a1: Settle a crashed or failed controller stack from process evidence instead of wedging its root. A bare `up` or `down` now takes the root's maintenance lock, records a member whose pid and start time are gone as failed, settles an earlier `up` or `down` that never recorded its outcome, and continues with an `OPERATION_SETTLED` warning. A live member is kept; a member whose process cannot be established, or one with an unconfirmed stop, refuses `LIFECYCLE_BLOCKED` with the exact `service status` command. Another holder of the lock is a known refusal that names its pid.

  A manager stop that was published and never confirmed keeps its record `stopping` under that request, also after the process exits. After a `down` that ends this way, the next bare `up` or `down` refuses it and names the instance and the request. `service start`, `restart`, `stop` and `remove` refuse it too, a start before any readiness probe or record write, and its exit is never settled as a crash, also when an earlier release left the record `unknown`. A request file that does not read as its launch's own is reported as an unknown publication. An `up` that redefines a member journals the replacement's instance and launch request before it retires the old instance, and the new definition's revision before the launch, so the next bare `up` or `down` after an interrupted redefinition adopts that replacement and refuses any other record.

  `down` is idempotent: a member already gone is recorded as stopped without loading its adapter or credential. `down --dry-run` exits 0 and lists members in stop order. When the manager is live but the broker is not, `down` refuses before any stop and names `cotal up --space <space>`, from a managed seat's shell too. A foreground `up` releases its terminal when another command stops the stack.

  A first `up` binds the recorded broker address before launching, and a busy port refuses `CONFLICT` naming the address and bind error. A member that exits before readiness is recorded as failed with its exit code and log command. `space create` prepares a controller root again after a completed stop and `space forget`, so the remedy a refused `up` names works.

  `ps` on a `--no-manager` stack refuses with a plain message. `status` shows a controller stack's members instead of legacy process rows and offers `cotal up --root <root>` when the stack does not answer. A legacy component name on a controller stack names its `stack-` member. The broker stop refusal names its dependants. `reset space` names the path that fails its scope check, and its receipt lists each path once. The manager's delivery-aware marker is written owner-only whatever the umask, never through a symlink and only into a file the user owns.

- 88cc5a1: Show the identity provider's reason when it refuses an elevated view. On a user-auth mesh, `history clear` without scope `admin` and a legacy `team remove --dry-run` whose deployer view is refused still fail with `PERMISSION_DENIED`, and their remedy is now the provider's sentence: the view, the scope the grant lacks and the whole-row re-grant that adds it.
- 239d1c7: Run `cotal down` again in a folder whose stack is already stopped, and it says so instead of refusing.

  - A second bare `cotal down` reports that the folder's stack is not running and names `cotal up`, with outcome `no-op` and exit 0. It needs no `--yes` and writes nothing. `--dry-run`, `--json` and `--plain` show the same. A controller stack counts as stopped after its own completed `down`, with no member or other service instance of its space running. That check reads no process record under the root; those are read only as the next bullets describe. A legacy root counts as stopped when no registration or top-level `*.pid` record remains and it still holds the broker configuration a start rendered there, or a space prepared there.
  - Without that evidence a legacy root still refuses, now with one next step: `TARGET_NOT_FOUND` when nothing shows a stack there, `CONFLICT` naming the spaces when several registrations name the root, and `CONFLICT` pointing to `cotal status` when a process record remains with no registration.
  - Before it reports the no-op, `down` reads every record a local-process descriptor names under the root, an installed extension's included, at any path under `.cotal` and for any space a record's name holds. One whose process may still run, that cannot be read or attributed, or whose space part decodes to no space refuses `LIFECYCLE_BLOCKED`. Nothing outside the root's `.cotal` is read: a link on a record's path refuses at the link, unread, as does a record that is not a regular file, is larger than a process record, cannot be opened, or changes while it is read. Each is named once, where reading stopped. A template whose `{space}` normalizes away is read as the one path it names. The refusal names each record with its path and pid, and its next step lists the pids and paths to check. Nothing is stopped, adopted or removed.
  - `--with-agents` on a stopped stack refuses `LIFECYCLE_BLOCKED` and says to start it first. Its preview, `cotal down --dry-run --with-agents`, shows the no-op.
  - Outside a terminal, a bare `down` that would stop a running controller stack still requires `--yes`. The refusal is now one line and its remedy, without the command help.

- c935e28: On a user-auth mesh with more than one live manager, an unpinned `cotal models`, `cotal run ps` or other manager call is now reported as refused, exit 2, naming each live manager and `--on`. Before, the same refusal from the auth service was reported as "Outcome unconfirmed" with `OPERATION_UNKNOWN` and exit 3, although nothing had been requested. A manager-caller exchange that does not answer is likewise refused with `DEPENDENCY_UNAVAILABLE`, exit 2. `cotal attach` still retries a failed manager-caller exchange on a reconnect, and now stops when the exchange reports the operator signed out.
- 03d9e7b: Remove a space's renewal record when its per-space material is reaped.
- Updated dependencies [88cc5a1]
- Updated dependencies [88cc5a1]
- Updated dependencies [1db940e]
- Updated dependencies [f276a46]
- Updated dependencies [588a5a7]
- Updated dependencies [b3441b1]
  - @cotal-ai/core@0.92.0

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

- 5c85ef3: Record a `process-exit` receipt on a service instance that a generic stop signalled and saw exit. Stack journals accept `preserve` and `resume` operations bound to one maintenance attempt. Restore listener proofs gain a controller variant tied to one broker instance, launch request and pinned process; both bind paths refuse it until controller custody is recorded. Service adapters gain a typed, closed launch-attempt context that no adapter reads yet. Older readers refuse records that carry the new fields.
- 5c85ef3: Maintenance journals can now record controller custody: the cut's original members and their per-role stop receipts, preserved-exit stop attempts, the resume's started members, a private commit-token handoff record (path, inode and digest, never the token), and an alternate-target restore's broker reconfiguration. The readers are closed, so each new field must match the cut's custody. Listener proofs bind only in the variant that matches custody, and a controller proof also needs a live running check from the caller. Stack resume reports `process-exit` evidence when a member carries its own stop receipt. Older readers refuse journals that carry these fields.
- 5c85ef3: `down --preserve-state`, bare `up`, `backup restore` and `up --restore` gain a controller-owned route, described below. This release refuses that preserve, backup and restore before any effect; the route returns in a later release.

  The preserve first runs the scope check bare `down` runs, so another live service instance in the space, a legacy pidfile process or a shared broker address refuses before any effect, and a retry of a committed cut checks again before any further stop. It then proves, with no effect, that the stack's manager instance serves the preserved-exit stop contract; an older manager refuses before any stop. It stops the manager with a preserved-exit request that retains its agents, then auth and the broker, and records each member's own stop receipt in the cut. A preserved manager, and one launched for a resume that has not committed, still answers `status` as a counted read, so the preview and resume readiness can attribute it.

  Bare `up` resumes a ready cut through its recorded members. Each start is journaled before it is made, a member whose earlier launch is unproven holds, and after the manager commits only the manager starts again, once its exit is receipted, with the commit token as a protected file.

  A controller restore keeps the broker definition for the preserved store's own path. For another `--store-dir` it journals and then writes an attempt-owned broker configuration and points the definition at it; the broker starts as a new journaled instance and the cut's old broker record is removed once the restore is active. Rollback returns the definition to the original configuration as a new revision before the store, and any unattributed revision holds. Backup and restore also require the broker configuration to match the cut launch's recorded digest. A settled active controller restore no longer fences controller `down` or `up`, including `up --no-manager`, or the broker and manager services; `down` and `up` name it in their receipts. While any other maintenance journal is held, the manager service launches only a resume or restore attempt's own journaled manager start, as the broker service does, and a broker or manager `service restart` whose start would be refused refuses before it stops anything. `down --preserve-state` and `team boot` still refuse an active restore and now say why: a new cut needs the restore journal retired with `backup cleanup-fallback`, and a team boot never resumes a stack whose manager already ran.

  On a controller root, backup, reset store and reset space count a stack member as running unless its process is gone with its own stop receipt. `@cotal-ai/core` exports `brokerJetStreamBlock`.

- 5c85ef3: Bare `cotal ext` (and `ext list`) writes one structured document with `--json` and a plain report with `--plain`: `result.root` is the install prefix and `result.items` the installed extensions. This replaces one JSON line per extension. `--json` and `--plain` on the other `ext` subcommands are refused with `USAGE_INVALID`, and `ext root` stays a raw path.

  A subcommand can declare its own structured outputs (`Subcommand.outputs` in `@cotal-ai/core`). The kernel reports a form by the 0 to 5 exit table only when that form declares a JSON output, and help prints each form's own `structured output` line, so `ext add`, `ext remove` and `ext seed` keep exiting 1 on any failure.

  Add `cotal docs [<page>]`, the installed version's own protocol and CLI docs, offline: bare `docs` lists the pages, a page prints its Markdown, `--search <query>` shows the best-matching sections, and `--refresh` also tries the version-pinned copy on docs.cotal.ai and says which copy it served. `@cotal-ai/connector-core` exports the docs reads it uses (`docsIndex`, `readDocsPage`, `searchDocs`, `capSection`) through a new `./docs` subpath, so the bundle loads only when `docs` runs.

- 5c85ef3: Deprecate the daemon entries `supervise`, `deliver`, `auth-service` and `feedback-intake`. Each keeps its existing flags for units, scripts and containers written for earlier releases, help and completion no longer list them, and every run prints one stderr line naming its service preset (`manager`, `delivery`, `auth-service`, `feedback-intake`) and the release that removes it, `1.0.0` for all four. `deliver pending` warns the same way and names `cotal pending <agent>`. Stdout, behavior and exit codes are unchanged. The top-level `feedback-intake` entry runs again with its existing flags instead of refusing. `up` now starts its manager, delivery daemon and auth service through hidden twins of `supervise`, `deliver` and `auth-service` with the same flags and runner and no warning, so only a unit, script or container someone can change prints it. The process checks that recognise a running manager or delivery daemon accept the twins' command lines too.

  Background `cotal up` that is the main process of a systemd unit now names that unit and the `--foreground` remedy on every route it takes, including the controller-owned stack and a refresh of a running stack. It still changes no mode and no unit. A foreground run, a dry run and `up -f` print nothing.

  The `solo` container in `deploy/` runs `spawn scout --foreground`. `docs/UPGRADING.md` gains the persisted-caller section: the command mapping, the deprecated entries and their removal release, the literal `up --foreground` replacement for systemd and launchd callers, the owned-unit and downgrade notes, and the container change.

- 5c85ef3: The manager contract moves to revision 33. While preserved, `status.stopImpact` reports the preservation attempt and inventory digest. A preserved-exit stop request names that binding with `withAgents: false`, and the manager accepts it only when fully preserved and quiescent, returning `preserved-exit-returned`. The open-space local receipt keeps its earlier shape. Each serving manager child writes a protected served-contract file before its serving receipt, so a controller can prove which contract that exact instance serves. New launches pass the resume commit token as a protected file named by path and digest; the deprecated `supervise --resume-commit-token` input stays accepted. The native manager child takes only the file form. The broker service admits the maintenance work a controller-custody attempt records, and a controller resume names its broker with `--name`. Core exports `recompileContractClosure`.
- 5c85ef3: Native service stop requests, previews and results can carry a preserved-exit binding (the maintenance attempt and inventory digest) for an agent-retaining manager stop. A preserved request requires `withAgents: false`, its receipts are read against the same key list, and the controller accepts `preserved-exit-returned` only for a preserved request and `returned` only for an ordinary one. No command submits a preserved stop yet, and ordinary stops are unchanged.
- 5c85ef3: `cotal ps`, `cotal models` and `cotal runtimes` write one structured document with `--json` and a plain report with `--plain`, and exit by the structured outcome table. A read that could not read part of what it was asked for, such as a manager that did not answer a census, is `partial` and exits 4, with a warning naming each part it could not read. A mesh a structured command cannot resolve or reach is refused before any request with a stable code (`TARGET_NOT_FOUND`, `TARGET_UNAVAILABLE`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `DEPENDENCY_UNAVAILABLE` and others) and exits 2, and under `--json` that refusal is one envelope. The user-auth provider names why it could not issue credentials (signed out, service unavailable, refused), so that refusal carries the right code. `cotal version --json` with an unreadable extensions manifest is now `partial` and exits 4. A connector's `listModels` can return `unavailable` with a reason when its install has no catalog to list; the manager then reports it `supported: false` instead of a failed read, and OpenCode 2.x does so instead of failing `cotal models`. An installed connector the manager cannot load makes `cotal models` partial with its load error, and a home folder reached through a symlink is no longer read as a project with a stopped mesh.

  Breaking: `cotal ps --json` writes one envelope whose `result.items` are the manager rows, instead of one row per line. An incomplete manager census exits 4 instead of 1, and a mesh `ps` or `models` cannot reach exits 2 instead of 1. The human reports of `ps`, `models` and `runtimes` are tables, and `ps --wide` prints one record per seat. See the upgrade notes.

- 5c85ef3: Read commands no longer install or refresh the built-in connectors and the web dashboard before they run. A command or subcommand declares that it only reads with `reads` (a new optional field on `Command` and `Subcommand` in `@cotal-ai/core`), and the dispatcher skips the seed for it: `status`, `ps`, `who`, `whoami`, `models`, `runtimes`, `history`, `docs`, `endpoints`, `describe`, bare `space` and `space show`, bare `config` and `config get`, and bare `ext`, `ext list` and `ext root`. Installed extension commands keep the declaration through caching and lazy dispatch, including bare reads. Every other command still seeds first, so the first such command after an upgrade refreshes what is installed. The CLI never imports a built-in installed at another version than its own; it names the package and `cotal ext seed` instead. On a fresh machine `status` points at `cotal setup` for the connectors.

  Breaking: a read run right after an install, such as `cotal ext list`, no longer installs the built-ins. Run `cotal ext seed`, `cotal setup` or any command that is not a read. See the upgrade notes.

- 5c85ef3: `cotal setup` takes four inputs: the destination (`--destination local|self-hosted`), the application (`--harness`), the project folder (`--project`) and the space (`--space`). On a terminal it asks for each one no flag gave, shows the answers before it writes, and offers Save, Change and Cancel; Cloud is listed as in development and cannot be chosen. Without a terminal, or with `--yes`, `--no-input` or `--json`, every input is a flag and a missing one is `USAGE_INVALID` before anything is written; `--destination cloud` is `UNSUPPORTED`. A local space is prepared as `cotal space create` prepares it; a self-hosted space is one registered here whose root is the project, or one `--connection-file` registers. Setup seeds the default persona into the project's `.cotal/agents`, records the application as the space's `harness` preference, runs that application's own setup actions, and writes one envelope with `--json` listing every file it wrote. A rerun with the same answers is a no-op. An application whose executable is not on PATH leaves the rest saved and exits 4. `--configure-only` is accepted and is the default. `recordPreparedSpace` in `@cotal-ai/workspace` returns the file it wrote, and `meshFile` names a space's registry file.

  Breaking: `cotal setup --yes` without the four inputs is refused, setup sets up one application rather than every detected connector, and a repeat setup no longer prints a status card (`cotal status` reports the same state). See the upgrade notes.

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

- 15c96da: The `rootedAt` field is gone from the local-process extension contract. Nothing has read it since the
  dashboard became a service, and the web extension no longer sets it. An extension that still declares
  it has the field dropped from its cached descriptor, like any other unknown field.

### Patch Changes

- 5c85ef3: Add a broker service preset for explicitly prepared local configurations, with a direct creation-pinned child, launch-bound native listener reports and a separate exact-process-exit stop receipt. Preserve unknown stops without force-kill or restart.
- d079080: Help fits a narrow terminal again. A command's usage line breaks only between options and never between an option and its argument. A usage too wide for the line breaks after its own `|` or compact `|` alternatives first. A group of alternatives too wide for the line takes lines of its own and breaks after its own `|` the same way, so `cotal help send` keeps `--role/-r <role>` together on a 60-column terminal. A compact `|`, such as the one in `<persona.md>|--prompt`, is a break point too: the line ends right after it and no space is added or lost, so `cotal help persona` keeps `--prompt <text>` together on a 40-column terminal. A group that fits, such as `[--json|--plain]`, stays whole. Only a single option with its argument that is wider than the line breaks at its spaces. `cotal help --all` wraps its title and group headings to the terminal. Examples are still never wrapped, so each stays one line to copy.

  A flag whose description would have fewer than 30 columns beside it now has its description on the lines under it. Before, the description stayed beside its flag down to about 22 columns, so `cotal help spawn` wrote lines wider than a 60-column terminal. A report's list of commands, such as a `Next` section, follows the same 30-column rule.

- 3deea9d: Name the mesh before and after more operations. `service stop`, `service restart` and a named service-set stop now begin the impact they show for review with `Mesh: <space>`, as `down` does. The `space delete` and `reset space` previews, the manager gate repair review, the foreground notices of `up`, `team boot` and `service start`, the attach picker's partial-list notice and setup's agent-joined notice name the mesh too. A classified failure raised after a command resolved its space now carries that space in `target.space` and begins with `Mesh: <space>`, even when the failing step named no space. A target that already names a space is kept as it is.
- 5c85ef3: Compose prepared open stacks without delivery credentials, use request-bound child-local manager observations with explicit evidence labels, and compose static mixed-team removal as native agent retirement followed by revision-conditioned channel-card removal.
- 5c85ef3: `cotal up` writes the authenticated broker configuration `server.conf` owner-private (0600), and creates `.cotal` and the broker store owner-private (0700), whatever the umask. Under a group-writable umask the stack's own broker preset no longer refuses the files `up` just made. The broker, auth service and delivery logs are created 0600, and the pid, identity pin and manager marker records `up` writes are created 0600. A private file written in place, through `writeSecretFile` or the new `openPrivateAppend`, is never opened through a symlink: on POSIX a symlink, a non-regular file or a file another user owns is refused with `EPERM` and left unchanged, and a file the user owns is set to 0600 through the descriptor before it is truncated or appended to. Windows keeps a mode-0600 open with no owner check, and its ACL hardening is unchanged. A refused service path now names the option, the path that failed, and its owner and mode, and a group-writable ancestor is named instead of the path below it. The text failure report shows a wrapped cause's detail as one line. The whole-stack failure hints name `cotal service --space <space>`, which lists every member with no definition name needed, in place of a bare `cotal service status`.
- 5c85ef3: Process records never write through a symlink. `@cotal-ai/core` adds `writePrivateRecord` and `createPrivateRecord`, which take `writeSecretFile`'s private open without its Windows ACL step. The manager's delivery-aware marker and a pid identity pin are rewritten with `writePrivateRecord`, so a symlink at either name is refused with `EPERM` and left unchanged. The pid, pin and bridge temporaries `writePidPair` publishes are created with `createPrivateRecord`, exclusively and owner-private, and only the temporaries a call created are removed afterwards.
- 0e40d19: Files written in place under `~/.cotal` or a project's `.cotal` are no longer written through a symlink. The manager's own delivery-aware marker, the `agent-bearer` health file, the onboarding marker, the `setup` log and personas, the web session file and detached log, the feedback store, persona files saved by `saveAgentFile`, the seat custody record, payload, exit record and log, the Claude seat home and plugin marketplace, the Codex host log, the Jcode launch record, the `ext` extensions prefix `package.json`, and the isolated broker's config rewrite and watchdog now refuse a symlink and leave it unchanged. A file rewritten in place is set to `0600` through the open file. `hardenPrivate` on a file now uses the same no-follow descriptor. A directory is still hardened to `0700` by its path, so a symlinked `~/.cotal` or `.cotal` is not refused there. The manager and native service custody no longer chmod their pid records by path, since those are created `0600`. The broker ports report refusal names the report's path, and a failed close no longer hides it.
- 5c85ef3: Make owned services and target selection recoverable and honest. A service start refused before its process exists, such as a manager preset for a space that is prepared and not started, now refuses under the target's own code and records the instance as failed with no process, so a later start, stop, removal or `down` is not blocked by it. Ctrl-D or a closed input at a service confirmation is a clean cancel instead of exit 13 with Node's unsettled-await warning. A project root with no registration whose stack journal recorded a broker is refused as not started and names that broker, so reads such as `whoami`, `ps`, `who` and `endpoints` never dial the default address there; `status` and `status --components` select no space for an unregistered root. Bare `use` no longer runs the connector seed. `service` with no space names `--space` in a separate remedy. Preset help marks required options and path placeholders, a missing required option or preset is named, and schema, path and space mismatches name the field or option. Service stop, restart and `down` report a no-op plainly, skip a confirmation that would stop nothing, name the dependants that block a stack stop, and preview a refused stop with `--dry-run`. `service add` names its next steps. Setup checks `--harness` against the official connectors when none is installed and names a seed step that can run from the binary. The service reference in docs/cli.md now matches the shipped command.
- 5c85ef3: Add static-mode chat session admission. A static manager serves `chat-session-open` and `chat-session-retire` (cluster revision 34): it draws a `chat_` alias and a fresh nkey identity, provisions the session over the native static activation with a spawn's three channel lists under a spawn's rules, and mints an agent-profile leaf with no role, capabilities, endpoint rows or issuance, expiring within 900 seconds with no renewal. The manager writes the leaf's credential ledger row itself before it leaves the process. The reply carries no credential in the clear: the leaf is sealed to a one-time curve key the caller sends as `sealTo`, bound to the space, the admitting instance and the reply's fields, so a generic invoke, an agent or a browser sees only ciphertext. Retirement runs the static terminal and refuses any alias, instance, uid or actor it did not admit. It marks the credential's ledger row revoked and verifies that the session's principal has no live connection, but a static mesh cannot revoke the leaf itself, so a copy of it still connects until its expiry. The admitting manager retires each session it admitted at that expiry when nothing retired it sooner, retires every session it still holds when it stops without preserving its state, and its startup sweep leaves alone a session it is admitting or holds. Only operator instruments carry the two command rows. An ordinary spawn now refuses names that start with `chat_`. The workspace exports `mintControlInstrument`, which mints a control-caller instrument for a target the caller already resolved. Core adds `sealJson`, `SealRecipient` and `isCurvePublicKey`, one-time sealing over the existing NATS curve keys. The CLI gains the static chat adapter, which opens the sealed reply once and checks every bound field, keeps the leaf in memory, mints every manager call from the target it was opened on, and retires at the admitting manager instance. The CI suite list gains the two new smokes.
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

- 5c85ef3: Add `cotal who` and `cotal whoami`. `who` lists the live roster of the selected space with each participant's status, condition, activity, attention, harness, model and host, and whether a manager runs the seat; `--waiting` keeps rows that are waiting or report a condition and `--all` adds infrastructure endpoints. `whoami` reports the identity the CLI acts under in the selected space and what it may read, post and do, without connecting. Both write one structured document with `--json` and a plain report with `--plain`; a part they could not read makes the run `partial` (exit 4), and a roster the identity may not read is refused with `PERMISSION_DENIED`. `who` watches the roster on every mesh so it can report an unfinished snapshot, a stale roster and a watch error. On a static-auth or user-auth mesh each run's watch consumers stay on the broker for five minutes after it exits. A manager census the identity's grant does not reach, such as a user-auth user's, is labeled with a warning and leaves the run complete.

  For a remote user-auth registration, a cached login remains a login even when the owner and grant cannot be derived on this machine. `whoami` reports the grant as unknown and partial, leaves the owner and principal null, and does not tell that user to sign in again. Human output labels the cached login and its advisory expiry.

  `whoami` also skips dispatcher catalog refresh, so a cached login and an uncached catalog do not make this local identity read contact the IdP.

  Broker addresses in identity reports and shared connection-failure messages omit URL user information, query strings and fragments. Stored connection values and connection behavior are unchanged. An unparseable address is refused by `whoami` without printing it.

  Use a URL placeholder in auth-mismatch recovery instructions rather than a display address with connection data removed.

  Validate display addresses as broker addresses before returning an unchanged value, and escape terminal controls. Preserve bare hosts, IPv6, TLS and WebSocket routes without changing stored or dialed values.

  Classify malformed local registry data as `SCHEMA_INVALID` before any read request, without printing its stored field values. Include the roster suite in the Linux, macOS and Windows platform matrix.

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
- Updated dependencies [0e40d19]
- Updated dependencies [5c85ef3]
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
  - @cotal-ai/core@0.91.0

## 0.90.1

### Patch Changes

- @cotal-ai/core@0.90.1

## 0.90.0

### Patch Changes

- Updated dependencies [88ab21e]
- Updated dependencies [b928aaa]
  - @cotal-ai/core@0.90.0

## 0.89.0

### Patch Changes

- 2905ae9: On Windows, publishing a process record now waits at most 5 s in total for files another handle holds open. Before, each of its three renames could wait 10 s on its own, so one publish could block for nearly 30 s under the publish lock, about the time a second writer waits for that lock before giving up (#4175). All the renames of one publish now share one 5 s budget, and a refusal that outlasts it still throws.
- Updated dependencies [dc458a4]
- Updated dependencies [bab4ca8]
  - @cotal-ai/core@0.89.0

## 0.88.0

### Patch Changes

- fc923a5: On Windows, publishing a process record no longer fails when another handle briefly holds the old pidfile or identity pin open. Windows refused the rename with `EPERM`, so a manager could exit right after boot and `cotal up` reported the control plane degraded (#4168). Each rename of a record now retries `EPERM`, `EACCES` and `EBUSY` on Windows, as graceful-fs does, with a backoff growing from 0 to 100 ms and at most 10 s of waiting in total. A refusal that lasts longer still throws, and so does any other error or any error on another platform.
- a3ae00f: Keep the seat control connection's TLS requirement explicit through a local primitive, preserving the recorded value without a transport default.
- Updated dependencies [cb09213]
  - @cotal-ai/core@0.88.0

## 0.87.0

### Patch Changes

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

## 0.86.0

### Patch Changes

- 1dd5baf: A control command run without `--space` now probes the registered brokers once per resolve. Before this, the control resolver probed every non-catalog record for its mode check, and the connect helper probed them all again before it chose the target; `cotal update`'s manager continuity check added a third round of probes. Each round could wait out the confirming timeout on a record that did not answer, and a broker that started or stopped between rounds could leave the mode check and the connect resolving different targets. `ConnectFlags` now carries the sweep's `offline` set, and `resolveControlTarget`, `resolveTargetOrThrow`, `connectOrThrow`, `connectUserControlOrThrow` and their exiting forms read it instead of sweeping again. A named `--space` still skips the sweep.
- 8d97d8a: Callers can name a manager instance wherever a user-auth mesh with several live managers for one owner asks them to. `cotal models` and every hosted `cotal run` verb take `--on <instance>`, and MCP `cotal_run` and `cotal_personas` take an `instance` argument under the same rules as `cotal_spawn`'s. A `cotal` command run from a managed seat's shell now selects the manager that launched the seat (`COTAL_MANAGER_INSTANCE`), as the seat's tools already did, unless `--on` names another. The ambiguity refusal still refuses, and now lists the owner's live manager instance ids and names the caller's own remedy: `--on <instanceId>` for the CLI, the `instance` argument for an agent's tools. Before, it named `--manager-instance`, which only `cotal agent-bearer` takes, so none of these callers could answer it.
- 958e6cb: `cotal_roster`, `cotal ps`, `cotal status`, `cotal endpoints`, `cotal console` and `cotal join` print each peer's condition code and activity on one line and at most 200 characters. A control character or Unicode line separator shows as a `\uXXXX` escape, so a peer can no longer split its row into what reads as a second roster entry, pass terminal control bytes through, or flood every row with a 4000-character activity. The rule is `presenceText` in `@cotal-ai/core`, and `oneLine` moved there from `@cotal-ai/workspace`, which still re-exports it.
- ee42687: The seed reconcile reads a built-in's `package.json` once per check. `installedExtensionPackage` returns the installed version and declared `main` from that one read, with the error policy `installedExtensionVersion` already had, and the entry-file check takes `main` from it. The check used to parse the file a second time and treat any failure of that read as a missing entry file, so a permission error there made `cotal ext seed --repair` silently reinstall the built-in, or report a torn install while the entry file existed. A read failure now surfaces as the error it is.
- 3c0a830: The comment on the `space add` second-tenant refusal and the P7/P1 design note now name `ensureRootForSpace` in the CLI's `up` command as the root-pin refusal. They used to cite it as `up.ts:2233`, and that line had drifted onto an unrelated interface field. No behavior changes.
- 4f49cea: A stray `space.<key>`, `account.<key>.json`, `manager.<key>.pid` or `delivery.<key>.pid` whose key decodes to `.` or `..` is now treated like any other name the workspace did not write. `spaceFromSegment` returns undefined, `accountInventory` lists the file under `corrupt`, and `recordedRuntimeSpaces` skips it, where each used to throw "cannot name a space" and `cotal status` printed that error as a hint. The three decoders now share one exported `spaceFromKey`.
- 1eaf6e3: `cotal status --components` now names the HTTP status when the web dashboard's address answers `/api/meta` with a status outside 2xx, such as `HTTP 401`. It used to read the body first, so a plain-text or empty refusal printed `http not answered`. The status row and `cotal web --detach` now send one shared readiness request from `@cotal-ai/workspace` and read its answer the same way. That request no longer follows a redirect, so the readiness header goes only to the recorded address and a 3xx answer is reported as its status, such as `HTTP 302`, where both used to follow it and accept the identity the redirect target answered with.
- 3b93aa2: The pre-hex record sweep that runs when a mesh is recorded or removed now throws any error listing the registry directory other than ENOENT. Before, the sweep read every listing failure as an absent registry, so a removal could return while a pre-hex record of the same space stayed behind and listed the mesh again. An absent registry directory still has nothing to sweep.
- Updated dependencies [598d0dd]
- Updated dependencies [be2c0d8]
- Updated dependencies [140c0d4]
- Updated dependencies [1d92ef7]
- Updated dependencies [91663dc]
- Updated dependencies [31dccc4]
- Updated dependencies [15043fa]
- Updated dependencies [1fd3cb4]
- Updated dependencies [fba88b0]
- Updated dependencies [b7f4af7]
- Updated dependencies [7a2c574]
- Updated dependencies [664e9df]
- Updated dependencies [830d66b]
- Updated dependencies [516c8f6]
- Updated dependencies [00f631a]
- Updated dependencies [ab30526]
- Updated dependencies [df063ef]
- Updated dependencies [958e6cb]
- Updated dependencies [d4a745f]
- Updated dependencies [6d5462d]
- Updated dependencies [c2e7648]
- Updated dependencies [12344fb]
  - @cotal-ai/core@0.86.0

## 0.85.0

### Patch Changes

- 7840cea: A process record that exists but cannot be read now fails with an error that names its path. `readPidfile` passed the underlying read error through unchanged, and an error raised at the read, such as `EISDIR` for a directory at `.cotal/nats.pid`, carries no path, so `cotal down` printed only `EISDIR: illegal operation on a directory, read`. The error now reads `cannot read <path>: <reason>` and keeps the original as its `cause`. A missing record still reads as absent.
- Updated dependencies [6e10d50]
- Updated dependencies [ff09b5c]
- Updated dependencies [d5e7a87]
  - @cotal-ai/core@0.85.0

## 0.84.0

### Patch Changes

- b4c8812: Treat a mesh record removed during a registry or keyed read as absent instead of reporting it as damaged. Keep named refusals for parse, shape and other read failures.
- 9229264: Use the shared trust-entry check before loading a legacy stripped signer. Dangling and looping split-record links now refuse like other non-regular entries instead of being treated as absent.
- Updated dependencies [6d48a0b]
  - @cotal-ai/core@0.84.0

## 0.83.0

### Patch Changes

- Updated dependencies [d663fa4]
  - @cotal-ai/core@0.83.0

## 0.82.2

### Patch Changes

- @cotal-ai/core@0.82.2

## 0.82.1

### Patch Changes

- 9061234: Read Windows process creation time through a bundled x64 or arm64 Node-API binding instead of starting PowerShell. Preserve every FILETIME digit and keep access-denied identities unverified. Missing or damaged native bindings fail loudly without a subprocess fallback.
- 423d250: Read a process identity pin whose start token has spaces. On macOS the token is `ps -o lstart=` output, such as `Thu Oct 15 21:16:51 2026`, and the pin parser accepted only two whitespace-separated fields. Every pin written on a Mac therefore read back as unattributable: the manager stopped right after boot when it failed its own pin, and `cotal down` refused to stop any component. The parser now reads the pid and keeps the rest of the line as the token, unchanged. Pins written by processes that are already running read correctly once this release is installed.
- b526a5e: Stop local Windows managers and delivery daemons through an authenticated process-bound cleanup request, so immediate restart can acquire leases released by the previous generation. Keep identity checks, stop reservations and the existing one-shot agent-reap policy. Refuse older Windows daemons without this capability instead of force-terminating them without cleanup.
  - @cotal-ai/core@0.82.1

## 0.82.0

### Patch Changes

- 9a93a58: `connectOrThrow` and `connectUserControlOrThrow` now throw a user-auth mesh's login and exchange refusals (not logged in, auth service down, actor not granted) as a `ConnectRefusal` carrying the provider's sentence. `connectOrThrow` used to print that sentence and exit the process, so the console's `delchan` on a user mesh with no login on the machine ended the console instead of showing the refusal on its status line. `connectOrExit` and `connectUserControlOrExit` still print the same sentence and exit 1.
- Updated dependencies [4f52881]
- Updated dependencies [6afa12f]
- Updated dependencies [7c6c109]
  - @cotal-ai/core@0.82.0

## 0.81.1

### Patch Changes

- @cotal-ai/core@0.81.1

## 0.81.0

### Patch Changes

- Updated dependencies [c166107]
  - @cotal-ai/core@0.81.0

## 0.80.0

### Patch Changes

- 0835254: The control target resolver now throws a user-auth mesh's connect refusal when its caller asks for the throwing form, as it already did on a static mesh. It used to print the refusal and exit the process, so on a user-auth mesh with no login on the machine, Ctrl-C on a foreground `cotal up --user-auth` or a bare `cotal down` exited 1 from inside the manager stop's agent inventory and left the manager, delivery daemon, user-auth service and broker running. The stop now prints `could not list managed agents (<reason>)` and finishes the teardown.
- Updated dependencies [5417401]
- Updated dependencies [71e6311]
- Updated dependencies [3614fdd]
- Updated dependencies [e00402f]
- Updated dependencies [80f66fd]
  - @cotal-ai/core@0.80.0

## 0.79.0

### Patch Changes

- 50747b1: A manager or delivery start that refuses a record it cannot attribute now names the pidfile it read. The cutover preflight, `spawn -f`, the delivery start and `service install` used to resolve the record's spelling a second time while formatting the refusal, so a record that moved between its space-keyed and pre-upgrade names in between was misnamed, and one that appeared beside the record that was read replaced the refusal and its `NEXT:` step with an ambiguous-record error. `readProcessRecord` in `@cotal-ai/workspace` now returns the path it read on every `ProcessRecord`, and `service status --json` reports that file as `manager.path`. The config and CLI pages describe both.
- 36b03b0: The persona catalog directory is now built in one place, `personaDir` in `@cotal-ai/core`. `agentFilePath` and `listPersonaCatalog` build on it, `@cotal-ai/workspace` keeps exporting it under the same name, and `cotal status` and `cotal personas` use it in place of their own copies, so the directory spawn loads personas from and the directory those surfaces name cannot drift apart.
- 5e9a618: An installed extension whose `package.json` is not JSON or has no `version` is no longer reported as not installed or with a bare JSON parse error. `installedExtensionVersion` throws `CorruptExtensionPackageError`, which names the package and its `package.json`, so loading the extension, `cotal status` and the `cotal setup` card report the damaged file. `cotal ext seed --repair` reinstalls a seeded built-in in that state, including after a corrupt extensions manifest was rebuilt.
- db962ae: The manager and delivery daemon records are now read and attributed by one reader, `readProcessRecord` in `@cotal-ai/workspace`, which takes the record path and the component's attribution predicate and returns the state with the pid, content and command line behind it. The rule that a live pid is demoted to foreign only when its command line was read and is not the component's now lives in one place, and the delivery verdict keeps the command line it was decided on, as the manager's already did. No states or messages change.
- 92590e8: The web dashboard's pidfile name is now one `WEB_PIDFILE` constant in `@cotal-ai/workspace`. The dashboard declares its record with it, and the `cotal status` `Web process` row, `cotal status --components`, the `cotal setup` card and the `cotal clean all` crash-residue sweep read it from there. They used to spell `web.pid` by hand, so renaming the dashboard's record would still typecheck while those readers reported a running dashboard as down or absent and `clean all` left its pidfile behind. The file is still `.cotal/web.pid`.
- c03f2af: `cotal logout`, the account switch in `cotal login`, `cotal down` and `cotal clean all` now remove their registry entries as one batch that scans the registry for pre-hex records once. Before, each removed entry ran its own scan over the whole registry, so removing K entries from a registry of R records read about K × R record files. The removed entries and the pointer outcome are unchanged, also when a removal fails partway through the batch or a concurrent `cotal use` moves the pointer during it.
- 79ace0f: A seat writer generation file is now keyed by `spaceKey` of the space and of the seat name, joined by `00`, and one builder names it for both the claim and the load. An empty space, a name with an unpaired surrogate and a space or seat name containing NUL are refused instead of written, so two different seats can no longer share one generation file and refuse each other's claim. Every key a valid seat already has is unchanged. The account record filename is also built in one place now, for both its file path and its store key.
- Updated dependencies [fbc3e2d]
- Updated dependencies [c535d98]
- Updated dependencies [36b03b0]
- Updated dependencies [2bd492c]
- Updated dependencies [7cb89f9]
- Updated dependencies [4aafb0d]
  - @cotal-ai/core@0.79.0

## 0.78.1

### Patch Changes

- @cotal-ai/core@0.78.1

## 0.78.0

### Minor Changes

- 70fb24e: `SecretStore` gains `create(key, value)`, a write that stores the value only while the key is absent and resolves whether it did. `FsSecretStore` implements it with an exclusive create. `ensureCalloutAuth`, `ensureIssuer`, `ensureOwnerSecret` and the hosted auth plane's instance identity now write their first value through it and adopt the stored value when another caller created it first. Before, two concurrent first calls on one space each minted a value, the later `put` replaced the earlier one, and the earlier caller kept a value the store no longer held: one IdP subject could derive two owners, a bearer could be signed by a key the stored issuer does not publish, and a prepared broker could preload a callout account the auth service never loads. A store of your own must now implement `create` as one atomic step; see the upgrade guide.

### Patch Changes

- a7f39aa: `cotal meshes add --from` and the manual-registration policy refresh now refuse a fetched discovery document that is not JSON with the URL and the content type that answered, for example a catch-all route serving `/.well-known/cotal-mesh` as `200 text/html`. They used to print the `--user-auth-file` sentence, which named neither and told the operator to re-export a file. JSON served under any content type is still accepted, and `--user-auth-file` keeps its sentence.
- f9a71ce: Loading an installed extension now waits up to five seconds in total for another `cotal` process that is installing, removing or updating extensions, instead of failing at once. Before, a command that started a moment before the other process finished its work was refused, though a retry would have succeeded. The wait does not block the process: timers, requests and cancellation keep running while the load is queued. If the other process is still running when the five seconds are up, the load fails with "another extension update or mutation is in progress (pid ...) - retry once it finishes" when the update pass is held, or with "extension install/remove is in progress (pid ...) - retry after the active `cotal ext` command finishes" when only the install/remove lock is held.
- c2d8362: The pid contract smoke now writes its malformed auth-pidfile fixture at the path the auth stop reads, derived from the stop's own record descriptor. It used to read `PID_PATH`, which the CLI's auth module does not export, so every run fell back to a hand-spelled name, and moving the auth record would have failed the cell for the wrong reason.
- 7d13389: A mesh registry directory that exists but cannot be read, such as one without read permission or a regular file in its place, now makes `cotal meshes` and every other command that reads the registry exit 1 with its path and the read error. Before, the registry read returned no meshes for any read error, so `cotal meshes` exited 0 with "no meshes registered" and printed no rows under `--json`. An absent registry directory is still an empty registry.
- Updated dependencies [981b567]
- Updated dependencies [8344353]
- Updated dependencies [f9a71ce]
- Updated dependencies [b9499b3]
- Updated dependencies [70fb24e]
- Updated dependencies [de3c0f7]
- Updated dependencies [a32e955]
  - @cotal-ai/core@0.78.0

## 0.77.1

### Patch Changes

- @cotal-ai/core@0.77.1

## 0.77.0

### Patch Changes

- 7d1b600: Moving a manager or auth-plane identity record from its older `.cotal/auth` place no longer follows a symlink at either place. A `.cotal/space.<hex>/` entry that linked to the older record read as the same record, so the move deleted the older regular file and left only the link, which every reader refuses. An older entry swapped for a link to a different record during the move could also pass as that record. Both cases now refuse as not a regular file and keep the older record.
- Updated dependencies [6861390]
  - @cotal-ai/core@0.77.0

## 0.76.0

### Minor Changes

- 15d10c9: Refuse competing patched same-host consuming sessions without replacing their logical inbox owner. Preserve live control listeners and existing foreground actor material. Make fresh local foreground grants and departure cleanup generation-aware. This containment does not fence other hosts, broker URL aliases or older clients.

### Patch Changes

- 7829cbb: `cotal status` and the `cotal setup` card now share one test for whether the web extension is installed: a package in the extensions manifest that provides `web` and is on disk. A manifest entry whose package directory is gone no longer reads `installed` in status while the card reads `not installed`. A web package record that cannot be read is no longer reported as not installed: status names the error on its `Web extension` row and still prints the `Web process` row, and the setup card names it on its web row, also while the dashboard is listening. `loadExtensionsManifest` and `installedExtensionVersion` now treat only a missing file as absent, so an extensions or package directory that cannot be searched throws its permission error instead of reading as no extensions or not installed.
- 42b28aa: `cotal status --components` now names a `web.session` that exists but cannot be read, for example after an ownership or mode change: the web row reads `refused · web.session unreadable: <error>`. The reader used to treat every read error as no record, so a live dashboard read `refused · probe refused (no bound address recorded)`, and the `Web process` row and the `cotal setup` card read `down`. Those two rows now name the unreadable record as well. Only a missing, empty or partial `web.session` still reads as no record. `cotal web --detach` prints the launch link from the record that proved the dashboard ready instead of reading `web.session` again, so a read error after that point cannot report a failed start over a running dashboard.
- 720dbc3: `loadSeatWriterGeneration` reads each seat writer generation through the same record reader as every other auth record. A generation entry that is a symlink, a directory or a FIFO is now refused as not a regular file instead of being followed, so `cotal down --preserve-state` no longer stamps a checkpoint with a generation read through a link. A generation file that does not parse is reported in the shared record message.
- Updated dependencies [58a725f]
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
  - @cotal-ai/core@0.76.0

## 0.75.0

### Patch Changes

- 0c924f4: A hosted auth context started through `startAuthService` now keeps the auth plane's instance identity, whose serve seed is a private nkey, in its injected `SecretStore` under the new `authInstanceKey(space)`, with the other auth secret kinds. It used to write that record under `stateDir`, which the hosted contract documents as non-secret state. The first start of an upgraded context puts the earlier record into the store, removes the file and keeps the instance. A store and `stateDir` that hold different identities refuse the start. `@cotal-ai/workspace` exports `removeAuthInstanceIdentity`. A CLI root keeps its record where it was.
- 597fa25: The check that a minted `manager-caller` bearer is bound to the caller and names one manager instance now lives in one `@cotal-ai/core` function, `managerCallerBinding`, which `userViewAuth` in `@cotal-ai/workspace` and the connector's manager calls both use. Before, each package kept its own copy and they had drifted: the CLI accepted a bearer with two or four segments that the connector refused, and the two gave different refusals for an undecodable bearer, a bearer with no `act.managerInstanceId` and a bearer with no `act.lifecycleUid`. Both now refuse those bearers with the connector's sentences.
- Updated dependencies [6286d29]
- Updated dependencies [ed0785d]
- Updated dependencies [625659e]
- Updated dependencies [b48a740]
- Updated dependencies [597fa25]
- Updated dependencies [cb3a177]
- Updated dependencies [5f5196f]
- Updated dependencies [d269d1d]
  - @cotal-ai/core@0.75.0

## 0.74.0

### Patch Changes

- Updated dependencies [f3e6f95]
- Updated dependencies [328d59b]
- Updated dependencies [ac251fd]
- Updated dependencies [e3498d9]
  - @cotal-ai/core@0.74.0

## 0.73.0

### Patch Changes

- Updated dependencies [9873985]
  - @cotal-ai/core@0.73.0

## 0.72.1

### Patch Changes

- Updated dependencies [07fe6b3]
  - @cotal-ai/core@0.72.1

## 0.72.0

### Patch Changes

- Updated dependencies [c5a45ab]
- Updated dependencies [18e7e91]
  - @cotal-ai/core@0.72.0

## 0.71.0

### Patch Changes

- Updated dependencies [b9daf53]
- Updated dependencies [3518435]
- Updated dependencies [726a750]
- Updated dependencies [518351a]
  - @cotal-ai/core@0.71.0

## 0.70.2

### Patch Changes

- @cotal-ai/core@0.70.2

## 0.70.1

### Patch Changes

- ed1e171: Every `.cotal/setup.log` entry is one timestamped line. A control character or Unicode line separator in a logged path or error message is written as a `\uXXXX` escape, so a newline in a project path can no longer split one entry into a second line that reads as an entry setup never wrote. The escaping rule is now one exported helper, `oneLine`, shared with the provenance lines. `openSetupLog` no longer takes a working directory it never read; the log always lives in the resolved project `.cotal/`.
- Updated dependencies [9c99ee5]
- Updated dependencies [da6dba0]
- Updated dependencies [032522a]
- Updated dependencies [5c6c92d]
- Updated dependencies [6d81d61]
- Updated dependencies [66a0f19]
- Updated dependencies [2be1384]
- Updated dependencies [25237f0]
- Updated dependencies [6bd6099]
  - @cotal-ai/core@0.70.1

## 0.70.0

### Minor Changes

- c088c5c: The persisted identity records now share one reader and one first mint. The manager instance identity, the manager sibling identities, the auth plane instance identity and a participant manager's remote authority state each read through the same regular-file and nkey checks and publish a first mint by exclusive create through the new `claimIdentityRecord` and `identityOf`, adopting the winner when a concurrent start created the record first. Before, the manager start and the auth plane followed a symlinked record that retirement refused, and a participant manager published its first mint with a last-writer-wins rename, so concurrent first starts on one root each kept a different identity, and it accepted an empty nkey id or seed that the local loaders refused. A lost race now refuses with `identity-record-create-lost`. `saveManagerInstanceIdentity` and `saveAuthInstanceIdentity` are removed: nothing shipped overwrote a stored identity, and the exports let any caller bypass the exclusive create.
- 2639a13: `AuthProvider.userCredentials` no longer returns `managerInstanceId`. A `manager-caller` credential's instance is the signed `act.managerInstanceId` claim in its bearer, the one `userViewAuth` checks. The reference provider copied the exchange response's field beside it, and nothing compared the two, so a provider whose result named a different instance than its bearer satisfied the contract while the CLI used the bearer's. `userViewAuth` also decodes each minted bearer once, through one typed decoder, where the manager-caller check read a second untyped decode.

### Patch Changes

- 392bfeb: The user-auth service's instance identity no longer travels with a mesh's trust folder. It now lives in the root's own space segment, `.cotal/space.<space-hex>/auth-instance.json`, beside the manager's identity. It used to land in `.cotal/auth/space.<space-hex>/.cotal/auth/auth-instance.<space-hex>.json`, because the auth plane passed its user-auth state dir where the identity helpers expected a workspace root, so copying `.cotal/auth` to another root, as the docs describe for a mesh you did not start, copied it too and an auth service started there came up as the original instance. A record at the older place is moved on the first start and the instance is kept; both places holding a record is refused, and so is a symlink or other non-regular entry at the older place of the auth or manager identity, which the manager used to skip, minting a new identity. A hosted context started through `startAuthService` keeps its identity in its own `stateDir`, moved the same way from `<stateDir>/.cotal/auth/` to `<stateDir>/.cotal/space.<space-hex>/`. `openAuthAuthorityPlane` now takes a required `identityRoot`, the root whose space segment keeps that identity, and no longer derives it from `dir`.
- 1b11c4e: The auth plane's instance identity file and the remote manager's authority state file now take their names from `spaceKey`. They used to hex-encode the space themselves, so an empty space wrote `auth-instance..json` or `remote-manager..json`, and a space holding an unpaired surrogate shared a file with the space named `U+FFFD`: the second auth plane adopted the first one's identity, and the second remote manager was refused as malformed. Both names are now refused before an identity file is written. A valid space keeps the same file name, so nothing on disk moves.
- 668f6b0: The web dashboard's `web.session` record and its `x-cotal-readiness` header now have one definition, in `@cotal-ai/workspace`: the file name, the record's fields, the one reader, and the header name. The dashboard writes and reads the record through it and `cotal status` reads it there. Renaming the file, a field or the header on the dashboard side used to typecheck cleanly while `cotal status --components` read the live dashboard as `refused` and the `Web process` row read `down`; now it is a compile error on both sides.
- 15b7920: A runtime record, or a `.cotal` listing, that exists but cannot be read now fails with its read error instead of reading as absent. An unreadable record used to count as not running and an unlistable `.cotal` as holding no records, so `cotal status`, `cotal down`, `cotal clean` and the start helpers scoped a root running two spaces to the readable one, and a start went ahead past a live pre-upgrade record it could not list. Only a missing file or directory still reads as absent.
- Updated dependencies [66df6c0]
- Updated dependencies [0ec35c2]
- Updated dependencies [015f805]
- Updated dependencies [2cbfe9c]
- Updated dependencies [b413e2a]
- Updated dependencies [7986785]
- Updated dependencies [12bfc34]
- Updated dependencies [4dcfa0b]
- Updated dependencies [fd07b1e]
- Updated dependencies [8dc360c]
- Updated dependencies [cce8dad]
- Updated dependencies [c7e0c0a]
- Updated dependencies [2639a13]
  - @cotal-ai/core@0.70.0

## 0.69.0

### Minor Changes

- 4500563: A filesystem SecretStore identity is now `{kind: "fs", root, id}`, where `id` is a random value the store records once in `store.id` inside its own directory. No key of a filesystem store and no `cotal deliver --creds` file may be that file under any name the filesystem resolves to it, compared by device and inode so a case-insensitive spelling or a link counts, and a `store.id` that is a symbolic link or holds anything but a lowercase UUID is refused, so neither a credential nor another key is ever published as the id. Two filesystem identities match only when both the root and the id match, so a manager on another host whose workspace root has the same path as the delivery daemon's no longer counts as the daemon's store, takes no daemon-credential renewal lease, and no longer blocks `cotal doctor auth --fix` on the broker host. A daemon answer with no `id` is refused, so the manager and the delivery daemon must run this release together. `FsSecretStore` takes the root its identity names as its second constructor argument instead of a full identity.

### Patch Changes

- f5cb8e1: Applying a space catalog (`cotal sync` and the lazy catalog refresh) now reads the mesh registry a fixed number of times instead of once or twice per catalog row. Each row reads only its own record file just before writing it, so a registration that `cotal meshes add` or `cotal up` records while the catalog applies still wins its collision check, and the records and the removals each share one legacy-file sweep, so the time spent under the catalog lock grows linearly with the registry. The workspace package adds `readMesh`, which reads one space's record file, and `recordMeshes` and `removeMeshes`, the batch forms of `recordMesh` and `removeMesh`.
- 02c0a2d: `cotal meshes add --mode user --from <https url>` now fetches the `/.well-known/cotal-mesh` discovery document under the address it is given, as its help says. Passing the mesh's address, such as `https://auth.example`, previously fetched that URL as is, so a host serving its site there failed with the file-oriented "user-auth bundle is not JSON" refusal. A URL that already ends in `/.well-known/cotal-mesh` is fetched as given, and the consent prompt now shows the full URL it will fetch instead of only the origin. The derivation is shared with the manual-registration policy refresh through the new `discoveryDocumentUrl` export of `@cotal-ai/workspace`.
- 93716c3: The loopback check that lets plain http carry a credential now has one definition, `isLoopbackLiteral` in `@cotal-ai/core`. `agent-bearer --exchange-url`, the pinned exchange, enrollment redeem, the managed handoff reader and workspace `isLoopbackHost` all call it, so a fix to the rule can no longer reach only some of them. It parses the address, so every IPv6 spelling of `::1` is loopback and a dotted host that is not an IPv4 literal, such as `127.0.0.09`, is not. `isLoopbackHost` keeps only the legacy IPv4 canonicalization a `nats://` host needs.
- 3a1716d: Every manager stop the CLI makes now runs the stop `cotal down` runs. Ctrl-C on a foreground `cotal up`, the teardown after its broker exits, the leftover-manager stop before `cotal up -f` and the delivery cutover preflight used a second stop that took no stop reservation, skipped the spare-capability check and gave up after 2s, leaving a wedged manager running with its record kept. They now hold the reservation, so a stop while another `cotal down` is stopping the manager is refused and leaves that stop's `--with-agents` policy in place, verify the spare capability before signalling, and send `SIGKILL` to a manager still running 15s after `SIGTERM`. Ctrl-C stops the manager first and, when that stop fails, signals nothing else and leaves the stack running. A pre-pin manager record whose pid now runs a process that is not a manager is removed without a signal on every path, `cotal down` included. The workspace exports `stopReservationPath`, the one spelling of a pidfile's stop reservation.
- b584718: `cotal status` and `cotal setup` now decide whether a connector's `requires` executables are present with the same PATH resolver as the manager and manifest preflights. A `requires` entry written as a path is checked as given instead of being joined under every PATH directory, so an absolute path or `./tool` is no longer reported as missing and `bin/tool` under a PATH directory is no longer reported as ready. The shared resolver now skips a directory that matches on PATH, as exec does, so a directory named like a harness no longer counts as that harness or hides the real binary later on PATH.
- 98d2b41: Resolve a spawn's harness through one shared rule. Foreground `cotal spawn`, the detached `--resume` carry and the manager's `start` now all call `resolveAgentType` in `@cotal-ai/workspace` (`--agent`, then the persona's `agent:` pin, then a detached caller's default, then `COTAL_DEFAULT_AGENT`, then the product default). The foreground path no longer spells the product default as its own literal, so it can no longer pick a different harness than a detached spawn of the same persona. Behavior is unchanged while the product default stays `claude`.
- Updated dependencies [2d45766]
- Updated dependencies [03a7405]
- Updated dependencies [a256e2f]
- Updated dependencies [3f3d04a]
- Updated dependencies [4500563]
- Updated dependencies [5eb1e24]
- Updated dependencies [69232cd]
- Updated dependencies [93716c3]
- Updated dependencies [9772fd4]
- Updated dependencies [06429be]
- Updated dependencies [adab793]
- Updated dependencies [d29d4d3]
- Updated dependencies [539266a]
- Updated dependencies [0c5b205]
  - @cotal-ai/core@0.69.0

## 0.68.0

### Patch Changes

- a5256fd: Ctrl-C on a foreground `cotal up`, and a broker that exits under it, now stop the delivery daemon with the same stop `cotal down delivery` uses. Before, that teardown took no stop reservation and never escalated past SIGTERM: a concurrent `cotal down delivery` could not see the stop in progress, and a daemon that did not exit on SIGTERM survived the teardown while `up` went on to stop the broker. The teardown now holds the reservation, sends SIGKILL after the 15-second grace, and removes the daemon's credential only once its death is confirmed. If the broker exits while the Ctrl-C teardown is running, `up` waits for that teardown to finish before it exits. `cotal down delivery` now clears a record whose pid belongs to another program without signalling it, as the `up` teardown already did. A local process descriptor can carry `isOwnCommand` for that check; an installed extension's descriptor is cached as data and is refused if it declares one.
- 41a7e66: A provenance line (`→ using`, `→ wrote`, `→ removed`) is always one line. A control character or Unicode line separator in the announced name or path is printed as a `\uXXXX` escape, so a newline in a path such as `HOME` can no longer split one announcement into a second line the command never wrote, and a carriage return can no longer overwrite it on a terminal. The stdout line printed when stderr fails follows the same rule.
- Updated dependencies [6141e7b]
- Updated dependencies [4120c97]
- Updated dependencies [218006f]
- Updated dependencies [681c5b0]
- Updated dependencies [585fdb2]
- Updated dependencies [0d806ae]
- Updated dependencies [9b439e8]
- Updated dependencies [f018376]
- Updated dependencies [6a1789b]
- Updated dependencies [237c813]
  - @cotal-ai/core@0.68.0

## 0.67.0

### Minor Changes

- f389576: `cotal spawn --resume <id> --detach --on <instance>` carries a Claude session held on the operator's host to a manager on another host, as `docs/design/resume-transfer.md` lays out. The CLI finds the transcript with the connector's new `resumeTranscript` locator and writes it into a JetStream Object Store bucket owned by the target instance, in chunks sized to the broker's `max_payload`, as a chain that an interrupted carry continues. The manager's new operator-only `transcript-receive` command stages it, removes the broker object, and issues a one-time `resumeClaim` that `spawn` consumes; a re-run of the same bytes moves none. The seat forks the transcript in a seat-private Claude home that authenticates with an environment credential, and `cotal ps --wide` names the source host, session, digest and carry time. The manager cluster document moves to revision 21. Two one-shot credentials carry it on an authenticated mesh: a `transfer-writer` the CLI mints from the space's signing seed for the one transcript it hashed, or on a user-auth mesh exchanges from the operator's login as the new `transfer-writer` view (scope `admin`), and a `transfer-reader` the target manager mints for its own bucket on each receive or sweep, or that the host issues a remote manager through the new manager-service `transferReader` operation. A carried seat records the digest of the transcript Claude forked, and the manager stops a seat whose record does not match the carried bytes, including one whose launch was uncertain and that joined later. Space deletion lists the transfer buckets and deletes them: `deleteSpace` given the space's trust material mints its own `teardown` naming them, and it now throws naming every stream it could not delete instead of reporting success. The console space picker deletes a space this host registered as a static-auth mesh that way. The `transfer-writer` view, and the broker connection minted from it, lives at most five minutes, the static credential's lifetime.

### Patch Changes

- 55061ff: `cotal ext add` now reports an extension that needs an export its linked `@cotal-ai/*` peer does not have the way a later load of it does: it names which install is behind and what to rebuild or upgrade. It used to print only the raw missing-export import error. First-run and upgrade seeding add every built-in connector through this path.
- bb0b14e: A manager's per-root identity no longer travels with a mesh's trust folder. The instance identity and the goal-writer and session-ledger identities now live in the root's own space segment, `.cotal/space.<space-hex>/manager-instance.json` and `manager-siblings.json`, instead of `.cotal/auth`. Copying `.cotal/auth` to another root, as the docs describe for a mesh you did not start, used to copy them too, so `cotal supervise` there was refused as the original manager while it ran, and came up as that same instance once it stopped. A root that still holds the records in `.cotal/auth` has them moved on first use and keeps its instance across the upgrade; both locations holding a record is refused. When the manager lease refusal comes from a manager in a different root, it now says "another workspace root" instead of "this workspace root", and it reports the holder of the conflicting instance's own lease.
- 3069425: A manager on an authenticated mesh now keeps its goal-writer and session-ledger identities across restarts, as it already kept its serve identity. They were minted fresh on every start, so each restart added two holders to the manager's credential family, which never drops a row, and every later re-registration verify-evicted all of them again before the manager answered on its endpoint rails. The two identities are minted on the first start into a new secret file beside the instance identity (`.cotal/space.<space-hex>/manager-siblings.json`), published by exclusive create so concurrent first starts adopt one pair, and read back on every later start. A malformed file fails the start rather than being replaced. A family that already grew keeps its rows and is still swept on each restart, but restarts no longer add to it. `@cotal-ai/workspace` exports the `claimManagerSiblingIdentities` helper that does this.
- ae5b3cd: A manager or delivery start on an upgraded root no longer aborts with `ENOENT` when the pre-upgrade `manager.pid`, `manager.delivery-aware` or `delivery.pid` record it is reclaiming is removed after it was listed and before it was read, which happens when the pre-upgrade daemon exits or a concurrent start reclaims the same record. `reclaimDeadPreUpgradeRecord` still finds the record by its byte-exact name, then reads it once through `readPidfile` and moves on to the next spelling when it is gone. Every other read error still propagates, and the empty, unattributable, live and unknown-liveness rules are unchanged.
- Updated dependencies [48f18d0]
- Updated dependencies [e85e1fd]
- Updated dependencies [5b0da88]
- Updated dependencies [e65ec69]
- Updated dependencies [79e5268]
- Updated dependencies [954a78b]
- Updated dependencies [f389576]
- Updated dependencies [562a56b]
  - @cotal-ai/core@0.67.0

## 0.66.1

### Patch Changes

- 568f718: `cotal down` no longer fails with `ENOENT` when a component removes its own process record while the command runs. The record readers in `down`, the manager, delivery and auth-service helpers, and `cotal service status` checked that a pidfile existed and then read it, so a record removed between the two calls threw: `cotal down manager` printed `✗ ENOENT` and `✗ not cleanly stopped` and exited 1, and `cotal down nats` aborted before stopping the broker. Each reader now reads the record once through the new `readPidfile` helper in `@cotal-ai/workspace`. A record that is gone takes the no-record path, and any other read error still throws.
  - @cotal-ai/core@0.66.1

## 0.66.0

### Patch Changes

- Updated dependencies [a07f732]
- Updated dependencies [be53e2d]
- Updated dependencies [658c1b8]
- Updated dependencies [af779f9]
  - @cotal-ai/core@0.66.0

## 0.65.0

### Patch Changes

- Updated dependencies [ba5468d]
- Updated dependencies [451ffee]
- Updated dependencies [f01aa7c]
- Updated dependencies [2cef9e6]
  - @cotal-ai/core@0.65.0

## 0.64.0

### Patch Changes

- Updated dependencies [6c79419]
- Updated dependencies [d121d21]
  - @cotal-ai/core@0.64.0

## 0.63.0

### Patch Changes

- 9d5cc09: First-run `cotal setup` now shares your own Claude Code MCP servers with the sessions Cotal spawns. It copies the user-scope servers from your Claude Code config into the cotal config's `connectors.claude.mcpServers` and names them in its output, so a spawned session has the tools you know plus the cotal tools. Before this, a spawned session loaded only the cotal server and setup never said why. With none to copy it writes an empty list, and a cotal config that already declares that list keeps it. A server with an `env` or `headers` value that is anything but `${VAR}` references is left out and named, because the cotal config keeps secrets only as `${VAR}` references. So is an entry no session can start, such as one with a missing or empty `command` or `url`, or one whose `command` is not a string. For a lighter seat, remove entries from the cotal config or spawn with `--share-tools none`. Connector setup providers gain an optional `mcpServers` action whose `seed` input the CLI binds to workspace's new `seedConnectorServers`, which writes under a lock so two setups run at once record one list. Core exports `readCotalConfigFile` and the `ConnectorShareSetupInput` type, and connector-core exports the `ENV_REFERENCE` pattern it already used.
- Updated dependencies [62ebc6b]
- Updated dependencies [22e210a]
- Updated dependencies [cb6a0bf]
- Updated dependencies [5738154]
- Updated dependencies [101c9b0]
- Updated dependencies [9d5cc09]
- Updated dependencies [c975258]
  - @cotal-ai/core@0.63.0

## 0.62.0

### Minor Changes

- b36bebf: `cotal spawn --detach` run from a managed seat's own shell on a static or open mesh now launches as that seat, so the manager records the seat as the spawner and the seat can stop the child with `cotal_despawn`, as it can a `cotal_spawn` child. Before, the CLI minted a one-shot operator instrument that no session could present again, and the seat's despawn was refused. `--on <instance>` keeps its pin on that path: on a static mesh the CLI mints a one-shot `manager-caller` view for the seat, pinned to that instance and carrying the spawn subject only when the seat's own credential holds it. On an open mesh the seat's call keeps the TLS requirement the mesh records, and `--server` with an unregistered `--space` keeps the operator path. Without `--space` the seat's target is picked as the operator path picks it, skipping a recorded mesh that is not running. The child is now stopped when the seat exits, and on a static mesh a seat without `capabilities: [spawn]` is refused. The seat-scoped control target that `cotal run` already used on a static mesh moves to `@cotal-ai/workspace` as `resolveSeatControlTarget`; `cotal run` keeps using it on a static mesh only. On a static mesh the seat's credential also proves its space, so a seat launched without `COTAL_SPACE` still acts as itself, as `cotal run answer` did before; an open mesh acts as the seat only when `COTAL_SPACE` names its space. See docs/UPGRADING.md.

### Patch Changes

- 877909b: A provenance line (`→ using`, `→ wrote`, `→ removed`) no longer fails or crashes a command when stderr is broken. When the stderr write throws or fails with an error such as EPIPE or ENOSPC, at once or after waiting in a full pipe whose reader goes away, the line is printed on stdout with the error and the command finishes its work. This holds for a write that throws a value that is not an Error, such as `null` or an object with no string form. It also holds when the program has already ended stderr, even if it exits in the same tick. When stdout fails too, the command still finishes its work and exits 1 instead of 0, so a line no channel could carry is never lost silently. The same holds for a line still waiting in a full stderr pipe when the command exits, as when the CLI exits on a closed stdout. A program that ends itself on a stdout error, as the CLI does, still stops at that error instead of finishing its work. Node does not say which stderr bytes are still waiting, so a line that had to wait and got through just before the exit counts the same while later stderr output still waits. A connector seed run with a broken stderr used to commit every payload and then exit 1 with nothing said, or stop after the first payload and require `cotal ext seed --repair`. A stderr that is closed or redirected away at launch still discards the line.
- 5ef9a67: Bare `cotal down` stops a stack whose manager runs the built-in `pty` runtime and has never started an agent. Since the `pty` runtime stopped using a seat custodian, its manager published no spare capability at all, so bare `cotal down` refused every default stack, left the broker running and kept the space registered, and the next `cotal up` of that space was refused as already in use. Ctrl-C on a foreground `cotal up` now holds the manager's stop reservation from its capability check until the manager exits, as `cotal down` does, so a concurrent `cotal down` cannot stop that manager or arm a reap while the Ctrl-C stop is in flight.
- 565036c: Let bare `cotal down` and Ctrl-C on a foreground `cotal up` stop a stack whose manager runs the built-in in-process `pty` runtime. That manager published no spare capability, so bare `cotal down` refused to signal it even with no agents running, left the broker up, and kept the registry entry; a default `Manager.stop()` threw on any pty seat. A default stop now stops and deprovisions the pty seats that live inside the manager process, since they cannot outlive it, and still releases every seat that can. The manager always publishes its spare capability, which now records whether its stop also stops in-process seats, and `down` reports those seats as stopped instead of left running. An older CLI refuses the new record rather than misreport those seats. A stopping manager refuses new spawns and waits for the ones it already accepted, so no seat launches after a stop that reported success, and `down` no longer promises that agents will be spared when it cannot list them. Repeated `Manager.stop()` calls share one stop, so a second call no longer reports success while the first still waits for a seat to exit.
- Updated dependencies [bcf66d6]
- Updated dependencies [97a2382]
- Updated dependencies [9236a12]
  - @cotal-ai/core@0.62.0

## 0.61.0

### Patch Changes

- @cotal-ai/core@0.61.0

## 0.60.0

### Patch Changes

- Updated dependencies [3b616a2]
- Updated dependencies [6ca4d8e]
  - @cotal-ai/core@0.60.0

## 0.59.0

### Minor Changes

- 70bcfe3: Breaking: `cotal actor grant` no longer turns an omitted ACL flag into the wide default, so a bare grant that used to succeed now needs `--full`. A grant must name `--scope`, `--allow-subscribe` and `--allow-publish`, or pass `--full` to take `spawn,role:default`, `>` and `>` for the ones left off. Otherwise it refuses, writes nothing, and prints both forms. Dropping one flag from a narrow event-plane reader grant used to mint a row that read or posted to every channel, or could spawn, with a success line as the only sign. The hints printed by `cotal login`, `cotal status`, `actor list` and the not-granted refusal now include `--full`.

### Patch Changes

- 1cf7f72: `ConnectRefusal` now carries a `kind`: `transient` when the broker could not be reached or answered too slowly, or no mesh is recorded yet, and `permanent` for every other refusal. A `cotal attach` that is reconnecting after its link died now exits non-zero with the refusal's own sentence when the refusal is permanent, such as a static-auth mesh whose seed has gone missing. It used to retry that forever behind `[cotal: connection lost, reconnecting]` with no explanation.
- 5bec8b2: `cotal attach` now opens a seat's session on a user-auth mesh. The CLI presents its bearer identity together with the session grant to the auth service's exchange, which issues a `session-caller` view bearer only after it confirms, against the redeemed `session.<id>` row and the serving manager gate, that this owner and actor hold that session. The callout re-checks the same row and mints the same `session-caller` rails with the grant's expiry that the static path mints. No local seed is read or written.
- cfc3b95: `cotal status` now has one Machine row per installed connector instead of fixed `Claude` and `OpenCode` rows. Each row reports whether the executables that connector declares in `requires` are on PATH, so a machine running Codex, jcode, pi or Hermes sees its harness. The `Claude plugin` and `Claude skills` rows now come from the Claude Code connector: a setup provider may declare a read-only `status`, and `cotal status` and the setup card print the rows it returns. A machine without the Claude connector no longer shows them. The extensions manifest caches each connector's setup ref, so status imports only connectors that declare a provider, and the seed reconcile refreshes a seeded entry whose cache predates it instead of checking the Claude connector by name. The debug handoff that `cotal setup` offers when a step fails now comes from connectors: a setup provider may declare an `assist`, and the menu offers one `Debug it with <harness>` option for each present connector that declares one. The Claude Code connector declares the existing Claude handoff. When no connector can host a handoff, the menu says so instead of silently omitting the option.
- b669a73: `cotal deliver` takes `--root <dir>` to name the workspace root it serves instead of inheriting it from the working directory. Without the flag, a workstation daemon started from a directory with no `.cotal/` above it now refuses at start and names the directory it searched from. It used to read its credential and registry from that directory, dial the broker, and only then refuse on a missing `$SYS` observer. `@cotal-ai/workspace` adds `requireCotalRoot`, the same walk as `findCotalRoot` without the fallback to the start directory.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
- 06f48f4: CLI output is plain text when stdout is not a terminal or `NO_COLOR` is set to a non-empty value. The shared color helpers used to wrap every string in ANSI escapes, so `cotal --help`, `cotal status`, `cotal meshes` and the red error lines on stderr carried escapes into pipes and log files. The manager's and the delivery daemon's own always-on copies are gone; `cotal supervise` and `cotal feedback-intake` now print through the same helpers. The guided `cotal setup` and `cotal meshes add` prompts follow the same rule, so `FORCE_COLOR` now reaches them too. `FORCE_COLOR` turns color back on even when output is piped, unless it is `0` or `false`, and it takes precedence over `NO_COLOR`, the order Node uses.
- 438e9ed: Close the pid record publish window. A launcher that died between removing the old identity pin and publishing the new pidfile left the old pid with no pin, which teardown signalled with only a legacy warning, even when the removed pin had been refusing a reused pid. The publish now renames a bridge pin holding the old and the new record's lines before the pidfile commit, and teardown checks the pidfile's pid against its own line, so every crash point leaves the old or the new complete record. Publishes of one pidfile are serialized by a lock, so a launcher and the daemon it starts can no longer overwrite each other's bridge or settled pin. A publish that cannot read a start token for the new process gives it a `-` pin line, so a crash after the commit reads the legacy record it was publishing, never the new pid beside the old pin. Replacing a legacy record carries its line as `-`, so an interrupted replace leaves it legacy, never torn. Teardown and a daemon's exit cleanup remove a record under the same lock, and only while the pidfile still names the pid they stopped, so a stop that races a publish can no longer leave the new pidfile with no pin. `removeIdentityPin` is deprecated in favor of `removePidPair` and stays exported unchanged for one minor line.
- 6145abc: Resume a preserved user-auth mesh as the logged-in operator. `cotal up` after `down --preserve-state` used a static instrument whose caller has no ledger row, so the manager refused `resume-preserved` for want of `admin` and the maintenance journal degraded. The resume now uses the operator's manager view, the same caller the preserve cut used.
- Updated dependencies [5bec8b2]
- Updated dependencies [6c01470]
- Updated dependencies [cfc3b95]
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
- Updated dependencies [eb2681e]
- Updated dependencies [fb1bc26]
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
  - @cotal-ai/core@0.59.0

## 0.58.0

### Minor Changes

- 95ae645: The auth retirement rail is a conforming registered endpoint with a describable contract. The requester calls it through the generic client in the exact target mode. A legacy body is refused as unsupported-version.

### Patch Changes

- fba1537: A repair `up` after a broker died reopens the store the mesh record names and refuses a different `--store-dir`. A foreground `up` whose broker exits unexpectedly keeps the mesh record, names the exit and the repair, and exits non-zero.
- 576f622: A process's pidfile and its identity pin now publish as one rename-based transition, so a crash between the two writes never leaves a torn pair (old pid beside a new pin, or a new pid beside an old one). A crash still leaves one of the legacy shapes teardown already handles.
- ee6de5d: Expose provider-neutral hosted context lifecycle types for explicit service inputs and readiness, without changing existing CLI behavior.
- e9ef5b3: Add `retireManagerInstanceIdentity(root, space, expected)`, which deletes a space's persisted manager instance identity only when the stored record is the complete expected identity. A symlinked, malformed or different record is refused and kept, and a missing record returns `absent` so an interrupted retirement can be retried.
- Updated dependencies [0589316]
- Updated dependencies [59a7e64]
- Updated dependencies [95ae645]
- Updated dependencies [2457692]
- Updated dependencies [7c54825]
- Updated dependencies [2c31f95]
- Updated dependencies [397bc60]
- Updated dependencies [7b3924c]
- Updated dependencies [1721738]
  - @cotal-ai/core@0.58.0

## 0.57.0

### Patch Changes

- 33357d9: Expose provider-neutral hosted context lifecycle types for explicit service inputs and readiness, without changing existing CLI behavior.
- Updated dependencies [e7c702a]
- Updated dependencies [6f64bcc]
- Updated dependencies [42448fa]
  - @cotal-ai/core@0.57.0

## 0.56.1

### Patch Changes

- Updated dependencies [6b76946]
  - @cotal-ai/core@0.56.1

## 0.56.0

### Patch Changes

- 8dc7c92: `doctor auth --fix` takes the mesh's one daemon-credential renewal lease before it re-signs when the broker answers, refuses with the live holder and the recovery named while a manager or another doctor holds it, and records and prints an explicit offline repair when the broker does not answer (#1063).
- ef8889d: The raw off-registry preflight (`--creds`, or `--server` with an unregistered `--space`) re-probes at the same 8s confirm budget the registry preflight uses before refusing, so a live broker on a slow link connects instead of being reported as not running, and the timeout sentence names a budget that was spent (#709).
- Updated dependencies [e506040]
- Updated dependencies [8dc7c92]
- Updated dependencies [99cad7b]
- Updated dependencies [1218786]
  - @cotal-ai/core@0.56.0

## 0.55.0

### Patch Changes

- a83dd80: Preflight reports a probe that ran out of its budget as a slow link instead of a trust failure: `probeConnect` now returns a distinct `timeout` reason, `preflightTarget` routes it to a new `slow-link` verdict without consulting the INFO greeting, and the rendered sentence names the connect budget and says the registry entry was kept, never a CA. A real certificate failure against a TLS-required mesh still renders the `tls-trust` guidance.
- 4f48629: A raw `--creds` control call (`cotal ps`/`stop`/`attach` with a credential file) is refused for the reason that actually applies: the invocation carries no endpoint-caller triple and that route cannot mint one. The refusal names the missing triple (owner, actor, lifecycle uid), says minting the file again changes nothing, and points at the routes that mint the one-shot instrument (the mesh's project folder, or `--space` against the registry entry). It no longer claims the file predates the v0.4 control surface, which was inferred from the missing triple alone and never read from the credential.
- Updated dependencies [888e9bc]
- Updated dependencies [810814b]
- Updated dependencies [8472dc3]
- Updated dependencies [f272f71]
- Updated dependencies [a83dd80]
- Updated dependencies [db9a969]
- Updated dependencies [d284ee6]
- Updated dependencies [2e13607]
- Updated dependencies [d3d6742]
- Updated dependencies [fd58782]
- Updated dependencies [357af9f]
  - @cotal-ai/core@0.55.0

## 0.54.0

### Minor Changes

- 34beea1: Route user-auth manager calls through a short-lived, instance-bound control credential. Discovery and invocation address the same authorized manager while the agent's standing connection, credentials and conversation remain unchanged. Managed launches retain their manager selection across launch and resume. Static and open mesh routing is unchanged. Confirm the standing goal-progress subscription at the broker before submitting on the separate control connection, so fast terminal events cannot outrun the subscription. Recover accepted goal results through the manager's caller-scoped `goal-result` command after connection replacement, without repeating the mutation or granting clients raw JetStream reads. Followed calls now require a compatible manager before submission; update the issuer, participant manager and client together. Stopping a caller cancels its observation without cancelling the accepted goal. Retain Linux custody records across clean child exit so retirement can prove process identity and finish cleanup even after the custodian removes its file; socket loss alone never frees the alias.

### Patch Changes

- Updated dependencies [e6badb8]
- Updated dependencies [34beea1]
- Updated dependencies [b4317fd]
  - @cotal-ai/core@0.54.0

## 0.53.0

### Patch Changes

- d1f9703: Supervise of a registered remote user-auth space no longer composes or validates local trust under remote authority. A root hosting an unrelated static space's trust records beside the participant sign-in used to fail with a corrupt-bundle refusal; the manager now consults the store only for the supervised space's own records (account record, or a legacy bundle naming the space), refusing that combination of authorities while other tenants' records are never used. An unreadable record on a key that is read refuses loud with the store's own parse message.
- Updated dependencies [104921c]
- Updated dependencies [83617ab]
  - @cotal-ai/core@0.53.0

## 0.52.1

### Patch Changes

- f17791d: Give pinned managers without a spare-capability record a stop route that works for both legacy and non-detaching managers.
- Updated dependencies [5784ec9]
  - @cotal-ai/core@0.52.1

## 0.52.0

### Patch Changes

- cf5a5cb: The renewal record is per-space: `renewalRecordPath(root, space)` now writes and reads `.cotal/renewal.<spaceKey>.json`, keyed by the same injective hex the pidfiles use, and every writer and reader threads the space — the manager's renewal pass, `doctor auth --fix`'s write, `doctor auth`'s verdict reads, and `status --components`' delivery row. Before, one root-scoped `.cotal/renewal.json` served every space at a root, so with two spaces co-resident the last pass won: a refused adoption in one space was reported as accepted once the other's manager ran a clean pass, and the mirror case reddened a healthy space's doctor. A root-only `renewal.json` left by a pre-per-space build names no space and is never read as any space's verdict; `doctor auth` names it as a leftover with its cleanup, and `cotal clean all` removes it beside the per-space record. Fixes #1850.
- ab0808c: `cotal up --max-file-store <bytes>` sets the broker's JetStream file storage cap. Before, the rendered broker config carried only `store_dir`, so nats-server always sized its store at start as three quarters of the free disk and an operator on a shared disk had no supported way to bound it. `serverConfig` and `openServerConfig` take an optional `maxFileStore` byte count and render `max_file_store` inside the `jetstream{}` block; left unset, the rendered config is byte-identical to before, and a zero, negative or non-integer value throws naming the option. The cap is recorded on the mesh entry, carried through `down --preserve-state` into the resume, and rendered again by the bare `cotal up` that resumes it. A resume or a refresh of a running mesh that asks for a different cap is refused, because nats-server fixes the cap at start and refuses a reload that changes it. The flag is refused with `-f`. Fixes #1888.
- 6b375c8: `cotal update` reports every running manager's continuity, and its refusal carries the remedy

  With several meshes running and the shell outside every project root, the continuity check printed
  the mesh resolver's bare text and exited before writing anything. It now renders that refusal through
  the workspace renderer, the way every other command does, so it carries the `--space` / `cotal use`
  recovery sentence. And because the install replaces the single `cotal-ai` that every running manager
  shares, an unselected run now reports each running manager in turn instead of refusing, with any
  `legacy` verdict making the whole run not a hot update. `--space`, `--server` and `--creds` still
  select exactly one manager, and nothing is written until every selected manager has been observed.

- Updated dependencies [5ee8eef]
- Updated dependencies [2e7558d]
- Updated dependencies [5b2c19f]
- Updated dependencies [d69aefd]
- Updated dependencies [b3db3a2]
- Updated dependencies [c44aaf8]
- Updated dependencies [fe81419]
- Updated dependencies [93b42cd]
- Updated dependencies [a069948]
- Updated dependencies [ab0808c]
  - @cotal-ai/core@0.52.0

## 0.51.0

### Minor Changes

- 64d723e: Enable the AG-UI event plane by default for connectors that publish one. Operators and peer spawns
  can opt out explicitly, while connectors without an event plane refuse unless that opt-out is set.
- ec8649b: Preserve the closed required-events registration policy and enforce it across discovery, launch,
  grant coverage, direct connector sessions, and trusted upgrades of existing manual registrations.

### Patch Changes

- 314a12c: Refuse a malformed mesh registry record by name instead of crashing the command that reads it. A
  parseable record missing `server`, `mode`, `root`, or `ts` (or carrying a `mode`/`origin` this build
  does not know) reached the registry listing and crashed `cotal meshes` with a bare TypeError while
  `cotal status` rendered `undefined` columns; an unparseable record was silently skipped, hiding it
  from `cotal meshes rm` too. `loadMeshes` now validates every record and fails loud with the file
  path and the reason, so the operator learns which file is wrong. Every command that loads the
  registry shares the refusal.
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

- 949d4d1: Add seat checkpoints: the content-addressed record describing one preserved seat well enough to start it on another host, its writer and reader, the three admission gates a destination runs before it launches, and the per-seat writer generation that keeps one writer at a time.

  The record carries the manager's resume entry unchanged as its first field, the generation it was cut at, `capturedAt`, the recency horizon, the continuity class and the applied profile revision. Every captured file is recorded by path, byte size and sha256, and the record is written last, after those digests are computed over the bytes that landed. The writer refuses a destination that already exists and hardens it to 0700 before anything lands.

  Admission is three gates in order, each refusing with what it saw. Integrity: present, regular, non-symlink, size and sha256, with a re-stat after the read so a file that moved is a refusal. Identity: the recorded lifecycle uid is not live, the space matches, and the profile revision matches or is deliberately resumed under; this gate has no override. Recency: `capturedAt` against the destination clock and the horizon in the record, refused by default with all three values in the message, overridable by explicit operator consent that the caller records.

  The writer generation is persisted beside the manager instance identity and claimed by exclusive create on the successor value before anything launches. It uses `createManagerInstanceIdentity`'s publication primitive and deliberately not its resolution: a lost create there adopts the winner, because two managers sharing one logical instanceId is intended; here a lost create means two hosts claiming one seat, so it refuses.

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

- a0c8a59: Discover a signed-in account's advertised spaces lazily, cache validated snapshots, and add `cotal sync` for explicit refreshes.
- 26d864b: `cotal update` and `cotal update --self` complete on a machine with no recorded mesh instead of refusing with "no mesh running": there is no running manager to observe there, so the continuity read is skipped. The same holds when every recorded mesh is down and none is selected. A recorded mesh that is down still refuses when the command selects it, with `--space` or from inside its project, and so does a named space that is not running. A connect refusal that came from mesh-target resolution now carries that target error as its `cause`.
- Updated dependencies [db18070]
- Updated dependencies [64d723e]
- Updated dependencies [ade42d5]
- Updated dependencies [4f153ab]
- Updated dependencies [eb65c9b]
- Updated dependencies [4dd4b90]
- Updated dependencies [ec8649b]
- Updated dependencies [a0c8a59]
- Updated dependencies [c18c055]
- Updated dependencies [f178611]
- Updated dependencies [21407fd]
  - @cotal-ai/core@0.51.0

## 0.50.1

### Patch Changes

- Updated dependencies [c499a85]
  - @cotal-ai/core@0.50.1

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

### Patch Changes

- Updated dependencies [06eccc3]
- Updated dependencies [6f248ac]
- Updated dependencies [5e23b1d]
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
- 36d1779: Issued authority and run admission (SPEC 13.15, 14.8). A static credential is now an issuance: the issuer records its permission ceiling as evidence under a fresh generation before the material exists, its endpoint rows ride the versioned `ep.v1` rail with that generation pinned beside the caller triple, and a connected client reads its generation from an issuer-written accepted row. A hosted workflow run is admitted under the starting caller's resolved ceiling, recorded once per run in a dedicated admission store the driver cannot write, checked before every channel effect (wait open, fetch, recorded re-read, conclave writes), and revoked by an independent create-only marker that ends open waits at their next poll and refuses resume, takeover and reconcile. `run-start` on the legacy rail is refused with `permission-denied` and the `ai.cotal.ep.unbound-caller-authority` detail. `cotal run start --local` takes `--admit-read` and `--admit-publish` (required) and `cotal run revoke <runId> --local --by <who> --reason <text>` writes the marker. Three new per-space stores (`cotal_issued_`, `cotal_accepted_`, `cotal_admission_`), immutable at the broker: the admission and accepted stores are write-once per key, the evidence store is append-only and read first-on-key, and all three refuse rollup headers, message deletes and purges, so a holder of its own key row can neither widen nor erase what was recorded. Two new one-shot profiles (`issuer`, `run-admitter`), an admission read on the run mediator and operator profiles, and `COTAL_ACCEPTED_TOKEN` on every connector's spawn environment. Breaking pre-1.0 authority change.
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

- b00f3c1: Refuse a two-root daemon-credential composition at construction. The manager challenges the delivery daemon's reload-store identity before the first remint, and the refusal names both stores. Fingerprint-only reloadCreds stays once both sides read one SecretStore. A store declares its authority identity, or an injected adapter names its coordinate in COTAL_SECRET_STORE on both processes.

### Patch Changes

- 9ff5c22: Make the first manager identity on a fresh root an exclusive create. Of N concurrent starts, exactly one process mints the instance file and the others adopt that identity or refuse with a named error, so they cannot take two leases.
- 062881a: Wire `--max-sessions` from the CLI into the manager's live-session ceiling.

  `ManagerOptions.maxSessions` was documented as deployment-configurable, but nothing in the CLI
  could set it, so every live manager sat at 64. `cotal supervise --max-sessions` and
  `cotal up --max-sessions` now parse a positive integer, pass it into the manager, and record it on
  the mesh so a same-root repair, resume, or `spawn -f` that restarts the manager does not silently
  drop a raised ceiling. A refresh of an already-running manager refuses a different `--max-sessions`
  rather than recording an unapplied setting. A capacity refusal names `--max-sessions`. Default
  remains 64. Size for agents × panes: the browser console opens one session per pane.

- 13f29e1: Pin Windows teardowns to process creation time. A launch writes a sibling identity file from the UTC FILETIME of `Get-Process StartTime`, and a stop refuses when that pin no longer matches. Records with no sibling pin stay on the upgrade-only legacy path.
- Updated dependencies [a9c9849]
- Updated dependencies [b0aeca4]
- Updated dependencies [348b8b7]
- Updated dependencies [9a334ae]
- Updated dependencies [18f3df0]
- Updated dependencies [9ff5c22]
- Updated dependencies [cf6ced5]
- Updated dependencies [36d1779]
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
  - @cotal-ai/core@0.49.0

## 0.48.2

### Patch Changes

- @cotal-ai/core@0.48.2

## 0.48.1

### Patch Changes

- @cotal-ai/core@0.48.1

## 0.48.0

### Minor Changes

- b6c843f: Restrict workflow driver credentials to their own journal and record writes. Move effects and leader reads onto a separate trusted host connection, with journal ownership checks, cancellation cleanup checks, and host-held wait acknowledgements. Hosted and local runs use this split; authenticated local runs now require a recorded space signer rather than a single credentials file.

  Custom run hosts must accept the separate mediator connection. Seat-adopting effect hosts must implement `restoreMigratedSeats` so migration reads stay on the host.

  Preserve settled parent history when a version-1 fork resumes through the host, without granting the child access to parent checkpoint tokens.

### Patch Changes

- Updated dependencies [b6c843f]
  - @cotal-ai/core@0.48.0

## 0.47.1

### Patch Changes

- @cotal-ai/core@0.47.1

## 0.47.0

### Patch Changes

- @cotal-ai/core@0.47.0

## 0.46.0

### Minor Changes

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

- Updated dependencies [9d745af]
- Updated dependencies [18a0024]
  - @cotal-ai/core@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0

## 0.44.0

### Patch Changes

- @cotal-ai/core@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/core@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1

## 0.41.0

### Minor Changes

- 5ec7feb: Pin every stack pidfile to its process's creation identity before teardown. `up` writes a sibling `<pidfile>.identity` containing the pid and process start where the OS reports one. Every stop path checks it before signalling: a reused pid or torn pin is refused and preserved, and rerunning after the process is stopped clears the stale record automatically. A live pre-pin record warns and proceeds so the first teardown after an upgrade still works; relaunching writes the pin and enables full match and mismatch protection.

### Patch Changes

- Updated dependencies [de258fb]
- Updated dependencies [bac1e00]
  - @cotal-ai/core@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0

## 0.39.1

### Patch Changes

- @cotal-ai/core@0.39.1

## 0.39.0

### Patch Changes

- Updated dependencies [2277e28]
  - @cotal-ai/core@0.39.0

## 0.38.0

### Patch Changes

- 21d9552: The `--resume` spawn flag's help no longer names one connector: resume support is declared per connector and preflighted at spawn. Connector docs now mark pi's fork-resume support and describe Jcode's automatic same-identity session continuation.
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

- e703873: Report connector harness availability at manager boot and expose resolved binary paths in status.
- c09d750: Stop answering progress with presence. Textual working rows without an outside last-assistant observation render progress unknown, while heartbeat age remains explicitly labelled as liveness. The render-agnostic observation classifier lives in the workstation layer, not protocol core; compact presence-only glyphs make no progress claim. A stale observation overlays stalled Xm on still-fresh presence.
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
- Updated dependencies [b20644b]
- Updated dependencies [74c9a1b]
- Updated dependencies [bfd650c]
- Updated dependencies [e6c6947]
- Updated dependencies [b36bf50]
- Updated dependencies [3cc980d]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0

## 0.36.0

### Minor Changes

- 7c5995b: Key per-tenant material per space instead of per root. The five root-scoped kinds (the `$SYS` cred pair, `membership.json`, `membership-rw.creds`, `delivery.creds`) and every per-agent standing secret now live under `space.<hex>/` segments, migrated on first touch through one choke point that refuses — loudly, with an honest remedy — on any root it cannot show to hold a single tenant. `space rm`'s step-7 reaps land with their step-1 preconditions ahead of the verb itself. Also: the delivery daemon's `$SYS` repair advice now asks the guard instead of printing commands that refuse on the roots that need them, expired user bearers stop being re-presented on reconnect (with the retry bounded), and `agentSecretKeyForFile` takes the caller's space and checks the recorded path against it, so a stored path can no longer address another tenant's material.

### Patch Changes

- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0

## 0.35.0

### Patch Changes

- 4919a53: Render the broker config from the validated tenant inventory, so `cotal up` on a root that holds several spaces keeps every sibling account trusted instead of silently evicting it, and refuses to render while any account record is unreadable.
  - @cotal-ai/core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8

## 0.33.7

### Patch Changes

- 7119b4c: Report split trust-record validation failures with an accurate non-material trust-chain diagnostic instead of attributing every corruption to an operator-signing mismatch.
- Updated dependencies [576ac7d]
  - @cotal-ai/core@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2

## 0.29.1

### Patch Changes

- @cotal-ai/core@0.29.1

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

## 0.28.2

### Patch Changes

- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1

## 0.28.0

### Minor Changes

- 45db9f8: `cotal meshes add` can register a REMOTE mesh. `classifyJoinTarget` gains the `public-tls` reach: with recorded TLS strictness (`tlsRequired: true`) a hostname or public IP literal is registrable, because the TLS chain + hostname check — not the resolver — picks the peer; without it every verdict is unchanged, and RFC1918 stays refused in both modes. **The overlay consent gate no longer applies under required TLS.** `--allow-unencrypted-overlay` exists because an overlay address is only protected while its tunnel is up; with `--tls` (or a `tls://` scheme) the handshake proves the transport instead, so registering an overlay address now needs no flag, prompts for no acceptance, and records none — where previously every overlay registration demanded one. Without required TLS the gate is unchanged. TLS intent is now sourced (a `--tls` flag or a `tls://` scheme) and ENFORCED: the record carries it, the candidate probe honours it, and `meshes add tls://…` against a plaintext broker is a refusal rather than a silent plaintext dial. Remote user-auth registration is built but **fail-closed**: `cotal meshes add --mode user` refuses by default, naming the sequencing, because no connect path can consume a remote entry yet (the auth provider still refuses remote user-mode connects). It is enabled by the remote-exchange client work, which deletes both refusals together. Behind that fence the form is complete: `--mode user` takes its pinned trust supplied — `--user-auth-file <bundle.json>` or `--from <https://…/.well-known/cotal-mesh>` (fetched over HTTPS, pins displayed and confirmed) — verified against the pinned exchange's `/health` + `/jwks` and the broker's own auth-required refusal. Address classification canonicalizes EVERY legacy IPv4 spelling before any verdict. `inet_aton` — which the OS dialer and Node's resolver both accept — takes octal, hex and short forms, so `3232235786`, `0300.0250.01.012`, `0xC0A8010A`, `192.168.257` and `[::ffff:192.168.1.10]` are all the same private addresses that their dotted forms name, and each previously classified as a public hostname and registered while the dotted spelling was refused. They are now refused identically. **This changes verdicts for EVERY alternate spelling, not only private ranges:** a mapped loopback literal now classifies as `loopback`, a mapped overlay literal as `overlay` (so it answers to `--allow-unencrypted-overlay` and can carry a residual), and a mapped public literal as `public-tls` — each one previously fell through to whatever the unnormalized string happened to match. Anything that classified an address in a non-canonical spelling may therefore get a different, dotted-equivalent verdict now. Genuine hostnames are unaffected: a name that is not a valid IPv4 literal in any base (`09.0.0.1`, `999.1.1.1`, `1.2.3.4.5`) stays a hostname. The `--from` discovery fetch and the pinned-exchange probes refuse redirects instead of following them (a 302 can walk an HTTPS fetch onto plaintext or another host), require an `https://` endpoint, and perform no network I/O until the operator has consented to the address. Remote user entries record `userAuth.remote` and a 0600 `sentinelCredsPath` (the path, never the blob), and promote `endpoints.url` to pinned trust; `assertUserAuthInfo` fails loud on both.

### Patch Changes

- b8ee849: Announce the operator-global seed-store payload write, and its deletions, on the provenance channel. `cotal up` and the built-in-connector reconcile re-seed `~/.config/cotal/seed/store/<version>`, which is a machine-wide action (shared by every space, project directory, and checkout on the machine, moved only by `$XDG_CONFIG_HOME`), yet the store write was previously silent. It now emits a `wrote operator-global seed store payload` provenance line naming the path on each materialization, so re-seeding from a non-released checkout reads as the machine-wide write it is. The idempotent reuse path stays silent.

  The same reconcile also garbage-collects unreferenced store generations, and that was silent too. A new `removed` verb on the provenance channel names every directory the collector deletes, because a silent delete is worse than a silent write: the write at least leaves the thing it made, while the delete leaves nothing to notice. The announce rides stderr with no failure policy, so a closed stderr keeps the write and loses the line; that bound is stated at the call site and in the config reference, which also documents the isolation mechanism.

  The config reference that documents all of this ships inside the connector as well as in the docs tree, so the regenerated documentation bundle carries the same text: an agent asking `cotal_docs` for the configuration page now gets the announce, the removal announce, and the stderr bound along with everything else that page already said.

- Updated dependencies [09b6a3b]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0

## 0.27.0

### Patch Changes

- 900f630: Add the Jcode Harness API connector with a private managed session, Cotal MCP bridge, and operator documentation.
  - @cotal-ai/core@0.27.0

## 0.26.0

### Minor Changes

- aa1fe5f: `cotal attach` redeems a session grant with the seed the mesh resolved, never one walked up from the current directory.

  Resolution picks a root from the mesh registry and connects with it; redemption then asked the current directory the same question and used whatever it answered. The two disagree on a real machine rather than in theory, because root detection accepts any directory named `.cotal` and `~/.cotal` exists on every install (the mesh registry lives there). A command run anywhere under `$HOME` outside a project therefore minted its per-session credential from the home directory's trust chain and presented it to a broker that trusts a different one, surfacing as a bare authorization failure that named nothing. The trust material the resolution already carries is now used directly, which is the rule the control layer states for its own re-mints.

  A cwd anchor holding a DIFFERENT chain for the same space is reported rather than obeyed: it cannot change what the command does, but staying silent about it is how the failure stayed a mystery. `@cotal-ai/workspace` gains `divergentCwdAnchor` for that comparison, which is silent on a second checkout of the same mesh and on a directory with no anchor at all.

  The report cannot end the command either. Taking the seed from the resolution stops the current directory choosing which chain is used; it does not by itself stop it ending the run, because the report reads the walked root before the mint and the loader refuses unreadable trust material loudly. A half-written `.cotal/auth/broker.json` anywhere up the walk aborted an attach that had just declared it was not using that root, and on the reconnecting path that fault was retried as though the link were down. A fault reading either root is now reported as nothing to say, which is the accurate answer rather than a fallback: the comparison needs two legible chains, so an unreadable walked root asserts nothing and an unreadable resolved root leaves nothing to compare against. Corruption in the root the command actually reads still surfaces from the path that reads it.

  When the resolved mesh genuinely holds no seed, the refusal now names what the command resolved: the broker and the root. The old sentence named neither the root nor the mesh.

### Patch Changes

- @cotal-ai/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [b7cc4fa]
  - @cotal-ai/core@0.24.0

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

### Patch Changes

- Updated dependencies [4cf5f72]
- Updated dependencies [219d33c]
- Updated dependencies [9c2412c]
  - @cotal-ai/core@0.21.0

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

## 0.20.0

### Patch Changes

- @cotal-ai/core@0.20.0

## 0.19.0

### Patch Changes

- 24687a3: Resolve a local project against the mesh recorded for its root, whatever spelling that root arrives
  under.

  `resolveMeshTarget` looks up the registry entry recorded for the current project root and honours its
  `server` and `mode`. That lookup compared roots with `resolve()`, which normalizes separators and
  `..`/`.` but does not collapse a symlink. A recorded root is whatever spelling the operator gave:
  `cotal meshes add --root <dir>` runs its root through `resolve()` too, never realpath, so a project
  recorded under one spelling of its directory and started under another read as _unrecorded_: its
  recorded server and mode were discarded and it was silently retargeted to the default server. A
  project started on `…:4333` resolved to `…:4222`, and a recorded open mesh minted credentials off
  stale local auth state. Both comparisons now use the canonical root predicate the registry already
  applies in `meshesForRoot`, which is now exported rather than reimplemented at each call site.

- 17f14be: Name which install is behind when an extension fails to import a missing `@cotal-ai/*` export. The
  error used to prescribe `cotal ext add <extension>` for every import failure, which reinstalls
  whichever side is current: when the linked core is the older one, no reinstall of the extension can
  supply the export, so the prescribed command changes nothing. It now names the missing symbol, the
  peer copy that was actually linked (with its version and path), and the side that is behind. When the
  core is behind, or is the same version but an older build, it prescribes an exact command for the
  copy it just named: a pinned `npm i -g cotal-ai@<version>` for an installed copy, or a rebuild for a
  source checkout, where that command would be wrong. It keeps the `cotal ext add` remedy only when the
  extension is the older side, and refuses to name a side at all when the two cannot be ranked.
- Updated dependencies [48c6631]
- Updated dependencies [10d9cd6]
- Updated dependencies [a1bc784]
- Updated dependencies [a7267b3]
- Updated dependencies [ce1c248]
- Updated dependencies [5e95736]
- Updated dependencies [19931dd]
- Updated dependencies [6074c26]
- Updated dependencies [87c4130]
- Updated dependencies [cb9e1ad]
- Updated dependencies [c038730]
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [8572a5d]
  - @cotal-ai/core@0.19.0

## 0.18.0

### Minor Changes

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
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0

## 0.17.0

### Minor Changes

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

- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [2768f5b]
- Updated dependencies [019afc3]
- Updated dependencies [3539f20]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0

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

### Patch Changes

- Updated dependencies [498055c]
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

## 0.14.11

### Patch Changes

- @cotal-ai/core@0.14.11

## 0.14.10

### Patch Changes

- @cotal-ai/core@0.14.10

## 0.14.9

### Patch Changes

- a4c082a: `cotal down web` now works from any directory. The dashboard starts target-resolved (registry current mesh first) and records its pidfile under the target mesh's root, but a selective `down` only looked under the folder it ran in and reported "Nothing running for web" while the dashboard kept running. A `LocalProcess` can now declare `rootedAt: "target"`; `down` resolves such components through the same mesh-target resolution the start side uses, with a new `cotal down web --space <name>` to name the mesh explicitly. Bare `cotal down` remains a folder-scoped sweep, and folder-rooted components refuse `--space`.
  - @cotal-ai/core@0.14.9

## 0.14.8

### Patch Changes

- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8

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

  - @cotal-ai/core@0.14.7

## 0.14.6

### Patch Changes

- ed62069: Stop a slow link from deleting a live mesh's registry entry on connect.

  0.14.3 made the registry _sweep_ (`pruneStaleMeshes`) confirm a failure before removing an entry.
  The connect-time path was left with the original behavior, and that is the one that actually bites:
  `preflightTarget` probes with `probeConnect`, whose default budget is one second, and passes no
  override. That probe completes a full auth handshake — TCP, INFO, then the JWT exchange, several
  round trips — which a perfectly healthy broker across a slow or jittery link (a relayed overlay VPN,
  a loaded host) cannot finish in a second.

  The verdict is destructive: a registry-sourced failure deletes the entry and reports "no mesh running
  (stale registry entry - removed)". Both halves of that are wrong when the cause was latency, and for
  a mesh this machine did not start it is unrecoverable, since only `cotal up` writes registry records.
  Observed repeatedly against a reachable remote mesh whose broker was up the whole time.

  A first probe failure now only makes the target a candidate: it is re-probed with a budget that fits
  a real network before anything is classified or removed. A genuinely dead or genuinely
  credential-rejected mesh reaches the same verdict as before, one extra probe later.

  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- @cotal-ai/core@0.14.5

## 0.14.4

### Patch Changes

- @cotal-ai/core@0.14.4

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

  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- @cotal-ai/core@0.14.2

## 0.14.1

### Patch Changes

- @cotal-ai/core@0.14.1

## 0.14.0

### Minor Changes

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

### Patch Changes

- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/core@0.14.0

## 0.13.2

### Patch Changes

- c3afdaa: fix(renewal): prove the broker accepted a re-signed daemon credential before reporting it adopted

  `cotal doctor auth` could report a renewal "adopted" that the broker never accepted (a false green). The daemon's credential-reload path now proves acceptance on a disposable preflight connection before it adopts, and the record + `doctor` verdict only ever claim what was proven:

  - The delivery-admin `reloadCreds` reply narrows to `brokerAccepted` (identity/iat/exp actually accepted) plus a best-effort `residentSwap`, never an unwitnessed "adopted".
  - The passive 75% renewal timer and the explicit reload share one single-flight transaction and both preflight before installing a candidate, so a rejected credential in the store can never strand the live connection.
  - The whole daemon-side transaction is deadline-bounded (under the manager's request bound) with a late-commit fence, so a hung store fails loud instead of a silent "no responder".
  - `cotal doctor auth` now exits non-zero and says so when the last renewal was refused by the broker, instead of letting cred-file health alone stand as healthy.
  - The ephemeral generation fingerprint used to bind the expected generation is redacted at the persistence boundary, so it never lands in `.cotal/renewal.json` or logs.

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
  - @cotal-ai/core@0.13.2

## 0.13.1

### Patch Changes

- @cotal-ai/core@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [5491661]
  - @cotal-ai/core@0.13.0

## 0.12.0

### Minor Changes

- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.

### Patch Changes

- be66729: Add offline full-space and registry-only backup, preservation cuts, authenticated operation-isolated
  restore, conservative checkpoint recreation, same-principal resume, and explicit fallback cleanup.
  Remove the incomplete channel export surface.
- Updated dependencies [be66729]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/core@0.12.0

## 0.11.6

### Patch Changes

- 7b24953: Rebind extension peer links to the current Cotal host before lazy import, allowing global installs and source worktrees to share one extension prefix. Keep the Hermes launcher self-contained so it does not resolve a mutable host peer after launch.
  - @cotal-ai/core@0.11.6

## 0.11.5

### Patch Changes

- @cotal-ai/core@0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.
- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4

## 0.11.3

### Patch Changes

- @cotal-ai/core@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/core@0.11.2

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

## 0.10.1

### Patch Changes

- e3a53e3: Add a connector-agnostic model/variant selector: the `cotal models` command, a `--variant` flag on spawn, and the core `listModels` / `ModelCatalog` + `LaunchOpts.variant` contract. OpenCode discovers its models and variants from the installed CLI; Claude and Hermes reject variants (fail loud) and set `COTAL_MODEL` when a model is given.
- Updated dependencies [e3a53e3]
  - @cotal-ai/core@0.10.1

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

## 0.9.1

### Patch Changes

- Updated dependencies [14510c3]
  - @cotal-ai/core@0.9.1

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

## 0.8.3

### Patch Changes

- Updated dependencies [a10ed79]
  - @cotal-ai/core@0.8.3

## 0.8.2

### Patch Changes

- @cotal-ai/core@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [15fb826]
  - @cotal-ai/core@0.8.1

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
