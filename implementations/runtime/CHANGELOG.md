# @cotal-ai/runtime

## 0.109.24

### Patch Changes

- Updated dependencies [0bffcb0]
  - @cotal-ai/workspace@0.109.24
  - @cotal-ai/core@0.109.24
  - @cotal-ai/lang@0.109.24

## 0.109.23

### Patch Changes

- @cotal-ai/core@0.109.23
  - @cotal-ai/lang@0.109.23
  - @cotal-ai/workspace@0.109.23

## 0.109.22

### Patch Changes

- @cotal-ai/core@0.109.22
  - @cotal-ai/lang@0.109.22
  - @cotal-ai/workspace@0.109.22

## 0.109.21

### Patch Changes

- @cotal-ai/core@0.109.21
  - @cotal-ai/lang@0.109.21
  - @cotal-ai/workspace@0.109.21

## 0.109.20

### Patch Changes

- Updated dependencies [ffeaa32]
  - @cotal-ai/workspace@0.109.20
  - @cotal-ai/core@0.109.20
  - @cotal-ai/lang@0.109.20

## 0.109.19

### Patch Changes

- @cotal-ai/core@0.109.19
  - @cotal-ai/lang@0.109.19
  - @cotal-ai/workspace@0.109.19

## 0.109.18

### Patch Changes

- @cotal-ai/core@0.109.18
  - @cotal-ai/lang@0.109.18
  - @cotal-ai/workspace@0.109.18

## 0.109.17

### Patch Changes

- Updated dependencies [dc382c0]
  - @cotal-ai/core@0.109.17
  - @cotal-ai/workspace@0.109.17
  - @cotal-ai/lang@0.109.17

## 0.109.16

### Patch Changes

- @cotal-ai/core@0.109.16
  - @cotal-ai/lang@0.109.16
  - @cotal-ai/workspace@0.109.16

## 0.109.15

### Patch Changes

- @cotal-ai/core@0.109.15
  - @cotal-ai/lang@0.109.15
  - @cotal-ai/workspace@0.109.15

## 0.109.14

### Patch Changes

- Updated dependencies [60e6671]
  - @cotal-ai/core@0.109.14
  - @cotal-ai/workspace@0.109.14
  - @cotal-ai/lang@0.109.14

## 0.109.13

### Patch Changes

- @cotal-ai/core@0.109.13
  - @cotal-ai/lang@0.109.13
  - @cotal-ai/workspace@0.109.13

## 0.109.12

### Patch Changes

- @cotal-ai/core@0.109.12
  - @cotal-ai/lang@0.109.12
  - @cotal-ai/workspace@0.109.12

## 0.109.11

### Patch Changes

- Updated dependencies [e85774c]
  - @cotal-ai/workspace@0.109.11
  - @cotal-ai/core@0.109.11
  - @cotal-ai/lang@0.109.11

## 0.109.10

### Patch Changes

- Updated dependencies [e9f4793]
  - @cotal-ai/workspace@0.109.10
  - @cotal-ai/core@0.109.10
  - @cotal-ai/lang@0.109.10

## 0.109.9

### Patch Changes

- Updated dependencies [841d980]
  - @cotal-ai/workspace@0.109.9
  - @cotal-ai/core@0.109.9
  - @cotal-ai/lang@0.109.9

## 0.109.8

### Patch Changes

- Updated dependencies [36b0c06]
- Updated dependencies [c592eb8]
  - @cotal-ai/workspace@0.109.8
  - @cotal-ai/core@0.109.8
  - @cotal-ai/lang@0.109.8

## 0.109.7

### Patch Changes

- @cotal-ai/core@0.109.7
  - @cotal-ai/lang@0.109.7
  - @cotal-ai/workspace@0.109.7

## 0.109.6

### Patch Changes

- @cotal-ai/core@0.109.6
  - @cotal-ai/lang@0.109.6
  - @cotal-ai/workspace@0.109.6

## 0.109.5

### Patch Changes

- Updated dependencies [a32425e]
  - @cotal-ai/workspace@0.109.5
  - @cotal-ai/core@0.109.5
  - @cotal-ai/lang@0.109.5

## 0.109.4

### Patch Changes

- @cotal-ai/core@0.109.4
  - @cotal-ai/lang@0.109.4
  - @cotal-ai/workspace@0.109.4

## 0.109.3

### Patch Changes

- @cotal-ai/core@0.109.3
  - @cotal-ai/lang@0.109.3
  - @cotal-ai/workspace@0.109.3

## 0.109.2

### Patch Changes

- Updated dependencies [4f6f406]
  - @cotal-ai/workspace@0.109.2
  - @cotal-ai/core@0.109.2
  - @cotal-ai/lang@0.109.2

## 0.109.1

### Patch Changes

- @cotal-ai/core@0.109.1
  - @cotal-ai/lang@0.109.1
  - @cotal-ai/workspace@0.109.1

## 0.109.0

### Patch Changes

- Updated dependencies [82cb60d]
  - @cotal-ai/core@0.109.0
  - @cotal-ai/workspace@0.109.0
  - @cotal-ai/lang@0.109.0

## 0.108.1

### Patch Changes

- Updated dependencies [25e980f]
  - @cotal-ai/workspace@0.108.1
  - @cotal-ai/core@0.108.1
  - @cotal-ai/lang@0.108.1

## 0.108.0

### Patch Changes

- Updated dependencies [7657395]
  - @cotal-ai/workspace@0.108.0
  - @cotal-ai/core@0.108.0
  - @cotal-ai/lang@0.108.0

## 0.107.0

### Minor Changes

- 0ae11a6: One manager can host seats on different terminal runtimes at the same time.
  
  `cotal spawn --runtime <name>` with `-d` or `--on`, `cotal_spawn` with `runtime`, and a workflow `spawn(persona, { runtime })`, choose the runtime of that one seat. A seat that names none keeps the runtime the manager was started with. An unknown or unreachable runtime, and `auto`, refuses the launch and starts nothing. Stopping, attaching, and recovery follow the runtime recorded for that seat, so a later seat does not move one that is already running.

### Patch Changes

- Updated dependencies [0ae11a6]
  - @cotal-ai/lang@0.107.0
  - @cotal-ai/core@0.107.0
  - @cotal-ai/workspace@0.107.0

## 0.106.1

### Patch Changes

- @cotal-ai/core@0.106.1
  - @cotal-ai/lang@0.106.1
  - @cotal-ai/workspace@0.106.1

## 0.106.0

### Patch Changes

- Updated dependencies [dd1f8d6]
- Updated dependencies [ba25fb6]
- Updated dependencies [54a2996]
  - @cotal-ai/workspace@0.106.0
  - @cotal-ai/core@0.106.0
  - @cotal-ai/lang@0.106.0

## 0.105.1

### Patch Changes

- @cotal-ai/core@0.105.1
  - @cotal-ai/lang@0.105.1
  - @cotal-ai/workspace@0.105.1

## 0.105.0

### Patch Changes

- Updated dependencies [c49bced]
- Updated dependencies [6e16f06]
  - @cotal-ai/workspace@0.105.0
  - @cotal-ai/core@0.105.0
  - @cotal-ai/lang@0.105.0

## 0.104.2

### Patch Changes

- @cotal-ai/core@0.104.2
  - @cotal-ai/lang@0.104.2
  - @cotal-ai/workspace@0.104.2

## 0.104.1

### Patch Changes

- Updated dependencies [c6021e5]
  - @cotal-ai/lang@0.104.1
  - @cotal-ai/core@0.104.1
  - @cotal-ai/workspace@0.104.1

## 0.104.0

### Patch Changes

- e0c4e6e: Correct the documentation page by page against the implementation, including CLI commands, connector delivery and activity sharing, authentication, observer surfaces, hosted composition, telemetry and historical design status. Refresh package guides and generated tool and HTTP references while preserving existing links and normative contracts.
- Updated dependencies [e0c4e6e]
- Updated dependencies [b7d4f22]
  - @cotal-ai/core@0.104.0
  - @cotal-ai/lang@0.104.0
  - @cotal-ai/workspace@0.104.0

## 0.103.4

### Patch Changes

- Updated dependencies [e6af269]
  - @cotal-ai/workspace@0.103.4
  - @cotal-ai/core@0.103.4
  - @cotal-ai/lang@0.103.4

## 0.103.3

### Patch Changes

- 2b59b43: `run-status` and `cotal run show --json` now carry the run's `programHash`, the same value its
  `run-ps` row carries, read from that run's own program record. Checking one run's program identity
  no longer needs a full `run-ps` scan of every run. The hash is absent when the run has no recorded
  program. A program record that cannot be read or parsed gives `programUnreadable` with its reason
  and no hash, and the rest of the status view is unchanged. The manager contract moves to revision 39.
- Updated dependencies [2b59b43]
  - @cotal-ai/core@0.103.3
  - @cotal-ai/workspace@0.103.3
  - @cotal-ai/lang@0.103.3

## 0.103.2

### Patch Changes

- Updated dependencies [2f74981]
  - @cotal-ai/workspace@0.103.2
  - @cotal-ai/core@0.103.2
  - @cotal-ai/lang@0.103.2

## 0.103.1

### Patch Changes

- Updated dependencies [68377b0]
- Updated dependencies [1608ae7]
  - @cotal-ai/core@0.103.1
  - @cotal-ai/workspace@0.103.1
  - @cotal-ai/lang@0.103.1

## 0.103.0

### Patch Changes

- @cotal-ai/core@0.103.0
  - @cotal-ai/lang@0.103.0
  - @cotal-ai/workspace@0.103.0

## 0.102.0

### Patch Changes

- Updated dependencies [9a75f1b]
- Updated dependencies [bf8978b]
- Updated dependencies [10ad6d3]
- Updated dependencies [d0d9e66]
  - @cotal-ai/core@0.102.0
  - @cotal-ai/workspace@0.102.0
  - @cotal-ai/lang@0.102.0

## 0.101.7

### Patch Changes

- Updated dependencies [668ef6a]
- Updated dependencies [ae43b58]
  - @cotal-ai/core@0.101.7
  - @cotal-ai/workspace@0.101.7
  - @cotal-ai/lang@0.101.7

## 0.101.6

### Patch Changes

- Updated dependencies [52832dc]
- Updated dependencies [49cf781]
  - @cotal-ai/workspace@0.101.6
  - @cotal-ai/core@0.101.6
  - @cotal-ai/lang@0.101.6

## 0.101.5

### Patch Changes

- Updated dependencies [e6f1f4d]
  - @cotal-ai/core@0.101.5
  - @cotal-ai/workspace@0.101.5
  - @cotal-ai/lang@0.101.5

## 0.101.4

### Patch Changes

- Updated dependencies [0642c8f]
  - @cotal-ai/core@0.101.4
  - @cotal-ai/workspace@0.101.4
  - @cotal-ai/lang@0.101.4

## 0.101.3

### Patch Changes

- Updated dependencies [c54a604]
- Updated dependencies [a677726]
- Updated dependencies [330127a]
  - @cotal-ai/workspace@0.101.3
  - @cotal-ai/core@0.101.3
  - @cotal-ai/lang@0.101.3

## 0.101.2

### Patch Changes

- Updated dependencies [9acfc57]
- Updated dependencies [d57e596]
- Updated dependencies [427f28b]
  - @cotal-ai/core@0.101.2
  - @cotal-ai/workspace@0.101.2
  - @cotal-ai/lang@0.101.2

## 0.101.1

### Patch Changes

- Updated dependencies [091498f]
- Updated dependencies [446fd91]
- Updated dependencies [bdafbf9]
- Updated dependencies [0379e03]
  - @cotal-ai/workspace@0.101.1
  - @cotal-ai/core@0.101.1
  - @cotal-ai/lang@0.101.1

## 0.101.0

### Patch Changes

- 71e8b88: `cotal run amend` for a run ID that no run is recorded under now says no run is recorded under that
  ID. With `--local`, an amend that finds no answer to amend is refused `TARGET_NOT_FOUND`, exit 2, as
  the hosted amend is, where it reported an unknown outcome although nothing was written.
- b3738e8: `cotal run amend` sent right after an accepted answer, before the run has recorded it, now says the answer was accepted and is not recorded yet, and to amend once the step lists it. Before, it said the step was "still open, so answer it instead", which sent the caller to a pause that had already taken their answer.
- c22bcff: `cotal run answer` for a run ID that no run is recorded under now says no run is recorded under
  that ID, where it said no step is recorded under that key. With `--local` it is refused
  `TARGET_NOT_FOUND`, exit 2, as the hosted answer is, where it reported an unknown outcome although
  nothing was written.
- 9d6d515: The plain receipt of `cotal run answer` and `cotal run amend` printed the whole `--value` on one line, so a 100 KB value made a 100,015-character line. It now cuts a value longer than 120 characters, as `run show` does, with a line that says so. `--json` and the stored answer still carry the value whole.
- 6d8d964: `cotal run answer` and `cotal run amend` now refuse a `--value` whose record would differ from what was typed, with `SCHEMA_INVALID` and nothing sent. That covers an object that names a key twice (JSON kept only the last), a number outside the range JSON carries such as `1e999` (recorded as null before), and a value nested more than 1000 levels deep. A value nested a few thousand levels deep failed before with a raw "Maximum call stack size exceeded", exit 1, and no `--json` envelope.
- 0c9e498: A refusal that repeats an over-long argument, such as an unknown command or subcommand, a space name given to `use` or `--space`, or a run id, now shows its first 128 characters and its length. A 100000-character value used to print a line as long as itself. The command still checks and uses the whole value.
- c86562e: `cotal run check` of a run ID with no record on the endpoint is now refused `TARGET_NOT_FOUND`, exit
  2, with `cotal run` as its Next, as `run show` refuses it. It used to print a bare line and exit 1.
- 0282994: `run start --file`, `run simulate --handler`, `auth mint --out` and `--identity`, and `--creds` on a
  command with no completer of its own complete from the shell's file names. A flag declares that with
  the new optional `FlagSpec.completion: "files"`. `spawn` completes the personas of a prepared space
  that is not started, as `persona show` does.
- 9e0b1c5: `run validate` and `run start` now refuse a literal that is not a duration where a program reads
  one, such as `sleep("5")`, `sleep(5000)` or a checkpoint `timeout` of `"PT5M"`, with L2034 and the
  same text the call gives. Such a program used to validate and start, then fail its run at the call.
  `run start` and `run resume` refuse a `--timeout` that is not a duration longer than zero with
  `USAGE_INVALID`, where it used to start a run whose checkpoints then failed.
- 50e13e5: `ps` and the hosted `run` verbs now say what to do when the space's manager runs but does not
  answer. `ps` waited out its deadline and refused "no manager reachable" with no Next, although this
  root's stack manager was running. It now names that manager's pid and gives as Next ending that
  process, so bare `cotal up` starts the manager again. `run start`, `run ps` and the other hosted
  verbs exited 1, the usage code, with only the rail paragraph. They now refuse `TARGET_UNAVAILABLE`
  (exit 2) with the same sentence, and their Next is `cotal status`, which names a stack manager that
  runs but does not answer, with its pid.
- 216829d: Local workflow answers and amendments missing `--by <who>` now refuse `USAGE_INVALID` before
  contacting the broker, with a JSON envelope under `--json` and a direct step naming the required
  flag. Previously they reached the local handler and printed raw usage with empty JSON output.
  The explicit local answerer requirement and hosted authenticated-caller attribution are unchanged.
- 44193ff: `--json` or `--plain` on `cotal run revoke`, `run check`, `run start --local` and
  `run resume --local` now names a form that takes the flag, or the same command without it where
  there is none, and prints no help. It used to say to use the hosted form, which revoke and check do
  not have.
- e4516c7: `cotal run start --local` and `cotal run resume --local` of a program that fails now report the
  failure the run's status records: `OPERATION_FAILED`, exit 5, naming the run and its language code
  with that code's title, or the first line of the recorded message when the code has none, with
  `cotal run show <runId> --local` as the next step. Before, they
  reported an unknown outcome, exit 3, with the whole multi-line message flattened onto one line as
  literal `\u000a` escapes and no next step. Any other error the drive ends on is still unknown.
- 0c7e317: On a terminal, more Next lines now keep each command whole when they wrap. Four of them name their
  commands in backticks now: `space delete` of a running space, `run answer` with a step name that
  matches an open request, `down` and `down --dry-run` beside a running service, and `up` in a moved
  folder that `space create --adopt` takes over. Before, at 80 columns, the `space delete --dry-run`
  Verdict of a space with a long name printed `cotal reset store` at the end of one line and the
  name on the next.
- b432707: A step that a race cancelled in a losing branch now says so. `run show` labels its row
  `cancelled, <branch> won <race>`, and `run answer` at that step is refused with `that step was
  cancelled because branch <branch> won the race <race>` instead of `that step has already settled`.
- 66af07b: `run show` names the branch a settled `race` took, and marks `not acted on` an answer whose step was in a losing branch, or whose pause was cancelled after accepting it. Such an answer used to be listed as acted on, or not at all. The journal rows carry the race's `winner` and each losing step's `lostRace` in `--json`.
- 985f634: Refusals that named no next step now carry a remedy, in the JSON envelope's `error.remedy` and under Next in the text report: an unknown or missing `config` key, a `config` value, space name or `--space` it refuses, `persona show` and `persona remove` for a persona that does not exist, `persona create` for one that does, `run validate` of a file that cannot be read, and `service show` or `service remove` of a definition that is not saved. The envelope reference now says that `remedy` is present when a refusal names a step.
- d92c955: `cotal run show` now explains that a released status records no reason and points to the executing
  manager's log for hosted runs or the driving process's output for local runs. It does not infer an
  execution host or log location from a journal read. Status, JSON, journal limits and resume behavior
  are unchanged; this is evidence guidance, not a recorded cause or a prevention of repeated release.
- c3f6d9b: `cotal run revoke`, its help and the workflow docs now say that a revoke does not cancel the run:
  work that touches no channel, such as a `sleep` and `log` loop, keeps running until the host driving
  it stops. The docs name each way to stop that host and what else it stops.
- 64e45c8: `cotal run revoke --local` with an empty or blank `--by` or `--reason` now names that flag, says
  nothing was written and gives the command to run, without printing the whole `run` help.
- 5961162: `cotal run revoke --local` of a run ID with no admission on the endpoint is now refused
  `TARGET_NOT_FOUND`, exit 2, before anything is written, with `cotal run` as the next step. It used
  to write a revocation marker for that ID and then exit 1 with a refusal citing a spec section.
- e5ddaed: A revoked workflow run no longer takes an answer. `cotal run answer`, hosted or `--local`, refuses an open checkpoint or `ask` of a revoked run with `LIFECYCLE_BLOCKED`, naming who revoked it and why, and files nothing, so the run stays parked instead of completing. A revocation marker that cannot be read refuses the answer the same way. `cotal run show` still lists the open request, says that it takes no answer, and no longer offers the answer command. SPEC §14.8 states the rule.
- 1d2da78: The refusals a revoked run gets, on `cotal run resume` and on `cotal run answer`, no longer end in
  a spec section reference.
- 5a4267c: `run start --local` refuses an `--admit-read` or `--admit-publish` entry that is not a channel or a
  pattern, such as `a b`, with `USAGE_INVALID` naming it. It used to be admitted as the channel the
  wire layer rewrote it to, `a_b`.
- 8722113: `run answer` and `run amend` refuse an empty or blank `--artifact` with `USAGE_INVALID` naming the
  flag. An empty one used to print the manager's raw schema error, and a blank one was recorded.
- cc3ec77: `cotal run answer --local` and `cotal run amend --local` now print the same receipt as the hosted path: the step, the value filed or that none was given, any artifact and the answer id, with `result.answer` under `--json`, and a Next of `cotal r show <run> --local`. Before, they printed the raw answer record as unlabelled JSON.
- 2538025: When `run answer` is given a checkpoint's name instead of its step key, the refusal now names the
  open step key that matches.
- 1533e53: The receipt of a hosted `cotal run answer` and `cotal run amend` now names the step, the value it filed and the answer id, and says "no value; --value was not given" when no `--value` was passed. With `--json` the same is in `result.answer`, with `valueGiven`. Before, the receipt said only "Answer accepted", so an answer sent without `--value` settled the step with no value and nothing said so. The CLI reference now says what an answer without a value records.
- 8554325: Repeating `cotal run answer` right after it was accepted now gets the same `TARGET_NOT_FOUND` refusal as a later repeat, with a next step. Before, until the run recorded the first answer, a few seconds later, it got the checkpoint plane's raw conflict, with an opaque token, an epoch time and a spec section.
- 720c959: The `run` command's usage line, receipts and next steps, and the run docs, now name the canonical
  forms: bare `cotal run` to list runs, `run show` and `run check`. `ps` (or `list`), `journal` and
  `migrate` still work, and the CLI reference lists them as compatibility aliases.
- acac7de: `run check` and `run migrate` on an edited program that does not validate print each problem's
  code, position, cause and fix instead of only the problem count. `run show` on a run that failed
  outside any step says no journal row records why and names the stack manager's log.
- 5fc1af5: `run show` and the text journal now show beside an open checkpoint's question whom its `to` escalates
  it to, and once it has escalated, until when that attempt is open.
- b3426bb: A failed workflow run now records why it failed. The run driver writes the error's language code, when it has one, and its message (bounded to 4000 characters) on the failed run status as `failure`. `cotal run ps` and `cotal run show` print the state as `failed (<code>)`, the run view prints the message under `Failure`, and the JSON status and `ps` rows carry `failure`. Before, a thrown error, an L4010 null access, an L4013 step budget or an L4023 deadline showed only "failed", and the cause was only in the manager's log. SPEC §13.7 adds the optional field.
- c4fc7f7: `run show` on a run that failed outside any step no longer follows the cause its status recorded
  with a line saying no journal row records why. That line now shows only when the status recorded
  no cause either.
- 80e389f: A hosted `cotal run` verb (`answer`, `show`, `ps` and the others the manager serves) refuses a raw `--creds` file `UNSUPPORTED`, exit 2, with one refusal envelope under `--json`. Its next step is to run the verb again without `--creds`, where the CLI mints the one-shot caller from the project folder or the `--space` registration. Before, it printed an unformatted line and exited 1, and `--json` printed nothing.
- 0ba68ef: A malformed run ID is now one usage refusal on every `cotal run` verb that takes one. `show`, `journal`, `answer`, `amend`, `resume`, `revoke` and `check` refuse an ID that is not 1 to 64 letters, digits, `_` or `-` with `USAGE_INVALID`, exit 1, naming the format, before anything is contacted. Before, the same local check came back as exit 5 on `show` and `journal`, exit 3 "Outcome unconfirmed" on `answer`, `amend` and `resume`, and an unformatted error on `revoke` and `check`.
- e2f5e0d: `cotal run show` and `cotal run journal` take `--limit <n>`, from 1 to 1000, for how many of the
  last journal rows the text view prints. The view printed only the last 20, and the only way to read
  more was `--json`. `--limit` with `--json` is refused, since the JSON result holds the whole journal.
- cc023f7: `cotal run show` and `cotal run journal` read a run whose journal is larger than the broker's
  payload limit. They read the journal from the manager in pages, each one reply, through a new
  `journal: { offset }` input on `run-status` that answers the rows from that offset that fit, with
  `journalTotal`. A record or a single row too large for one reply now refuses `UNSUPPORTED` and
  names `cotal run journal <run-id> --local`, instead of failing with the broker's payload error.
- fc38933: A `cotal run start` or `resume` past the manager's limit of 8 runs activating at once is now a clean refusal. The manager refuses before it writes the run's admission, marks the refusal `not-executed`, and names the runs still activating, and the CLI reports it as `LIFECYCLE_BLOCKED`, exit 2, with the next step to wait until one has activated and run it again. Before, the manager wrote the admission first, and the CLI reported the refusal as exit 3 "Outcome unconfirmed" with a "retry" hint it then told the caller not to follow. The limit is now in the run docs.
- 598e00f: A hosted `cotal run` command whose `--on` names none of the space's running managers is now refused
  `TARGET_NOT_FOUND` at once, naming the pin and the managers that run, with nothing sent. It used to
  wait out the ten-second describe deadline and then refuse `TARGET_UNAVAILABLE`, saying the registered
  manager did not answer on the versioned rail.
- 45e73eb: `cotal run ps` now prints who revoked each revoked run and why under the table, as the workflow
  docs say it does. The table itself still shows the run as `admission revoked`.
- cebc2c9: `run ps --endpoint <endpoint>` that matches no run now says that no run record lives under that
  endpoint and names the endpoints runs are recorded under, with an `ENDPOINT_HAS_NO_RUNS` warning.
  It used to print an empty list with no hint.
- d69fea2: A `run resume` refused because the run is already completed or failed now names
  `cotal run show <runId>` as the next step.
- 01defbe: A hosted `cotal run revoke` now gets one refusal whether or not it passes `--by`: it names `--local --by <actor> --reason <text>`, which revoke requires. Before, `run revoke <id> --by <who>` was told that `--by` is only for the local path, while `run revoke <id>` was told it requires `--by`.
- ec3da5d: `cotal run show` no longer prints a long answer value whole in its Answers table. A value longer than 120 characters is cut, and a line says so and points to `--json`, which carries it whole. Before, one 100 KB answer padded every row of the table to its width, and the view printed about 300 KB for three rows.
- 8d8c6e7: A `run` verb given a workflow source it cannot read now names the path and the cause: it does not
  exist, it is a link whose target does not exist (`TARGET_NOT_FOUND`), it is a directory
  (`USAGE_INVALID`), or it is not readable (`PERMISSION_DENIED`). `-` is read as a path, and its
  refusal says that it does not mean standard input.
- ba9b70e: `cotal run validate` and a hosted `cotal run start` now refuse an empty program file the same way, `SCHEMA_INVALID` with a next step, and `--json` gets its envelope. Before, validate passed the file, and start printed a raw input-schema line on stderr and exited 1 with no JSON.
- 571fe68: The `cotal run` verbs that read a program file now refuse one that is not valid UTF-8 with `SCHEMA_INVALID`. Before, its bytes were replaced with U+FFFD, so a Latin-1 checkpoint question was stored and shown corrupted, with no warning.
- e382f0c: A hosted `cotal run start` interrupted with Ctrl-C or `SIGTERM` after its request went out now says the manager may already have recorded the run, with outcome `unknown` and a pointer to `cotal run ps`, and still exits 130 or 143. Before, it exited silently while the manager went on to record the run, so a retry started a second one.
- 90ed4a4: A hosted `cotal run start` of a program larger than the broker's message limit is now refused `UNSUPPORTED`, naming the program's size and the limit, with a next step. Before, it was reported as an unconfirmed outcome with exit 3, although nothing was sent and no run was created.
- efe931a: A hosted `run start` refused for a program that does not validate now prints each problem with its
  control characters escaped, as `run validate` does, so a step name cannot write terminal escapes.
- 86bfcdb: `cotal run` refuses a mesh it cannot resolve or connect to under the refusal's own code, before any request, hosted or `--local`. With no mesh running, `cotal run ps` is refused `TARGET_NOT_FOUND`, exit 2, with one refusal envelope under `--json`, as `cotal ps` is. Before, it printed a plain line and exited 1 with no envelope.
- 9f009b4: Correct the turn API comment: the manager marks a reaped seat's pending turns and carries `agentDownAt` on the deadline terminal. The client's presence watch supplies the early L4002 failure, including while the manager is running.
- 81f9522: A workflow deadline short enough to pass while its pause was being armed failed the step L4000, "pause … was due … and nothing was minted for it", instead of ending it as that deadline's expiry does. A `wait` with a `1ms` timeout now resolves `null`, an `idle` window of `1ms` returns its event, a `waitUntil` with a `1ms` cadence observes again until its deadline fails it with L4023, and a `1ms` or `2ms` checkpoint expires for its `onExpiry` to act on. A `wait` still opens its channel under the run's read admission first, so a channel the run may not read is refused as before. `sleep` and `ask` already ended this way.
- 02c327b: A `run simulate` that stops names why: an unscripted effect names its table, step name and step
  key with the entry to add, and a program fault names its code and cause. The `--handler` file
  format is documented.
- 761c861: `cotal run simulate` now tells a program that fails under its script apart from a script that does not cover the program. A program failure, such as a checkpoint scripted `expired` under the default `onExpiry: "fail"` (L4007), is a completed simulation, exit 0, whose program outcome is failed: it shows the step and that step's outcome with the language's error, and the JSON result carries `outcome` and `failure` beside the effects that ran. A script with no result for an effect (L6001) still does not complete, exit 5, and now names the step and the entry to add. Before, both printed "the offline simulation did not complete; unscripted effects are not invented" with a null result. `dryRunOutcome` returns a failed program's report with its fault, and `dryRun` takes an optional `journal`, so a caller can read the step a dry run that did not complete stopped at.
- 4041d91: `cotal run simulate --handler` now refuses a scripted turn result whose `status` is not `done`,
  `blocked` or `handoff`, or that scripts `at`, an unknown field or a `note` that is not a string, with
  `SCHEMA_INVALID`, as it refuses a malformed checkpoint result. It used to hand that result to the
  program, which then ran on a status no live turn returns.
- 531b374: When a space's streams are gone from a broker that still runs, `cotal status` says so and names the
  way back, and `send`, `history` and `run ps` refuse with that cause. On an open space that another
  machine deleted under a running stack, status showed the space as reachable, `send` exited 3 with
  "may have been stored", `history` reported an empty conversation and `run ps` printed a raw
  contract-store error. Status now shows `Space streams: not on the broker` and leads its Next with
  `cotal down --yes`, then `cotal up`, or with `cotal up` when the stack's other members are stopped.
  The three commands refuse `TARGET_UNAVAILABLE` with the same remedy.
- 58b025c: Every subcommand's help now gives its whole usage, from `cotal` through its arguments, such as
  `cotal channel set <name>` and `cotal persona create <name>`, and lists only the options that
  subcommand takes. `help history clear` no longer prints a usage without `cotal history`, and the
  usages of `meshes`, `personas`, `spawn`, `backup`, `describe`, `invoke`, `actor`, `agent-bearer`
  and `service-endpoint` now start with `cotal`.
- b12b86b: When a registered manager does not answer, as after a crash, `input` and `stop` refuse
  `TARGET_UNAVAILABLE` because nothing was sent, instead of reporting an unconfirmed outcome. That
  refusal, and the one `cotal run`'s hosted verbs give, now leads with "the manager registered for this
  space did not answer".
- 8294fdb: `cotal run validate` now names the broker's message limit among what it did not check, and the CLI
  docs say a valid program over that limit is still refused by a hosted `start`.
- 22e7127: A refusal of a value that names its own fix no longer prints the command's whole help after it. An
  `--on` that is empty, a principal id or not an instance id, a `spawn --on` that needs a terminal or
  `-d`, `attach` with no name and no terminal, and a `run` command given no run id now print the
  refusal and its next step only. The `run` refusal names `cotal run ps`, or `cotal run turns` for
  `yield`.
- 78a2035: A workflow's `log(...)` lines are no longer discarded. A run the manager hosts writes each line to
  the manager's log as `run <run-id>: log <text>`, a `--local` drive prints them, and `run simulate`
  lists them under `Log`, with `result.log` in `--json`. The lines stay out of the journal, as the
  language defines.
- Updated dependencies [ff99364]
- Updated dependencies [71e8b88]
- Updated dependencies [b3738e8]
- Updated dependencies [c22bcff]
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
- Updated dependencies [b926504]
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
- Updated dependencies [9e0b1c5]
- Updated dependencies [e5ea994]
- Updated dependencies [e53c3a3]
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
- Updated dependencies [2895911]
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
- Updated dependencies [94207f0]
- Updated dependencies [788bf15]
- Updated dependencies [2093a48]
- Updated dependencies [7b97877]
- Updated dependencies [b2fcd9c]
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
- Updated dependencies [b432707]
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
- Updated dependencies [761c861]
- Updated dependencies [ce05dbf]
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
  - @cotal-ai/lang@0.101.0
  - @cotal-ai/core@0.101.0

## 0.100.2

### Patch Changes

- Updated dependencies [8d81c12]
- Updated dependencies [bb4145f]
  - @cotal-ai/core@0.100.2
  - @cotal-ai/workspace@0.100.2
  - @cotal-ai/lang@0.100.2

## 0.100.1

### Patch Changes

- Updated dependencies [8bb8900]
- Updated dependencies [546b661]
- Updated dependencies [86b2cd5]
- Updated dependencies [b1d2cb5]
  - @cotal-ai/core@0.100.1
  - @cotal-ai/lang@0.100.1
  - @cotal-ai/workspace@0.100.1

## 0.100.0

### Patch Changes

- 8360fbf: With the space's manager stopped, `cotal run` and its hosted verbs and `cotal models` refuse at once, as `cotal ps` does: `TARGET_UNAVAILABLE` (exit 2) with the Mesh header, the registry's own answer as the native detail, and bare `cotal up` as the next step. They used to wait about 10 seconds for a manager answer that could not come and then print a refusal about the `ep.v1` rail with no code or next step. An unpinned operator call reads the service registry first and refuses only when it lists no live manager; an unreadable registry, a pinned call and a user's manager view go to the manager as before. Core marks the registry's empty answer with a new `ai.cotal.ep.no-live-instances` detail, so a caller can tell it from an unreadable registry.
- 72272d6: `cotal run check` no longer tells you to pass `--discard-approvals` when an edit drops an answered checkpoint, an override that `run check` refuses because it decides what a migration commit does. The L5004 reason now says to keep the checkpoint in the edited program, or to discard the decision in a migration commit under the `--discard-approvals` override.
- 4a8f6b6: A hosted `cotal run` verb the manager refuses now reports the outcome and code as other commands do, with `--json` as one refusal envelope. `run show` of a run the manager holds no record of is `TARGET_NOT_FOUND`, exit 2, and names `cotal run ps`. It used to print `run status: …` on stderr, write nothing on stdout and exit 1.
- 183fa2a: A workflow program file that cannot be read is now refused with `TARGET_NOT_FOUND`, exit 2, by `cotal run start`, `run start --local`, `run resume --local --file` and `run check`, as `run validate`, `plan` and `simulate` already refused it. `run start` and `resume` reported the raw `ENOENT` as an unknown outcome with exit 3, and `run check` printed it as a bare error with exit 1. The `--json` envelope now names the file as its target.
- 19f64b8: The `cotal run answer` and `cotal run amend` receipts now name the run in their Next line and their JSON target. They printed `cotal r show <run-id>` although the command had named the run.
- 2f8b98b: `cotal run show` and `run journal` list a pause under `Needs an answer` only while its last journal row is pending, and offer `answer` as a next step only when one is open. A checkpoint that was answered or expired kept its earlier pending rows in the journal, so completed and failed runs still listed it as needing an answer. A pause settled with an accepted answer now prints that answer's value, answerer, artifact when present, time and answer id, then one `amended` line per later amendment, as the docs describe; before, only `--json` carried them.
- 6471d27: `cotal run show` and `cotal run journal` now say why a step failed. A failed or refused step's journal row carries its recorded `errorMessage` beside `errorCode` in `--json`, and the text view lists each such step with its outcome and message under `Step errors`, escaping control characters. Before, both views printed only `failed (L4000)`, and the reason, such as a hosted run that is not admitted to read a channel, was only in the manager's log. The manager's `run-status` reply schema admits the new field.
- c807eeb: `cotal run simulate` refuses a results script whose scripted checkpoint result is not one `checkpoint()` can return, with `SCHEMA_INVALID` (exit 1) naming the checkpoint and the problem. A status other than `resolved` or `expired`, a missing status, a non-object entry, an unknown field or a scripted `at` used to simulate as a resolved answer and report `ok`, and a scripted `at` was dropped without a word.
- 41e50de: `cotal run validate`, `run plan` and `run simulate` list every problem in a program that does not validate: its code, title, position, cause and fix, as a hosted `run start` refusal lists them. They used to print only `the workflow is not valid cotal-lang` with no problem at all, and `--json` carried only each problem's code and span. The JSON envelope now carries the full problems under `result.problems`, beside the unchanged `SCHEMA_INVALID` refusal.
- a80904f: `cotal run validate`, `plan` and `simulate` now say what each validator warning is: its code, title, position, cause and fix, on stderr and in the `--json` envelope's `warnings`, and `validate --json` lists each one under `result.warnings` with the same fields. Before, a warning printed only "The language validator reported a warning at this source position.", so a `fanOut` over a literal list with no `key` validated with no visible reason and then failed its run with L3021.
- e091aa8: A workflow `wait` given a value that is not an event, such as `wait("never-sent")`, now fails its step with a message that names the four event constructors and the value it was given. Before, the hosted and local runtime failed it with the host's own `Cannot read properties of undefined (reading 'split')`.
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
- Updated dependencies [9f69a20]
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
  - @cotal-ai/lang@0.100.0

## 0.99.3

### Patch Changes

- Updated dependencies [96325dc]
- Updated dependencies [15effd7]
  - @cotal-ai/core@0.99.3
  - @cotal-ai/workspace@0.99.3
  - @cotal-ai/lang@0.99.3

## 0.99.2

### Patch Changes

- Updated dependencies [74a688d]
  - @cotal-ai/core@0.99.2
  - @cotal-ai/workspace@0.99.2
  - @cotal-ai/lang@0.99.2

## 0.99.1

### Patch Changes

- Updated dependencies [1708ce5]
- Updated dependencies [50de78d]
  - @cotal-ai/core@0.99.1
  - @cotal-ai/workspace@0.99.1
  - @cotal-ai/lang@0.99.1

## 0.99.0

### Patch Changes

- Updated dependencies [8aac50d]
- Updated dependencies [6999190]
  - @cotal-ai/workspace@0.99.0
  - @cotal-ai/core@0.99.0
  - @cotal-ai/lang@0.99.0

## 0.98.0

### Patch Changes

- Updated dependencies [b6e3fba]
- Updated dependencies [c445511]
  - @cotal-ai/core@0.98.0
  - @cotal-ai/workspace@0.98.0
  - @cotal-ai/lang@0.98.0

## 0.97.1

### Patch Changes

- Updated dependencies [aa8d11e]
  - @cotal-ai/core@0.97.1
  - @cotal-ai/workspace@0.97.1
  - @cotal-ai/lang@0.97.1

## 0.97.0

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
  - @cotal-ai/lang@0.97.0

## 0.96.1

### Patch Changes

- @cotal-ai/core@0.96.1
  - @cotal-ai/lang@0.96.1
  - @cotal-ai/workspace@0.96.1

## 0.96.0

### Patch Changes

- Updated dependencies [083205e]
  - @cotal-ai/core@0.96.0
  - @cotal-ai/workspace@0.96.0
  - @cotal-ai/lang@0.96.0

## 0.95.2

### Patch Changes

- @cotal-ai/core@0.95.2
  - @cotal-ai/lang@0.95.2
  - @cotal-ai/workspace@0.95.2

## 0.95.1

### Patch Changes

- @cotal-ai/core@0.95.1
  - @cotal-ai/lang@0.95.1
  - @cotal-ai/workspace@0.95.1

## 0.95.0

### Patch Changes

- Updated dependencies [b7acdcc]
  - @cotal-ai/workspace@0.95.0
  - @cotal-ai/core@0.95.0
  - @cotal-ai/lang@0.95.0

## 0.94.7

### Patch Changes

- @cotal-ai/core@0.94.7
  - @cotal-ai/lang@0.94.7
  - @cotal-ai/workspace@0.94.7

## 0.94.6

### Patch Changes

- Updated dependencies [ba9155a]
- Updated dependencies [520c66b]
  - @cotal-ai/workspace@0.94.6
  - @cotal-ai/core@0.94.6
  - @cotal-ai/lang@0.94.6

## 0.94.5

### Patch Changes

- Updated dependencies [4b64fe7]
  - @cotal-ai/workspace@0.94.5
  - @cotal-ai/core@0.94.5
  - @cotal-ai/lang@0.94.5

## 0.94.4

### Patch Changes

- Updated dependencies [464413c]
  - @cotal-ai/workspace@0.94.4
  - @cotal-ai/core@0.94.4
  - @cotal-ai/lang@0.94.4

## 0.94.3

### Patch Changes

- @cotal-ai/core@0.94.3
  - @cotal-ai/lang@0.94.3
  - @cotal-ai/workspace@0.94.3

## 0.94.2

### Patch Changes

- @cotal-ai/core@0.94.2
  - @cotal-ai/lang@0.94.2
  - @cotal-ai/workspace@0.94.2

## 0.94.1

### Patch Changes

- @cotal-ai/core@0.94.1
  - @cotal-ai/lang@0.94.1
  - @cotal-ai/workspace@0.94.1

## 0.94.0

### Patch Changes

- Updated dependencies [1caaf63]
  - @cotal-ai/core@0.94.0
  - @cotal-ai/workspace@0.94.0
  - @cotal-ai/lang@0.94.0

## 0.93.0

### Patch Changes

- Updated dependencies [e27c44c]
- Updated dependencies [69b0538]
- Updated dependencies [6703917]
  - @cotal-ai/core@0.93.0
  - @cotal-ai/workspace@0.93.0
  - @cotal-ai/lang@0.93.0

## 0.92.2

### Patch Changes

- Updated dependencies [43a5715]
- Updated dependencies [736207e]
  - @cotal-ai/core@0.92.2
  - @cotal-ai/workspace@0.92.2
  - @cotal-ai/lang@0.92.2

## 0.92.1

### Patch Changes

- Updated dependencies [5a0b741]
  - @cotal-ai/core@0.92.1
  - @cotal-ai/workspace@0.92.1
  - @cotal-ai/lang@0.92.1

## 0.92.0

### Minor Changes

- 1db940e: Add authenticated cooperative workflow cancellation through the manager endpoint. The original caller can cancel under a live issued generation; signerless hosts also verify interactive owner or admin authority through the issuing host. Replies distinguish the durable revocation marker from an observed local drive outcome, preserve unknown write outcomes and retain the first marker. Read-only status inspection remains available after revocation without permitting new drive or checkpoint-answer authority. The run show view displays revocation separately from recorded state and returns a partial result with exit 4 when the marker cannot be read, in human and JSON output.

  Breaking: embedded RunHostDrive implementations must supply cancel(reason) separately from release(reason). Both language engines and the worker bridge propagate cooperative root cancellation. This does not preempt external tools, stop agent processes or prove resource cleanup. No new CLI or MCP convenience command is added.

### Patch Changes

- edf54df: `cotal run start --local`, `run resume --local` and `run revoke` given a single `--creds` file are refused as a usage error again, exit 1, with the command to run instead. Since the command-line redesign the same refusal was reported as "Outcome unconfirmed" with `OPERATION_UNKNOWN` and exit 3, although no run had been admitted and no workflow record written.
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
  - @cotal-ai/lang@0.92.0

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

- 5c85ef3: The command line resolves, validates and explains a command before it does anything. A usage error (an unknown command, an unknown flag, a missing value, or a first word a command does not declare as a subcommand) now exits 1 before the built-in connectors are seeded or any configuration is written. Before, every command but help reconciled the connector store first, so a mistyped flag installed the connectors and only then printed the refusal.

  - Bare `cotal` names the selected space, lists the common commands and points a machine with no selected space to `cotal setup`. It starts nothing.
  - `cotal help [command] [subcommand] [--all]` prints the command list or one command's or subcommand's help; `--help` and `-h` print the same. `cotal version` prints the version, as do `--version` and `-V`. Breaking: `-v` no longer prints the version and is refused; it is reserved for `--verbose`.
  - Commands can declare aliases, subcommands with their own aliases, structured outputs and examples. This release adds `sp` (spawn), `a` (attach), `s` (status), `r` (run), `x` (ext), `h` (history) and `cotal ext rm`. A word is never matched by prefix. The registry refuses a name or alias another command already claims, and `cotal ext add` refuses an extension whose name or alias an installed extension claims, naming both.
  - Completion resolves an alias as dispatch does.

### Patch Changes

- 3deea9d: Name the mesh before and after more operations. `service stop`, `service restart` and a named service-set stop now begin the impact they show for review with `Mesh: <space>`, as `down` does. The `space delete` and `reset space` previews, the manager gate repair review, the foreground notices of `up`, `team boot` and `service start`, the attach picker's partial-list notice and setup's agent-joined notice name the mesh too. A classified failure raised after a command resolved its space now carries that space in `target.space` and begins with `Mesh: <space>`, even when the failing step named no space. A target that already names a space is kept as it is.
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
  - @cotal-ai/lang@0.91.0

## 0.90.1

### Patch Changes

- @cotal-ai/core@0.90.1
- @cotal-ai/workspace@0.90.1
- @cotal-ai/lang@0.90.1

## 0.90.0

### Patch Changes

- Updated dependencies [88ab21e]
- Updated dependencies [b928aaa]
  - @cotal-ai/core@0.90.0
  - @cotal-ai/workspace@0.90.0
  - @cotal-ai/lang@0.90.0

## 0.89.0

### Minor Changes

- bab4ca8: Add explicit bounded diagnostic pages for native run inventory, preserving legacy list requests and existing permissions. CLI and MCP callers can continue a pinned scan without a full-list reply or an absence claim.

### Patch Changes

- Updated dependencies [dc458a4]
- Updated dependencies [bab4ca8]
- Updated dependencies [2905ae9]
  - @cotal-ai/core@0.89.0
  - @cotal-ai/workspace@0.89.0
  - @cotal-ai/lang@0.89.0

## 0.88.0

### Patch Changes

- Updated dependencies [fc923a5]
- Updated dependencies [cb09213]
- Updated dependencies [a3ae00f]
  - @cotal-ai/workspace@0.88.0
  - @cotal-ai/core@0.88.0
  - @cotal-ai/lang@0.88.0

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
  - @cotal-ai/workspace@0.87.0
  - @cotal-ai/lang@0.87.0

## 0.86.0

### Patch Changes

- b7f4af7: `@cotal-ai/core` now exports `digestIdToken`, the one recipe behind every id derived from a digest (the 43-character base64url sha256). Run notice and migration ids, checkpoint answer ids, the runtime's derived pause tokens and the manager's turn hold token all use it. Before this, each module kept its own copy, so a change to one copy could pass the typecheck and quietly stop matching the ids the others derive. The derived ids are unchanged.
- 8d97d8a: Callers can name a manager instance wherever a user-auth mesh with several live managers for one owner asks them to. `cotal models` and every hosted `cotal run` verb take `--on <instance>`, and MCP `cotal_run` and `cotal_personas` take an `instance` argument under the same rules as `cotal_spawn`'s. A `cotal` command run from a managed seat's shell now selects the manager that launched the seat (`COTAL_MANAGER_INSTANCE`), as the seat's tools already did, unless `--on` names another. The ambiguity refusal still refuses, and now lists the owner's live manager instance ids and names the caller's own remedy: `--on <instanceId>` for the CLI, the `instance` argument for an agent's tools. Before, it named `--manager-instance`, which only `cotal agent-bearer` takes, so none of these callers could answer it.
- 600783b: Report an unanswered placed-host discovery as catchable unreachable L4002 before relay submission. Preserve accepted-goal uncertainty and permission refusals. Keep a migrated seat's original host in its durable binding and restored roster, and refuse incompatible placement requests without consuming its kept hand-over.
- 00f631a: A run that names a placement instance now sends its placed seats' turns to that instance. Before, those turns went out on the class rail, where only the hosting manager maps the seat, so a live seat could be reported down once the re-issue budget ran out. The run host credential gains owner-pinned `turn` on that one instance only. Unplaced runs keep their class-rail reach, and their L4002 message no longer claims more than the members the call reached.
- 8c8a99c: Attach the seat-address documentation to its type in a single JSDoc block.
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
- Updated dependencies [add70b8]
- Updated dependencies [e754d4f]
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
  - @cotal-ai/lang@0.86.0

## 0.85.0

### Patch Changes

- d5e7a87: The manager's `turn` command schemas now live in `@cotal-ai/core` as `TURN_INPUT_SCHEMA` and `TURN_OUTPUT_SCHEMA`. The manager registers them unchanged, so its cluster document and contract digests stay the same. The five runtime suites that serve a manager-shaped `turn` compile the same objects instead of their own copies, which had drifted from the manager's contract and could not notice it changing.
- Updated dependencies [6e10d50]
- Updated dependencies [ff09b5c]
- Updated dependencies [7840cea]
- Updated dependencies [d5e7a87]
  - @cotal-ai/core@0.85.0
  - @cotal-ai/workspace@0.85.0
  - @cotal-ai/lang@0.85.0

## 0.84.0

### Patch Changes

- Updated dependencies [6d48a0b]
- Updated dependencies [b4c8812]
- Updated dependencies [9229264]
  - @cotal-ai/core@0.84.0
  - @cotal-ai/workspace@0.84.0
  - @cotal-ai/lang@0.84.0

## 0.83.0

### Patch Changes

- Updated dependencies [d663fa4]
  - @cotal-ai/core@0.83.0
  - @cotal-ai/workspace@0.83.0
  - @cotal-ai/lang@0.83.0

## 0.82.2

### Patch Changes

- @cotal-ai/core@0.82.2
- @cotal-ai/workspace@0.82.2
- @cotal-ai/lang@0.82.2

## 0.82.1

### Patch Changes

- Updated dependencies [9061234]
- Updated dependencies [423d250]
- Updated dependencies [b526a5e]
  - @cotal-ai/workspace@0.82.1
  - @cotal-ai/core@0.82.1
  - @cotal-ai/lang@0.82.1

## 0.82.0

### Patch Changes

- d06b27e: A cancelled `turn`, `ask` or escalation whose relay withdrawal is refused for a reason a retry cannot change now fails its step at once with that refusal's code. Before this, every refusal was retried silently every two seconds until the relay's deadline, so a cancelled step against a manager that serves no `cancel` (`not-found`), or an accepting manager with no such relay pending (`failed-precondition`), stayed in its scope for the step's whole timeout. Only `unavailable` and `deadline-exceeded` are still retried until the deadline. A withdrawal the accepting manager refuses is now thrown as an `EpEnvelopeError` carrying its code.
- Updated dependencies [4f52881]
- Updated dependencies [6afa12f]
- Updated dependencies [7c6c109]
- Updated dependencies [9a93a58]
  - @cotal-ai/core@0.82.0
  - @cotal-ai/workspace@0.82.0
  - @cotal-ai/lang@0.82.0

## 0.81.1

### Patch Changes

- @cotal-ai/core@0.81.1
- @cotal-ai/workspace@0.81.1
- @cotal-ai/lang@0.81.1

## 0.81.0

### Patch Changes

- Updated dependencies [c166107]
  - @cotal-ai/core@0.81.0
  - @cotal-ai/workspace@0.81.0
  - @cotal-ai/lang@0.81.0

## 0.80.0

### Patch Changes

- 99c74fe: Complete an authorized relative sleep when its duration elapses before the first checkpoint mint. Preserve cancellation, existing-pause replay and checkpoint expiry rules.
- Updated dependencies [5417401]
- Updated dependencies [71e6311]
- Updated dependencies [3614fdd]
- Updated dependencies [e00402f]
- Updated dependencies [80f66fd]
- Updated dependencies [0835254]
  - @cotal-ai/core@0.80.0
  - @cotal-ai/workspace@0.80.0
  - @cotal-ai/lang@0.80.0

## 0.79.0

### Patch Changes

- fbc3e2d: Whether a consumer info or delete found no consumer is now decided by one predicate, `isConsumerNotFound` in `@cotal-ai/core`, which accepts only the broker's structured `ConsumerNotFound` error. It no longer accepts a bare `name` of `ConsumerNotFoundError` or a string `code`, so the run journal's replay cleanup no longer swallows those shapes. The stream, KV scan, run wait, delivery `pending` and auth scanner sites use it in place of their own copies, and `isJetStreamMissing`, the structured check it builds on, is exported beside it.
- Updated dependencies [50747b1]
- Updated dependencies [fbc3e2d]
- Updated dependencies [c535d98]
- Updated dependencies [36b03b0]
- Updated dependencies [2bd492c]
- Updated dependencies [5e9a618]
- Updated dependencies [7cb89f9]
- Updated dependencies [aaa6bc9]
- Updated dependencies [db962ae]
- Updated dependencies [4aafb0d]
- Updated dependencies [92590e8]
- Updated dependencies [c03f2af]
- Updated dependencies [79ace0f]
  - @cotal-ai/workspace@0.79.0
  - @cotal-ai/core@0.79.0
  - @cotal-ai/lang@0.79.0

## 0.78.1

### Patch Changes

- @cotal-ai/core@0.78.1
- @cotal-ai/workspace@0.78.1
- @cotal-ai/lang@0.78.1

## 0.78.0

### Patch Changes

- 6db45e5: The mesh-ask smoke's manager stand-in now serves the reserved `cancel`, committing the relay's goal `cancelled` as the manager does, so a cancelled ask and the discharge withdraw their relay instead of failing on a command the stand-in never described. Cell 7 passes again and the suite runs cells 8 to 11 and its summary. Cell 11's resumed escalation now records its attempt index on its binding, as every checkpoint binding has since each attempt began binding its own deadline.
- 87fa2c3: A `wait`'s outer timeout token and a `waitUntil` observation's pause token are now each derived in one named function, which both the arm site and the pause-ownership table call. Before, the purpose strings were spelled by hand at every arm site and again in the ownership table, so renaming one side still typechecked and the run authority then refused the pause at run time with L4000. Behavior is unchanged.
- c164c80: A manager-hosted or `--local` run's `wait(down(agent), { timeout })` and `wait(replied(agent), { timeout })` now wait, and resolve `null` when the timeout passes. They used to fail with L4000 before waiting: both armed their timeout without recording it on the step, and the run refuses to mint a wait timer the step did not record. `wait` now records the timers for every event before it branches to the agent-addressed waits.
- Updated dependencies [a7f39aa]
- Updated dependencies [981b567]
- Updated dependencies [8b92413]
- Updated dependencies [a74b832]
- Updated dependencies [d04629a]
- Updated dependencies [905a78b]
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
  - @cotal-ai/lang@0.78.0

## 0.77.1

### Patch Changes

- @cotal-ai/core@0.77.1
- @cotal-ai/workspace@0.77.1
- @cotal-ai/lang@0.77.1

## 0.77.0

### Patch Changes

- Updated dependencies [6861390]
- Updated dependencies [7d1b600]
  - @cotal-ai/core@0.77.0
  - @cotal-ai/workspace@0.77.0
  - @cotal-ai/lang@0.77.0

## 0.76.0

### Patch Changes

- 0cd1f60: An `ask` attempt and an escalated `checkpoint` now relay the instant their pause denies at, and the manager holds the relay to that instant. The relay used to send a duration the manager counted from its own acceptance, so the manager could still serve an attempt after its pause had expired, by the submit's round trip plus clock skew, or by up to a second from a one-second floor. The manager's `turn` command takes `deadlineAt` as an alternative to `deadlineMs` and refuses a relay whose deadline has already passed with `deadline-exceeded`. The run reads that refusal as nobody left to tell only when its own clock also shows the deadline passed. An `ask` whose deadline passes before its attempt's pause is minted now ends with its own `ask-deadline` L4006 instead of an L4000 from the refused mint.
- 8e0876b: Comments in core, the manager and the runtime cite SPEC sections and code symbols instead of line numbers. Nine of those line numbers pointed at unrelated text, including the `EpGateState.space` doc in core's published types, which also named §13.9 for the per-space auth bucket that §13.12 defines. The comments now name the alias-reuse gate in the manager's spawn path, `resolveService`'s `instanceId` option and the `pinnedInstanceId` it returns, the spawn affinity gate, the auth session ledger's `reconcileSessionForTakeover`, and each SPEC section without a line. No behavior changes.
- e65de9e: Fix a hosted `checkpoint` with `onExpiry: "escalate"` failing L4000 every time its first attempt expired. The escalated attempt read the first attempt's binding as its own, so it armed at the first attempt's already-passed deadline and never recorded its own. Each attempt now binds its index with its deadline: the escalation opens with a fresh `timeout`, records its addressee and deadline, and a resumed attempt keeps the deadline it recorded.
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
- Updated dependencies [ea15e8d]
- Updated dependencies [9adcf1c]
- Updated dependencies [15d10c9]
- Updated dependencies [0eb8eff]
- Updated dependencies [ba76f78]
- Updated dependencies [f2a4bde]
- Updated dependencies [8be669e]
- Updated dependencies [42b28aa]
- Updated dependencies [720dbc3]
  - @cotal-ai/core@0.76.0
  - @cotal-ai/workspace@0.76.0
  - @cotal-ai/lang@0.76.0

## 0.75.0

### Patch Changes

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
  - @cotal-ai/lang@0.75.0

## 0.74.0

### Patch Changes

- 5443012: The runtime's poll and retry loops now wait through one shared helper, whose timer never holds the process open. Each loop used to build its own wait inline, and the copies disagreed: the checkpoint answer's mint-window retry kept the process alive while every other wait did not. That retry now follows the same rule, which changes nothing a caller can see, because it reads over a broker connection that already keeps the process alive.
- Updated dependencies [f3e6f95]
- Updated dependencies [328d59b]
- Updated dependencies [ac251fd]
- Updated dependencies [e3498d9]
  - @cotal-ai/core@0.74.0
  - @cotal-ai/workspace@0.74.0
  - @cotal-ai/lang@0.74.0

## 0.73.0

### Patch Changes

- Updated dependencies [9873985]
  - @cotal-ai/core@0.73.0
  - @cotal-ai/workspace@0.73.0
  - @cotal-ai/lang@0.73.0

## 0.72.1

### Patch Changes

- Updated dependencies [07fe6b3]
  - @cotal-ai/core@0.72.1
  - @cotal-ai/workspace@0.72.1
  - @cotal-ai/lang@0.72.1

## 0.72.0

### Patch Changes

- Updated dependencies [c5a45ab]
- Updated dependencies [18e7e91]
  - @cotal-ai/core@0.72.0
  - @cotal-ai/workspace@0.72.0
  - @cotal-ai/lang@0.72.0

## 0.71.0

### Patch Changes

- 518351a: A run's `turn` and `wait(down)` no longer read a seat as down while the manager still runs it. On a loaded host a live seat's presence heartbeats could stall for more than the 30-second lapse window while its process kept working, and the run failed the turn with L4002 (`lapsed`) although the seat went on to finish its step. Once a lapse is confirmed from presence, the run now asks the manager with `inspect`: if the manager still runs that incarnation, the 30 seconds start over; if the manager that spawned the seat no longer runs it, or that manager does not answer, the lapse stands and the turn fails with L4002 as before. In a space with several managers, another manager's miss does not count, since a manager knows only its own seats. The asking stops at a cancellation, the wait's timeout, or the turn's deadline or yield, so a late answer or refusal never replaces the timeout's `null` or the turn's own outcome. A run host's credential now carries the `inspect` request for this.
- Updated dependencies [b9daf53]
- Updated dependencies [3518435]
- Updated dependencies [726a750]
- Updated dependencies [3400d53]
- Updated dependencies [518351a]
  - @cotal-ai/core@0.71.0
  - @cotal-ai/lang@0.71.0
  - @cotal-ai/workspace@0.71.0

## 0.70.2

### Patch Changes

- @cotal-ai/core@0.70.2
- @cotal-ai/workspace@0.70.2
- @cotal-ai/lang@0.70.2

## 0.70.1

### Patch Changes

- b83ec25: `cotal run migrate` no longer says a pending orphaned `waitUntil`'s cadence timer "is released with the run's other timers". Nothing releases that pause, so the row now says only that the edit stops the wait and its recorded observations stay in the journal, as the §11.2 orphan table does. A single observation now reads "1 recorded observation stays".
- 25237f0: A workflow run that cancels a branch now withdraws what that branch relayed to a seat. The manager serves the reserved `cancel` (SPEC 13.6 item 4) for a turn it relays: the caller's own goal moves to `cancelling`, leaves `turn-pending` and ends `cancelled`, and a later yield of it is answered with that terminal. A goal that already ended is refused with its cached outcome, and one the manager does not relay is refused unchanged. The run sends it as a cancelled `turn`, `ask` attempt or escalated `checkpoint` unwinds, before the branch's scope settles, and its cancellation sweep sends it again for a process that died first. In a space with more than one manager, a cancel refused by a manager other than the one that accepted the relay is sent again until the accepting manager answers. A cancel the accepting manager refuses is sent again until it lands or the relay's deadline passes, and a failed read of that deadline is retried as well (a goal record that is not JSON fails the step at once), so a transient failure no longer lets the branch's scope settle with the relay still on the seat. Before this, a race loser's turn stayed on the seat: the seat could still pull and answer it, and because a seat is shown one turn at a time, the run's next turn to that seat waited behind it until its deadline. The hosted run's credential carries the new `cancel` row, and the manager's cluster document moves to revision 23.
- Updated dependencies [9c99ee5]
- Updated dependencies [da6dba0]
- Updated dependencies [032522a]
- Updated dependencies [5c6c92d]
- Updated dependencies [6d81d61]
- Updated dependencies [fe54eb0]
- Updated dependencies [1ef1396]
- Updated dependencies [66a0f19]
- Updated dependencies [2be1384]
- Updated dependencies [25237f0]
- Updated dependencies [6bd6099]
- Updated dependencies [ed1e171]
  - @cotal-ai/core@0.70.1
  - @cotal-ai/lang@0.70.1
  - @cotal-ai/workspace@0.70.1

## 0.70.0

### Minor Changes

- 83a6352: A run on the compiled engine no longer reports a value the program threw as a host hold or release. The worker thread used to copy `code`, `reason`, `step` and `kind` off whatever was thrown, and the host rebuilt `RunHeld` or `RunReleased` from the code alone, so `throw { code: "L5025", reason: "..." }` came back as a held run with the placeholder step `(step not carried)`, and `throw { code: "L5012", ... }` as a release. Both now fail as the plain value they are, as they do on the walker. `WorkerRunFailed` is now a union discriminated by `class` (`released`, `held`, `effect`, `too-large`, `rejected` or `error`). The thread picks the variant with `instanceof`, each variant requires its class's fields, and the host rebuilds the class with no defaults. `tooLarge` is replaced by the `too-large` variant's `stepKey`, `bytes` and `bound`. This breaks code that calls `runInWorker` itself: `code` now crosses only on the `effect` and `error` variants, so a caller that branched on `L5012`, `L5025`, `L5006` or `L5010` branches on `class` instead.

### Patch Changes

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
- Updated dependencies [83a6352]
- Updated dependencies [15b7920]
  - @cotal-ai/workspace@0.70.0
  - @cotal-ai/core@0.70.0
  - @cotal-ai/lang@0.70.0

## 0.69.0

### Patch Changes

- 94996e5: The scope kinds' traits now come from one record keyed by `ScopeKind`, exported as `scopeTraits`, which returns a frozen row: whether a scope settles an assembly of branch outcomes, and whether a fork whose cut lies inside it re-enters it. The journal seed check, the scope value rule, the static captured-write check (L2032) and `planFork` read it instead of keeping their own kind lists, so a scope kind added to `ScopeKind` does not compile until it is classified. Before, a new kind compiled with a list missed and failed only at run time, for example a settled no-return scope of that kind refused at the journal seed with L5024. Shipped behaviour is unchanged.
- 0c5b205: `cotal run start`, `resume`, `ps`, `journal` and `answer` now re-describe and re-issue an unpinned manager call that a sibling manager refused before running it, up to the same 16 attempts the CLI's manager commands use. Before, one such refusal ended the command, so in a space with two managers about half of these calls failed with a refusal saying the command was not run. A hosted run's own manager calls now use that bound too instead of 8. The repair is one core helper, `invokeRepairingSplit`, which the CLI and the runtime both call.
- 848497f: A hosted run's presence reader now keeps only rows whose `card` carries a string `id` and `name`, and skips every other value the way it already skipped bytes that are not JSON. A participant that published `null` under its own presence key used to make every `wait(down(...))`, turn liveness poll, conclave join and worktree-reuse check in that space fail with `L4000` (`Cannot read properties of null (reading 'card')`). Those reads now ignore the row and answer about the agent they watch.
- f409b46: A `waitUntil` whose first observation is not terminal now waits out its cadence on a host that checks journal authority (a manager-hosted run, or `cotal run start --local`) and fails `L4023` at its deadline. Before, its second observation failed `L4000`: the interpreter sent the observation index as the effect's attempt, which the run authority refused, and the authority listed no pause token for a `waitUntil` cadence. Which pause tokens a step owns is now one table that the run authority, the adoption re-arm and a cancelled branch's discharge all read, so a cancelled `waitUntil` on a hosted run also releases its open cadence pause.
- Updated dependencies [f5cb8e1]
- Updated dependencies [2d45766]
- Updated dependencies [03a7405]
- Updated dependencies [a256e2f]
- Updated dependencies [3f3d04a]
- Updated dependencies [4500563]
- Updated dependencies [1bdc7f2]
- Updated dependencies [94996e5]
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
- Updated dependencies [f409b46]
  - @cotal-ai/workspace@0.69.0
  - @cotal-ai/core@0.69.0
  - @cotal-ai/lang@0.69.0

## 0.68.0

### Minor Changes

- 6141e7b: The issuing host no longer signs an answering run operator for a checkpoint token a participant manager names. The manager's request now names the run and step it answers (`operator.answers: { runId, stepKey, amend? }`), and the host requires that run admitted on the manager's instance, reads the pause's token off the run's journal under a read it mints for that run, and requires a served answer to name the same run and step as the request it observed. Before, a manager could be issued the answer and settle writes for another instance's waiting pause. The pause lookups `openCheckpointToken`, `settledPauseToken`, `stepPauseToken`, `CheckpointNotOpen` and `CheckpointNotAmendable` move to `@cotal-ai/lang`; `@cotal-ai/runtime` still exports the first four. A participant manager and its issuing host must upgrade together.

### Patch Changes

- Updated dependencies [6141e7b]
- Updated dependencies [4120c97]
- Updated dependencies [218006f]
- Updated dependencies [681c5b0]
- Updated dependencies [585fdb2]
- Updated dependencies [a5256fd]
- Updated dependencies [0d806ae]
- Updated dependencies [b38a683]
- Updated dependencies [d5ea4d2]
- Updated dependencies [54e0199]
- Updated dependencies [9b439e8]
- Updated dependencies [41a7e66]
- Updated dependencies [f018376]
- Updated dependencies [6a1789b]
- Updated dependencies [237c813]
  - @cotal-ai/core@0.68.0
  - @cotal-ai/lang@0.68.0
  - @cotal-ai/workspace@0.68.0

## 0.67.0

### Patch Changes

- c3601f9: A logged-in user's workflow run on a `cotal supervise` participant manager can spawn, turn and despawn agents that user owns and receive their typed answers. The run's spawn takes the admin reach of the user who started the run, read from that user's actor-ledger row when the spawn runs, so a space that requires the event plane no longer refuses it and a revoked login demotes it. The host pins each run mediator it signs for a participant manager to a placement on that manager's own instance, so a program may place a spawn there; a placement on any other instance is refused at `run start`. A completed run now releases a seat by the identity its spawn terminal records, so a seat the host enrolled at its own lifecycle UID is despawned instead of left running.
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
  - @cotal-ai/lang@0.67.0
  - @cotal-ai/workspace@0.67.0

## 0.66.1

### Patch Changes

- Updated dependencies [568f718]
  - @cotal-ai/workspace@0.66.1
  - @cotal-ai/core@0.66.1
  - @cotal-ai/lang@0.66.1

## 0.66.0

### Patch Changes

- a9be586: Apply the driver's result bound on the compiled engine. A hosted run on language version 2 never received the result bound that `cotal run` and the manager derive from the broker's `max_payload`, so an oversized effect result was recorded when it fit the store, or released as the store's own L5010 when it did not. The bound now reaches the journal the worker thread builds, an oversized `ok` result is refused ahead of the settling append (L5006) as it is on version 1, and the host rebuilds that refusal as `EffectResultTooLarge`, so the driver releases the run instead of recording it as failed. `WorkerRunRequest` gains `resultBytes`, refused outside the bridged route, and `WorkerRunFailed` gains `tooLarge`.
- Updated dependencies [a9be586]
- Updated dependencies [a07f732]
- Updated dependencies [be53e2d]
- Updated dependencies [658c1b8]
- Updated dependencies [af779f9]
  - @cotal-ai/lang@0.66.0
  - @cotal-ai/core@0.66.0
  - @cotal-ai/workspace@0.66.0

## 0.65.0

### Minor Changes

- 8577576: Add `once`, an at-most-once scope for cotal-lang steps that write to a far side. A resume that finds a step inside `once` begun and never settled does not dispatch it again: it opens a hold, a checkpoint minted under `holdRequestId` of the step's recorded request id, and the answer becomes the step's result, while an expired hold fails the step with the catchable L4027. A hold the host refuses leaves the step pending rather than refused, so no later host writes again, and its L5025 says so. A hold whose checkpoint answers an outcome other than `resolved` or `expired` fails the step as a handler fault. Only `ask` runs inside `once`; every other effect is refused before it begins (L4028), and a write from the body to a binding outside it is refused (L2032). The journal entry gains a `hold` field for the hold's own binding. The hosted runtime ends the held `ask`'s open attempt pause before the hold binds, and `cotal run answer`, `cotal run amend` and `cotal run journal` read a held step at its hold. A fork may cut inside `once`, and a migration ignores an orphaned `once`. `once` becomes a reserved name, so a program that declares its own `once` binding is refused (L2002). The design record is `docs/design/at-most-once-external-effect.md`.

### Patch Changes

- Updated dependencies [ba5468d]
- Updated dependencies [8577576]
- Updated dependencies [451ffee]
- Updated dependencies [f01aa7c]
- Updated dependencies [2cef9e6]
  - @cotal-ai/core@0.65.0
  - @cotal-ai/lang@0.65.0
  - @cotal-ai/workspace@0.65.0

## 0.64.0

### Patch Changes

- Updated dependencies [eb2b2d5]
- Updated dependencies [6c79419]
- Updated dependencies [d121d21]
  - @cotal-ai/lang@0.64.0
  - @cotal-ai/core@0.64.0
  - @cotal-ai/workspace@0.64.0

## 0.63.0

### Minor Changes

- c975258: A logged-in user can now run hosted workflows on a user-auth space. The auth callout issues an interactive user's `manager-caller` view as an issuance (SPEC 13.15): it chooses the generation, records evidence whose one source is the user's actor-ledger row, and writes the accepted row under a token derived from the connection's inbox nonce, renewing that generation on a reconnect whose ceiling is unchanged. `cotal run` and the other manager calls read the generation back with the new `issuedUserCaller` and ride `ep.v1`, so `cotal run start` against a participant manager started with `cotal supervise` is admitted. The issuing host admits a run from a user caller only for the manager's registered owner, and a participant manager now forwards the served subject of every caller resume and answer, which the host checks against the run's owner and the caller's live issuance; a legacy-rail resume is refused. The issuing host subscribes to those resume and answer request subjects itself and issues for a forwarded one only when it observed that request, only once, and only for the run a resume's envelope names or the endpoint and amendment an answer's envelope names, and never for a request bound to another manager instance or epoch or declaring another class or pinning another contract than the manager registered for that command. Every answering operator issuance must carry that served subject, and an amendment's carries `answers.amend: true`, which the host accepts only for a pause settled with an accepted answer, so `cotal run amend` works on a participant manager. A user caller starts, resumes and answers runs only on the participant manager that user registered, and a static caller keeps its admission there. A managed seat's manager call keeps the legacy rail when the broker refuses its accepted-row read, which surfaces as a request error caused by the permission violation. Revoking or re-granting the actor makes its issuances dead at the next resolution. New exports: `connectionAcceptedToken`, `actorLedgerSource`, `actorLedgerSourceBucket`, `parseActorLedgerSource`, `issuedUserCaller` and `isDerivedOwner` in core, and `ledgerActorSourceIsLive` and `UserCallerIssuer` in auth. `manager-caller` joins the issuable profiles, and the `issuer` profile gains the per-key read of the accepted store. SPEC §13.15 gains a **User-auth issuance** paragraph and §14.8 a **User-auth runs** paragraph, both insertions; `docs/design/user-auth-run-start.md` records the path, and `docs/cli.md`, `docs/workflows.md` and `docs/run-a-mesh.md` describe it. `docs/run-a-mesh.md` also says the stock auth service refuses managed-agent enrollment and retirement preparation for a host platform to intercept.

### Patch Changes

- Updated dependencies [62ebc6b]
- Updated dependencies [22e210a]
- Updated dependencies [cb6a0bf]
- Updated dependencies [5738154]
- Updated dependencies [101c9b0]
- Updated dependencies [9d5cc09]
- Updated dependencies [c975258]
  - @cotal-ai/core@0.63.0
  - @cotal-ai/workspace@0.63.0
  - @cotal-ai/lang@0.63.0

## 0.62.0

### Minor Changes

- b36bebf: `cotal spawn --detach` run from a managed seat's own shell on a static or open mesh now launches as that seat, so the manager records the seat as the spawner and the seat can stop the child with `cotal_despawn`, as it can a `cotal_spawn` child. Before, the CLI minted a one-shot operator instrument that no session could present again, and the seat's despawn was refused. `--on <instance>` keeps its pin on that path: on a static mesh the CLI mints a one-shot `manager-caller` view for the seat, pinned to that instance and carrying the spawn subject only when the seat's own credential holds it. On an open mesh the seat's call keeps the TLS requirement the mesh records, and `--server` with an unregistered `--space` keeps the operator path. Without `--space` the seat's target is picked as the operator path picks it, skipping a recorded mesh that is not running. The child is now stopped when the seat exits, and on a static mesh a seat without `capabilities: [spawn]` is refused. The seat-scoped control target that `cotal run` already used on a static mesh moves to `@cotal-ai/workspace` as `resolveSeatControlTarget`; `cotal run` keeps using it on a static mesh only. On a static mesh the seat's credential also proves its space, so a seat launched without `COTAL_SPACE` still acts as itself, as `cotal run answer` did before; an open mesh acts as the seat only when `COTAL_SPACE` names its space. See docs/UPGRADING.md.

### Patch Changes

- Updated dependencies [bcf66d6]
- Updated dependencies [1b3ba08]
- Updated dependencies [97a2382]
- Updated dependencies [877909b]
- Updated dependencies [5ef9a67]
- Updated dependencies [565036c]
- Updated dependencies [9236a12]
- Updated dependencies [b36bebf]
  - @cotal-ai/core@0.62.0
  - @cotal-ai/lang@0.62.0
  - @cotal-ai/workspace@0.62.0

## 0.61.0

### Patch Changes

- @cotal-ai/core@0.61.0
- @cotal-ai/workspace@0.61.0
- @cotal-ai/lang@0.61.0

## 0.60.0

### Patch Changes

- Updated dependencies [3b616a2]
- Updated dependencies [6ca4d8e]
  - @cotal-ai/core@0.60.0
  - @cotal-ai/workspace@0.60.0
  - @cotal-ai/lang@0.60.0

## 0.59.0

### Patch Changes

- 904f4b2: A hosted run that completes now despawns every seat it spawned, including a race winner's, a plain sequential spawn, and a spawn that failed catchably while its process stayed up. Before this, only seats on cancelled branches were released, so a long-lived orchestrator accumulated seats until the manager refused further spawns. A fork child never releases a seat copied from its parent, and a spawn marked `onFork: "adopt"` is never released at completion, because a fork may still be using it. A seat a migration handed to a later spawn follows that spawn's policy, and stays up if any spawn that held it was marked `onFork: "adopt"`. In a space with several managers a despawn treats a seat as already gone only when the manager that allocated it says so, and it retries a despawn another manager refused before running it.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
- 4a12111: The hosted `cotal run ps` now reads each run's revocation marker, as `run ps --local` already did. A revoked run whose driver died is listed as `revoked` with the revoker and reason instead of `running`, and a marker the manager cannot read prints `unchecked` and exits 1. The `run-ps` rows gain optional `revoked` and `revocationUnreadable` fields; the record's own `state` is unchanged.
- f485c49: A run driver now advances the run record's `journalHigh` after every journal append, before the program acts on the entry. A tail delete of records appended since the last activation used to leave a short journal that a successor resumed from, performing those effects again. The successor now refuses it with `RunJournalTailTruncated`.
- 7b39a0b: `spawn` in a workflow program accepts `events`, the workflow form of `cotal spawn --no-events`. `events: false` starts the seat without its AG-UI event plane, so a hosted run can now start a connector that publishes none, such as Hermes. Before this the option was refused as an unknown key (L3011), and the same spawn without it was refused by the manager because an omitted `events` arms the plane. A value that is not a boolean is refused at the spawn. Like `supervise`, the option is launch policy and is not part of the step's input hash.
- d0b1da3: Record a changed answer on a settled run step. `cotal run amend <runId> <stepKey>` files a new answer beside a settled checkpoint's or ask's accepted one, naming the answer it supersedes, and `cotal run journal` lists each amendment under the step in the order the store committed them, so the last one is the current position. Each filing is its own record, so returning to an earlier position is listed too. A settled `ask` now prints the answer it accepted, as a checkpoint does, read from its answer record even when the value is a record with fields named like a checkpoint's result. The pause stays settled and the run keeps the answer it acted on; a second `answer` is still refused. The hosted path is the `amend` form of the manager's `run-answer` command (cluster revision 19), and a spawned seat may amend only an answer recorded under its own name.
- 37075a2: `cotal run ps` and `cotal run journal` take `--json`, hosted or `--local`: one JSON object per row per line on stdout, with the run header and errors on stderr, as `cotal ps --json` does for seats. A run row adds its pinned `startedAt` and the `programHash` of its recorded program. A step row adds its effect kind and name, the recorded status and error code, its start and end times, and for an open pause its deadline and the `onExpiry` a checkpoint was armed with, which a checkpoint now records on its pending entry. An unreadable revocation marker under `--json` prints its reason to stderr and exits 1. `run ps --local` now reads its rows through the same listing the manager answers `run-ps` with, so both paths print the same rows.
- 63b8bb7: A run's `turn` and `wait(down)` no longer read a seat as down from one presence read that misses its row. A seat's presence row expires 6 seconds after its last heartbeat, and a seat whose connector stalls longer than that, under host load or across a reconnect, renews the same incarnation's row once it resumes. On a loaded host one such gap failed the turn with L4002 (`lapsed`) while the seat kept working, and the run threw away the sibling branches of a `parallel` with it. A lapsed row now counts as the death only after it has stayed absent for 30 seconds, observed by presence reads that follow each other within the row's 6-second TTL: a slow presence read or a run of failed reads could hide a renewal, so it starts the 30 seconds over instead of counting as absence. A row held by a different incarnation of the same name (`superseded`) still counts at once, and a seat that really died is still reported as L4002, about 30 seconds later than before.
- Updated dependencies [70bcfe3]
- Updated dependencies [1cf7f72]
- Updated dependencies [5bec8b2]
- Updated dependencies [6c01470]
- Updated dependencies [acb713e]
- Updated dependencies [77e2654]
- Updated dependencies [cfc3b95]
- Updated dependencies [b669a73]
- Updated dependencies [350c87b]
- Updated dependencies [608f5f4]
- Updated dependencies [43c4179]
- Updated dependencies [4a12111]
- Updated dependencies [569cb6f]
- Updated dependencies [b4c69bf]
- Updated dependencies [f485c49]
- Updated dependencies [7b39a0b]
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
  - @cotal-ai/lang@0.59.0

## 0.58.0

### Patch Changes

- 417b5f0: Replay a drive's own journal again when a read loses a round, instead of failing the step

  A drive reads its journal through one replay durable named after its takeover, before every effect
  and at every poll of a parked pause. When another reader held that durable, the read raised
  `RunJournalReplayRaced` and the interpreter recorded it on the step as `L4000 handler-fault`, so one
  branch of a `parallel` failed on a healthy run. `activateRun` already treats the same error as a
  lost round and replays again.

  The reads behind a drive's steps (`RunScopeAuthority`, hosted and under `cotal run --local`) and the driver's diagnostic for a
  journal with no run record now do the same, with the takeover's bound: up to three replays, one
  straight after another, and the race is raised unchanged when the third is lost too. An operator
  read runs under a takeover id minted for that one read (the manager and `cotal run` mint a fresh one
  per call), so `RunHost.status`, `RunHost.locate` and `cotal run journal` still report the race on
  their first read.

  Only the race is retried. A reader in another process can also tear a fetch or return an empty
  replay; neither is retried here.

  A new suite, `smoke:runtime-run-host-replay`, drives the manager's run host through a `parallel` of
  three `ask` steps answered within the same second: once while `RunHost.status` reads the drive's
  own takeover id, and once while another connection takes records off the drive's durable. No branch
  fails in either.

  The `connector-core` docs bundle is regenerated for the updated paragraph in `docs/workflows.md`.

- 1721738: Support signerless manager run hosting through typed host admission, initial-attempt and renewal operations. Renew the complete standing credential family while preserving held identities, serve epochs and last-good credentials on refusal. Keep pooled managers off local PTY launch paths and enforce the execution host boundary. Update the native lifecycle and mutation checks for these paths.
- Updated dependencies [0589316]
- Updated dependencies [59a7e64]
- Updated dependencies [95ae645]
- Updated dependencies [fba1537]
- Updated dependencies [576f622]
- Updated dependencies [2457692]
- Updated dependencies [ee6de5d]
- Updated dependencies [4229e53]
- Updated dependencies [e9ef5b3]
- Updated dependencies [7c54825]
- Updated dependencies [2c31f95]
- Updated dependencies [397bc60]
- Updated dependencies [7b3924c]
- Updated dependencies [1721738]
  - @cotal-ai/core@0.58.0
  - @cotal-ai/workspace@0.58.0
  - @cotal-ai/lang@0.58.0

## 0.57.0

### Patch Changes

- Updated dependencies [e7c702a]
- Updated dependencies [6f64bcc]
- Updated dependencies [42448fa]
- Updated dependencies [ae90f5d]
- Updated dependencies [33357d9]
  - @cotal-ai/core@0.57.0
  - @cotal-ai/lang@0.57.0
  - @cotal-ai/workspace@0.57.0

## 0.56.1

### Patch Changes

- Updated dependencies [6b76946]
  - @cotal-ai/core@0.56.1
  - @cotal-ai/workspace@0.56.1
  - @cotal-ai/lang@0.56.1

## 0.56.0

### Patch Changes

- Updated dependencies [e506040]
- Updated dependencies [8dc7c92]
- Updated dependencies [493eef5]
- Updated dependencies [99cad7b]
- Updated dependencies [1218786]
- Updated dependencies [ef8889d]
  - @cotal-ai/core@0.56.0
  - @cotal-ai/workspace@0.56.0
  - @cotal-ai/lang@0.56.0

## 0.55.0

### Patch Changes

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
- Updated dependencies [2b28653]
- Updated dependencies [fd58782]
- Updated dependencies [357af9f]
  - @cotal-ai/core@0.55.0
  - @cotal-ai/workspace@0.55.0
  - @cotal-ai/lang@0.55.0

## 0.54.0

### Minor Changes

- 34beea1: Route user-auth manager calls through a short-lived, instance-bound control credential. Discovery and invocation address the same authorized manager while the agent's standing connection, credentials and conversation remain unchanged. Managed launches retain their manager selection across launch and resume. Static and open mesh routing is unchanged. Confirm the standing goal-progress subscription at the broker before submitting on the separate control connection, so fast terminal events cannot outrun the subscription. Recover accepted goal results through the manager's caller-scoped `goal-result` command after connection replacement, without repeating the mutation or granting clients raw JetStream reads. Followed calls now require a compatible manager before submission; update the issuer, participant manager and client together. Stopping a caller cancels its observation without cancelling the accepted goal. Retain Linux custody records across clean child exit so retirement can prove process identity and finish cleanup even after the custodian removes its file; socket loss alone never frees the alias.

### Patch Changes

- Updated dependencies [e6badb8]
- Updated dependencies [34beea1]
- Updated dependencies [b4317fd]
  - @cotal-ai/core@0.54.0
  - @cotal-ai/workspace@0.54.0
  - @cotal-ai/lang@0.54.0

## 0.53.0

### Patch Changes

- Updated dependencies [d1f9703]
- Updated dependencies [104921c]
- Updated dependencies [83617ab]
  - @cotal-ai/workspace@0.53.0
  - @cotal-ai/core@0.53.0
  - @cotal-ai/lang@0.53.0

## 0.52.1

### Patch Changes

- Updated dependencies [5784ec9]
- Updated dependencies [f17791d]
  - @cotal-ai/core@0.52.1
  - @cotal-ai/workspace@0.52.1
  - @cotal-ai/lang@0.52.1

## 0.52.0

### Minor Changes

- 5ee8eef: Let a workflow-spawned seat answer an ask or escalated checkpoint addressed to its own incarnation with its baseline credential. `run-answer` is now self-targeted, the manager checks the caller against the pending relay before writing an answer, connector turn text renders the hosted command without `--by`, and that literal command reuses the managed seat's issued caller identity. Other seats, unrelayed checkpoints, other runs, and run start or resume remain refused. Fixes #1877.
- 5b2c19f: Let hosted workflow runs resolve an existing absolute working directory on the selected manager and launch the placed seat in its canonical path.

### Patch Changes

- c902af4: `settleOnce` now drains the fire pump before it returns: the wait's answer is still decided by the race (fact, failure, or cancellation), but the settle does not return until the pump's in-flight `takeFire` has ended, and the pump re-checks `wait.over` after each fire so it stops without starting another. Before (#1460), a settle whose fire was mid-flight returned as soon as its fact was observed, so a completed `driveRun` could resolve while the pump's journal replay under the run's takeover id was still open — the replay consumer appeared after the drive had returned, and the next reader under the same takeover hit `RunJournalReplayRaced` cross-process about a driver that no longer existed. A failed pump still raises through the drain exactly as it did through the race.
- c44aaf8: Show a settled workflow pause's accepted answer and attribution in the run journal.
- 8bd4279: `cotal run migrate <runId> --local --file <program>` now runs the migrate check from the terminal. The check existed as `migrateRun` and nothing could call it: the verb table refused `migrate` as usage, while `resume --file` refused an edited program and named "a migration or a fork" as the remedy. The verb reads the run record (pins read back, never re-derived) and the journal under the same one-shot run-operator credential `journal` uses, walks the edited program over the recorded journal, prints whether the migration is admissible, how many journal rows the walk accounted for, every orphaned step with its verdict and code, the divergence or unwalkable step when there is one, and exits 0 on admissible and non-zero on not. It writes nothing: the commit side (`commitMigration`) is not reachable from any surface yet, and the printed report says what a commit would file and that this invocation filed nothing. Commit-side overrides (`--adopt`, `--release`, `--discard-approvals`) are parsed only so the verb can refuse them by name, and the hosted path refuses with the sentence naming `--local` (the manager serves no run-migrate command). Refs #1529.
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
- Updated dependencies [7ea6fee]
- Updated dependencies [6b375c8]
  - @cotal-ai/core@0.52.0
  - @cotal-ai/workspace@0.52.0
  - @cotal-ai/lang@0.52.0

## 0.51.0

### Patch Changes

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
  - @cotal-ai/lang@0.51.0

## 0.50.1

### Patch Changes

- c499a85: `cotal run ps --local` now reads the revocation marker beside each run record and prints `revoked`
  for a run that carries one, whatever state the record itself holds, with the revoker and the reason
  under the table. A revocation is a create-only marker in the admission store and nothing rewrites
  the record, which is written only by a driver, so a driver that died mid-run left `running` behind
  with nothing left to write anything else: `resume` refused on the marker while the table listed the
  same run as live indefinitely, and an operator counting capacity from it counted that row. A run
  whose marker could not be read prints `unchecked` in the `STATE` column, since a failed read is
  absence of evidence rather than evidence of absence. The reason and the record's own state go to
  stderr, every other row still prints, and the command exits 1. The change is display only: a revoke
  writes no terminal state, because no host drove the run to one. `revoke` now says what the table
  will show, and `readRunRevocation` reads the marker alone so a listing does not refuse over a run
  with no admission record. `revokeRunAdmission` refuses a revocation with an empty `by` or `reason`
  before it writes, since the argument parser passed `--by ""` through and the permanent marker it left
  printed as `revoked by  ()`; a marker already written that way still reads as a revocation.

  Refs #1621

- Updated dependencies [c499a85]
  - @cotal-ai/core@0.50.1
  - @cotal-ai/workspace@0.50.1
  - @cotal-ai/lang@0.50.1

## 0.50.0

### Minor Changes

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

- 87dda9f: The caller half of a durable spawn's physical working directory, pinned to one manager instance

  A durable spawn can name a physical working directory with `cwd`, and doing so requires an explicit
  `placement` target naming one manager instance as `{ endpoint, instanceId }`. A directory is
  host-local, so a `cwd` with no target would ride the class anycast queue and land wherever the
  anycast fell; that combination refuses rather than guessing, with no fallback. The target is
  hashed into the step identity beside the directory, so a replay retargeted at a different instance
  diverges as a migration instead of replaying a resolution taken against the old host. Logical
  `worktree` keeps its meaning and its exclusivity, and a spawn that names neither option hashes
  exactly the object it hashed before, byte for byte, so recorded runs replay unchanged.

  **Explicit `cwd` placement does not resolve yet on a shipped manager, and refuses by name until it
  does.** What ships here is the caller half: the language forwards and hashes the options, the
  runtime asks its pinned target to state the directory's canonical form before it submits anything,
  and the core grant builder mints the instance-pinned rails that ask would need. The question is
  asked with a `resolve-cwd` command, and **no manager in this release serves `resolve-cwd`** — the
  only servers of it are the smoke suites that grade this code. So on a real manager every explicit
  `cwd` placement ends in a named refusal saying that this manager serves no `resolve-cwd` command
  and can therefore state no canonical form. That is the intended direction and it is not a crash:
  nothing is submitted, allocated or launched, and the caller is told why. A non-`ok` reply and a
  reply whose path is not absolute are refused the same way. Until a manager serves the command,
  treat `cwd` with `placement` as unavailable rather than as a directory that silently differs from
  the one you named.

  The grant surface and the serving surface are deliberately asymmetric, and it is worth stating
  plainly: `runMediatorGrants` does mint the three placement capabilities (`describe`, `resolve-cwd`,
  `spawn`) for the one named instance when a program names a target, bounded to that instance with
  no anycast rail and no wildcard, but the manager's hosted-run credential minting never passes a
  program's placement into it, so an authenticated hosted run receives none of those rows today. The
  rails are built and graded; nothing production yet asks for them or answers them.

  A malformed `placement` is now refused by name at the call. `placement: null` used to raise a raw
  `TypeError` from inside the interpreter's identity projection, with no code, no effect kind and no
  journal entry, because the option reader guarded the option bag being null rather than the value it
  held. A primitive, an empty record and a half-filled record were quieter and worse: they were
  forwarded, projected two undefined fields into the step identity, and the run carried on under an
  identity describing a placement the program never named. All of these are now `L3048`, raised
  before the step key is minted, so nothing is journalled and the repair is an edit to the program.

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

- 5a34b2b: A durable run's unpinned spawn survives the class-queue split instead of dying at it

  A run resolves the manager on the class rail and binds the incarnation that answered its describe.
  The invoke is a second, independent trip through the same anycast queue, so in a space served by
  more than one manager it routinely reaches another member. That member refuses before dispatching
  and says so: SPEC 13.2 marks the refusal `not-executed`, meaning the command did not run and no
  effect of it exists. The refusal is correct for one command and destructive for a run. Raised as the
  effect's own L4000 it ended a durable Lang run at its first `spawn` with no `placement`, consuming
  the run id and its journal, and a retry started a fresh run that failed the same way about half the
  time.

  The manager calls a run performs now re-issue such a refusal rather than returning it. The stale
  class handle is dropped, the endpoint is re-described, and the call goes out again, up to a bounded
  number of attempts, after which the refusal surfaces unchanged and still states that the command
  did not run. This is the licence core's `Endpoint.invokeService` already re-issues on: the marker
  together with `not-executed` is the responder's own statement that the re-issue is a first attempt
  and not a second, so nothing is duplicated. It covers `spawn`, `turn`, the relay a paused `ask` or
  `checkpoint` submits, and the `despawn` a cancelled spawn discharges with.

  A handle pinned to one instance is never repaired. It addresses that incarnation by name, so a
  refusal from it is that instance answering about itself, and re-resolving onto the class rail would
  be the anycast fallback an explicit placement exists to remove.

  The repair converges rather than eliminating: the re-issue draws the same queue, so a space of m
  managers still splits (m-1)/m of the time per attempt. Nine attempts leave two managers a 1-in-512
  residual where the unrepaired refusal was 1-in-2. Removing the residual means addressing one
  instance, which the run's caller holds no instance-rail grant for unless its program named a
  placement.

### Patch Changes

- 5e23b1d: Keep the versioned rail's subject token out of source comments

  The issued-profile census scans every shipped source for the versioned rail's subject token and
  allows only core's subject and grant builders to spell it. Five comments in core, the CLI and the
  runtime spelled the token and failed that cell on main. They now say "the versioned rail" or "the
  versioned plane". No code changes.

- aaedc42: `cotal run journal` renders an expired checkpoint differently from an answered one. A settled
  checkpoint's status is `ok` whether its pause was answered or expired, and the journal render took
  the status, so both read `ok` and an operator could not tell an unanswered human gate from a
  timeout. The render now reads the disposition the settle named (`resolved` / `expired`) from the
  settled result, in both the `--local` journal path and the hosted status view, and keeps the
  settled status for steps whose result is not a checkpoint disposition.
- 43a4281: Fix locally driven workflow starts with publish-channel admission by generating a valid actor token.
- c59d96d: Stop a parked step from dying on one slow pause-plane reply. A workflow `ask` that waited long enough settled `failed` with `{code: "L4000", kind: "handler-fault", message: "timeout"}` while most of its deadline was still unspent, the seat was alive, and nothing in the program threw. Measured on the reporting run: the two asks under 4.5 minutes settled `ok` and the two over 7.5 minutes failed with that exact record, with 11 minutes of deadline left.

  The cause is how long a parked step reads for. While a pause is parked the run host polls the plane for the life of the step, once for the settle fact and once for the broker's fire, each read riding a NATS API request with its own 5s client-side deadline. A reply that arrives after that deadline raises the client's bare `TimeoutError: timeout`, and the interpreter records any non-`EffectError` throw as `L4000 handler-fault` verbatim. So the step issued roughly one unretried request per second for its whole duration and one late reply ended it, which is why the exposure grew with how long the step waited rather than with anything about the program.

  A late reply is a fact about that one request and not about the pause behind it. The pause is a durable record on the plane, its timer is armed, and it is still answerable, so the read is now re-issued rather than raised, and the step settles on the answer it was waiting for. Re-reading is safe for the same reason the starvation repair's re-entry is: the plane's operations are idempotent by construction, and reading a one-use settle fact again observes the same world.

  It is the second half of a distinction the host already drew for #1508 and it reuses that machinery rather than adding its own. A client deadline has two causes that produce the identical error, and the host can tell them apart by measuring whether its own event loop ran: off the CPU is the host's own starvation (`L4025`), and on it is a plane that answered late. The case that moves is only the second, which the classifier previously answered "fault" and handed to the program as its own failure.

  Neither retry is unbounded and neither is merged into the other. A run that cannot be served must fail rather than hang, so the two conditions carry separate counts that are never reset, which bounds the call however they interleave; a host that stays starved still fails under `L4025`, and a plane that never answers now fails under the new `L4026` naming the measurement rather than the effect. The two are kept apart because the remedies differ: one says give this host capacity, the other says the broker is behind. Every failure that is not a client deadline is still raised on the first attempt, unretried and unwrapped, and still recorded as `L4000`.

  A recorded handler fault also carries the stack of the value that was thrown, in a new optional `error.stack` on the journal entry. A handler fault is the one failure class whose cause is in neither the program nor the language, so `message` alone ("timeout") is the symptom with no origin, and the durable entry is usually the only look anyone gets at it. The field is written only when the thrown value carried a non-empty string `stack`: a handler may throw a primitive, and a recorder that trusted the field would replace the handler's failure with its own.

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
- Updated dependencies [c59d96d]
- Updated dependencies [438c629]
- Updated dependencies [a211c52]
  - @cotal-ai/workspace@0.50.0
  - @cotal-ai/core@0.50.0
  - @cotal-ai/lang@0.50.0

## 0.49.0

### Minor Changes

- 1469d18: Add `waitUntil(probe, { name, every, deadline })`: a durable wait on a resource the mesh does not own. Before this a program could only wait on a mesh event or on the clock, so blocking until something outside the mesh became true meant writing a poll loop, and a poll loop is broken across a resume: the probe's observation of "not yet" was journalled as the step's RESULT and replayed forever, so a resumed run was handed a stale answer for a resource that had since completed, and never looked again.

  A `waitUntil`'s non-terminal observation is now journalled AS AN OBSERVATION and leaves the entry pending, so a resumed run re-observes the world. Only a terminal observation settles the entry, carrying its observation history beside the result. Each observation's probe is journalled in its own key namespace, so the effects one look performs can never be replayed as another look's answer. The deadline is absolute from the entry's start, so a crash does not buy the wait more time, and an elapsed deadline is catchable as `L4023` and reports how many times it looked. The handler is asked only to wait out the cadence: which resource to look at, and what counts as done, stay with the program. `every` and `deadline` are part of the step's identity, so editing either on a resumed run diverges; the predicate is not, so a program can correct it on a run that is already waiting. Neither `every` nor `deadline` may be defaulted, and a cadence longer than the deadline is refused at parse.

  Journals written before this release are unaffected: the new entry shape adds an optional field, and no existing kind changes.

- 36d1779: Issued authority and run admission (SPEC 13.15, 14.8). A static credential is now an issuance: the issuer records its permission ceiling as evidence under a fresh generation before the material exists, its endpoint rows ride the versioned `ep.v1` rail with that generation pinned beside the caller triple, and a connected client reads its generation from an issuer-written accepted row. A hosted workflow run is admitted under the starting caller's resolved ceiling, recorded once per run in a dedicated admission store the driver cannot write, checked before every channel effect (wait open, fetch, recorded re-read, conclave writes), and revoked by an independent create-only marker that ends open waits at their next poll and refuses resume, takeover and reconcile. `run-start` on the legacy rail is refused with `permission-denied` and the `ai.cotal.ep.unbound-caller-authority` detail. `cotal run start --local` takes `--admit-read` and `--admit-publish` (required) and `cotal run revoke <runId> --local --by <who> --reason <text>` writes the marker. Three new per-space stores (`cotal_issued_`, `cotal_accepted_`, `cotal_admission_`), immutable at the broker: the admission and accepted stores are write-once per key, the evidence store is append-only and read first-on-key, and all three refuse rollup headers, message deletes and purges, so a holder of its own key row can neither widen nor erase what was recorded. Two new one-shot profiles (`issuer`, `run-admitter`), an admission read on the run mediator and operator profiles, and `COTAL_ACCEPTED_TOKEN` on every connector's spawn environment. Breaking pre-1.0 authority change.

### Patch Changes

- 4b3881f: A workflow `sleep` that a busy host was simply too loaded to schedule no longer fails the run. A pause waits by reading the durable checkpoint plane, and each of those reads carries a client-side deadline that is itself a timer; when the machine is loaded hard enough that the run's process does not get back onto the CPU, that timer cannot run either, so it expires the moment the process resumes and reports a bare `timeout` even though the broker answered long ago. That was recorded as `L4000 EffectError: timeout`, which names the effect as the thing that broke and sends the author looking at their own program, and it killed runs whose only fault was being polite about load.

  The runtime now measures whether its own process was actually running across the wait, namely event-loop lag over the window together with a shortfall in the ticks that window should have contained, and treats a deadline that elapsed while the process was demonstrably off the CPU as a fact about the host rather than about the effect. The pause and its timer are durable, so the wait is simply re-entered and a `sleep` whose deadline passed during the starvation completes late, which is what a lower-bound wait promises. Nothing is widened and nothing is swallowed: a deadline on a loop that was running, and every failure that is not a client deadline, still fails immediately as `L4000` with its message intact. A host that still cannot serve the run after a bounded number of consecutive starved attempts fails under the new `L4025`, "Host did not schedule the run", quoting the lag and tick measurement it made, so a caller that genuinely cannot be served fails rather than hanging and the operator reads the real cause.

- Updated dependencies [a9c9849]
- Updated dependencies [b0aeca4]
- Updated dependencies [1469d18]
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
- Updated dependencies [4b3881f]
- Updated dependencies [6fb1d64]
- Updated dependencies [b00f3c1]
- Updated dependencies [13f29e1]
  - @cotal-ai/core@0.49.0
  - @cotal-ai/workspace@0.49.0
  - @cotal-ai/lang@0.49.0

## 0.48.2

### Patch Changes

- @cotal-ai/core@0.48.2
- @cotal-ai/workspace@0.48.2
- @cotal-ai/lang@0.48.2

## 0.48.1

### Patch Changes

- 9a8a2a6: Inspect version-2 workflow journals on the compiled engine when planning forks and migrations. Preserve recorded pins, stop before new effects, and retain divergence and branch-refusal details across the worker boundary. Fork cuts remain fixed through catch and finally blocks, and inspection leaves pending broker effects untouched.
- Updated dependencies [9a8a2a6]
  - @cotal-ai/lang@0.48.1
  - @cotal-ai/core@0.48.1
  - @cotal-ai/workspace@0.48.1

## 0.48.0

### Minor Changes

- b6c843f: Restrict workflow driver credentials to their own journal and record writes. Move effects and leader reads onto a separate trusted host connection, with journal ownership checks, cancellation cleanup checks, and host-held wait acknowledgements. Hosted and local runs use this split; authenticated local runs now require a recorded space signer rather than a single credentials file.

  Custom run hosts must accept the separate mediator connection. Seat-adopting effect hosts must implement `restoreMigratedSeats` so migration reads stay on the host.

  Preserve settled parent history when a version-1 fork resumes through the host, without granting the child access to parent checkpoint tokens.

### Patch Changes

- Updated dependencies [b6c843f]
  - @cotal-ai/core@0.48.0
  - @cotal-ai/workspace@0.48.0
  - @cotal-ai/lang@0.48.0

## 0.47.1

### Patch Changes

- @cotal-ai/core@0.47.1
- @cotal-ai/workspace@0.47.1
- @cotal-ai/lang@0.47.1

## 0.47.0

### Patch Changes

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
  - @cotal-ai/core@0.47.0
  - @cotal-ai/workspace@0.47.0
  - @cotal-ai/lang@0.47.0

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
  - @cotal-ai/workspace@0.46.0
  - @cotal-ai/lang@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0
  - @cotal-ai/workspace@0.45.0
  - @cotal-ai/lang@0.45.0

## 0.44.0

### Patch Changes

- @cotal-ai/core@0.44.0
- @cotal-ai/workspace@0.44.0
- @cotal-ai/lang@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0
  - @cotal-ai/workspace@0.43.0
  - @cotal-ai/lang@0.43.0

## 0.42.0

### Minor Changes

- a87709c: Every cotal-lang effect now performs on the mesh: the durable-action group is built end to end and
  the not-yet-durable seam is gone.

  `spawn` submits a real manager goal and returns the allocated seat's handle, and meters the
  agent's `permits` (`turns`, `wallClock`; the turn that would exceed one is L4001, and a budget the
  host cannot meter is refused at spawn); `conclave` opens a scoped sub-team as durable membership
  rows; `ask` parks schema-checked pauses answered through `cotal run answer` and tells the agent
  over the turn relay, one relay per attempt carrying the schema, the attempt and the previous
  refusal, which every connector's intake renders with the answer command; `monitor` registers the
  handle on its journal entry and `wait(down)` reads a monitored incarnation's death off presence
  liveness, refusing an agent nobody monitored.
  `turn` rides a new pull-shaped manager relay: the manager serves `turn` (targeted, the
  despawn/input reach) plus `turn-pending` and `turn-yield` (self reach, manager contract revision
  10), holds the payload on the goal-index note, pins the goal to the seat's incarnation, and denies
  at a goal-bound deadline hold; the seat side (all connectors) pulls pending turns, surfaces them
  two-phase into host context, auto-yields `done` when the host turn ends, and yields `blocked` or
  `handoff` through the new `cotal_yield` tool; the run client renders context with pending notices,
  arms its own pause on the acceptance's deadline as the L4003 authority, watches presence as the
  L4002 authority (a death the manager marks on the deadline terminal reads the same way), and
  honors handoffs (L4005/L4004 validation, the `handoffFrom` goal chain); the manager shows a seat
  one turn at a time. The relay holds on an auth mesh: the agent baseline gains the self-mode
  `turn-pending` and `turn-yield` rows, the operator seat-write set (`control-caller-admin`, the
  `admin` capability) gains `turn` beside `input`, and the manager mints the deadline hold's
  schedule over its serve connection and owner-expires the hold once due instead of reading a
  fire it holds no grant for. `wait(replied)` observes the run's own turn terminals as a level, and never a
  turn the run itself ended without an accepted yield. A `spawn` may bind a logical worktree: the
  validator rejects two literal-worktree spawns in one concurrent scope (L3022, named branch
  functions included) and the runtime claims a tree before it submits, refusing a second spawn into
  a tree held by a live seat or by a spawn in flight (L4008), with sequential reuse the moment the
  holder's presence lapses. A spawn refused at accept is L4000 (L4001 for seat capacity) and one
  whose seat never came up is L4002; an `ask` whose deadline passes with no conforming record is
  L4006; a fork copies a spawn that said `onFork: "adopt"` and refuses one that would have to
  respawn (L5019). The run driver re-issues
  recorded-but-undischarged cancellations at adoption, so recovery does not wait for completion to
  release a dead loser's seat, pause, or tree. A migration's `--adopt <handle>` hands the orphaned
  seat to the edited program's next spawn of that persona, and `--release <handle>` despawns it at
  commit through the run's own discharge; both name the agent the step spawned, and a spawn that
  produced none is an orphan like a sleep; the adopting spawn binds the orphaned spawn's goal as
  its own, so a resume re-reads the seat and a cancellation despawns it. A turn accept the manager
  cannot finish unwinds to a failed terminal on its bound goal, and a retry of it is refused naming
  that terminal. The delivery daemon hosts the checkpoint timer writer, so mediated deadlines fire
  with no suite pump.

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/lang@0.42.0
  - @cotal-ai/core@0.42.0
  - @cotal-ai/workspace@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4
- @cotal-ai/workspace@0.41.4
- @cotal-ai/lang@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3
  - @cotal-ai/workspace@0.41.3
  - @cotal-ai/lang@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2
- @cotal-ai/workspace@0.41.2
- @cotal-ai/lang@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1
- @cotal-ai/workspace@0.41.1
- @cotal-ai/lang@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [de258fb]
- Updated dependencies [42d80da]
- Updated dependencies [bac1e00]
- Updated dependencies [5ec7feb]
  - @cotal-ai/core@0.41.0
  - @cotal-ai/lang@0.41.0
  - @cotal-ai/workspace@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0
- @cotal-ai/workspace@0.40.0
- @cotal-ai/lang@0.40.0

## 0.39.1

### Patch Changes

- @cotal-ai/core@0.39.1
- @cotal-ai/workspace@0.39.1
- @cotal-ai/lang@0.39.1

## 0.39.0

### Minor Changes

- 2277e28: A capability refusal is durable and retryable. A handler that cannot perform an effect on its host
  throws the new `EffectRefused`; the interpreter settles the entry with the new status `refused`
  under the handler's code (L5016 for the mesh handler's `NotYetDurable`, which now extends it) and
  unwinds the run with the uncatchable `RunHeld` (L5025). The driver grades the run `released`, and a
  resume on a capable host finds the new `refused` lookup verdict and performs the step live, so a
  run started before the durable-action surface lands heals the day it does. Previously the refusal
  settled `failed` and a resume replayed the failure forever.

  Two concurrent `turn`s on one agent handle are serialized at the dispatch seam both engines share:
  the second begins when the first settles, in dispatch order. Turns on different handles are
  unaffected.

  A fork's child records its lineage: the run record's spec gains `forkedFrom` (`{ run, step }`,
  absent on runs started fresh), `commitFork` writes it with the spec, and `ForkCommitResult.
lineageRecorded` is now true.

  Spec: §6.5 (turn serialization), §9.2 (six uncatchables), §10.1/§10.7 (the `refused` status and
  verdict), §11.1, §11.3, Appendix A (+L5025), and SPEC.md §14.3 (`forkedFrom`).

- 43e1f7d: Simulator fidelity, ask schema enforcement, journal result bound, and the scope release law.

  The simulator is now discrete-event: timed effects park at their wake times and are delivered in
  wake order on one virtual clock, so concurrent branches accumulate the durations they wrote and a
  simulated race is decided by the same rule as a live handler (least recorded clock, ties by
  declaration order) instead of by the order effects were asked.

  The reference simulator enforces the ask schema shorthand (spec §6.5): a schema it cannot read is
  refused with the new L4022 rather than skipped, a non-conforming reply consumes one attempt, and
  exhausted attempts report L4006.

  A journal can be constructed with a result bound (`JournalInit.resultBytes`, plumbed through
  `DriveRequest.resultBytes`); a settled ok result over it is refused ahead of the settling append
  with L5006, which leaves the reserved list.

  A host release or refused append inside a parallel, race, fanOut or conclave no longer cancels
  sibling branches or settles their in-flight entries cancelled: the unwind propagates bare, the
  scope settles nothing, and a resume picks the run up exactly where the journal says it stopped.
  The old behavior permanently poisoned any run a driver stopped while an effect was in flight
  inside a scope.

- 34ff272: `cotal run`, the workflow-run operator surface, self-registered by `@cotal-ai/runtime` and composed
  into the `cotal` binary: `start --file <program>` drives a new run on the mesh handler, `resume
<runId> --file <program>` takes an existing run over and drives it to quiescence, `ps` lists an
  endpoint's run records (state, holder, journal high-water, fork lineage), `journal <runId>` prints
  the durable step journal, and `answer <runId> <stepKey> --by <who> [--value <json>]` resolves an
  open checkpoint through the run driver, presenting as the arming holder read back from the
  checkpoint record (resume is holder-bound). One raw connection per invocation against the resolved
  mesh target; the journal's result bound is taken from the broker's own max_payload.

  `docs/workflows.md` gains an "Operating a run" section, the connector docs bundle carries it, and
  every connector folds a workflow steer (`WORKFLOW_STEER`) into its agent instructions beside the
  mesh-first steer, so agents reach for a durable journalled run instead of improvising long
  coordination loops in their own context.

### Patch Changes

- Updated dependencies [2277e28]
- Updated dependencies [43e1f7d]
  - @cotal-ai/lang@0.39.0
  - @cotal-ai/core@0.39.0
  - @cotal-ai/workspace@0.39.0

## 0.38.0

### Patch Changes

- @cotal-ai/core@0.38.0
- @cotal-ai/lang@0.38.0

## 0.37.0

### Minor Changes

- 00ac9d9: manager: refuse a manager-role spawn of a persona without the spawn capability. A persona defined over the wire (`cotal_persona`) carries no `capabilities:` line (the write path is content-only by design), and `cotal_spawn` takes a free-form `role`, so a wire-defined persona could be spawned with `role: "manager"` and join presenting as a manager whose credential cannot reach the control plane, silently, until the seat first tried to seat a worker (issue #966). The manager now refuses that spawn at accept, before any provisioning, naming the remediation for both authors: an operator adds `capabilities: [spawn]` to the persona file; a peer-defined persona cannot declare capabilities and must ask an operator. The guard keys on the effective role (a spawn-time role override wins over the file's, mirroring existing precedence) and leaves every non-manager spawn untouched. `cotal_spawn`'s `role` argument documents the requirement. Capabilities remain non-declarable over the wire: the closed `define-persona` input schema is unchanged and still guarded by `smoke:persona-input-closed`.

### Patch Changes

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
- Updated dependencies [0098000]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0
  - @cotal-ai/lang@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0
  - @cotal-ai/lang@0.36.0

## 0.35.0

### Patch Changes

- @cotal-ai/core@0.35.0
- @cotal-ai/lang@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0
  - @cotal-ai/lang@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9
- @cotal-ai/lang@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8
- @cotal-ai/lang@0.33.8

## 0.33.7

### Patch Changes

- Updated dependencies [576ac7d]
  - @cotal-ai/core@0.33.7
  - @cotal-ai/lang@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6
- @cotal-ai/lang@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5
- @cotal-ai/lang@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4
  - @cotal-ai/lang@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3
- @cotal-ai/lang@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2
  - @cotal-ai/lang@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1
- @cotal-ai/lang@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0
  - @cotal-ai/lang@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0
- @cotal-ai/lang@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0
  - @cotal-ai/lang@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2
- @cotal-ai/lang@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1
  - @cotal-ai/lang@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0
  - @cotal-ai/lang@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2
  - @cotal-ai/lang@0.29.2

## 0.29.1

### Patch Changes

- @cotal-ai/core@0.29.1
- @cotal-ai/lang@0.29.1

## 0.29.0

### Patch Changes

- Updated dependencies [1f025c3]
  - @cotal-ai/core@0.29.0
  - @cotal-ai/lang@0.29.0

## 0.28.2

### Patch Changes

- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2
  - @cotal-ai/lang@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1
  - @cotal-ai/lang@0.28.1

## 0.28.0

### Patch Changes

- Updated dependencies [09b6a3b]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/lang@0.28.0

## 0.27.0

### Patch Changes

- @cotal-ai/core@0.27.0
- @cotal-ai/lang@0.27.0

## 0.26.0

### Patch Changes

- @cotal-ai/core@0.26.0
- @cotal-ai/lang@0.26.0

## 0.25.0

### Minor Changes

- 0471af2: The driver hosts the version-2 compiled engine: a fresh run is stamped language version 2 and executes on the engine in its own locked-down worker thread, while every version-1 record keeps replaying on the tree-walker and a record whose version the build does not serve keeps refusing by name (L5023). The engine gains a bridged handler route for hosts whose effect handler is a live object: the handler and the durable journal store stay in the host process, and the worker forwards the effect seam over a message port, so effects stay durable pending-before-effect and no socket or credential enters the isolate holding the program. Failures cross the thread boundary whole: an EffectError keeps its code, kind and detail, a release keeps its reason, and a lost journal is regraded as the class the driver's outcome contract names. A race loser's cancellation crosses the bridge and fires the host handler's signal while the effect is still in flight (a cancel aimed at an effect that already answered does not cross, which is the only time a handler could not act on one anyway). The driver also refuses a malformed run record by its own name: a `languageVersion` that is not a string is released as malformed before the engine table is consulted, instead of being misread as an unserved version. A stop check that throws inside the host's poll is re-raised as the run's fault on the caller's stack rather than escaping as an uncaught exception.
- dbeec0f: The language version belongs to the engine that runs a program, and a build declares which engines it hosts.

  There are two engines and now two versions: the tree-walker is language version `1` and stays the
  replay engine for every run recorded under it, and the compiled engine is version `2`, a different
  language rather than a faster one, since `log` is data there and refuses code, and a step is a
  transformed-site hit rather than a walker dispatch. `resolvePins` and `bindPins` take the version as
  an argument, so each engine stamps its own and compares against its own; `WALKER_LANGUAGE_VERSION`
  and `ENGINE_LANGUAGE_VERSION` are exported beside `LANGUAGE_VERSION`, which is an alias for the
  current language, the engine's.

  Bumping one shared constant was measured and is not available: the walker would stamp 2 and compare
  1, and every walker fresh-run-then-resume round trip fails. Leaving it at 1 while the engine speaks
  2 fails the other way, on records already written. Each engine stamping and comparing its own breaks
  neither.

  The run driver now holds a table of the versions this build hosts, ordered by declared precedence
  rather than by a string sort. A fresh run is stamped with the version of the engine that will
  actually execute it, and a record whose version no engine here serves is released by name with the new **L5023**,
  naming both the version it met and the set this build serves, with the run left untouched: nothing
  activated and nothing appended. It is released rather than failed or thrown, because a build that
  cannot host a language has observed nothing about the program.

  Migration: `resolvePins(options, now)` and `bindPins(recorded, options)` now require a third
  argument, the calling engine's version. Callers inside this repo pass their own; an external caller
  passes `WALKER_LANGUAGE_VERSION` to keep today's behaviour. Records do not cross between versions in
  either direction, which was already true and is now enforced by the engine that meets them.

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0471af2]
- Updated dependencies [dbeec0f]
- Updated dependencies [d3553be]
- Updated dependencies [dc34423]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [445e110]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/lang@0.25.0

## 0.24.0

### Minor Changes

- b7cc4fa: Host a cotal-lang run on the mesh.

  `@cotal-ai/lang` gains the durability the language rested on but did not have: run pins with a
  run clock, scope journal entries that record a race's winner and its losers so a replay resolves
  the same arm, a refusal when a resume is handed a journal without the pins that decide it, and an
  effect ceiling read from the pins rather than a default.

  `@cotal-ai/core` gains the step journal's storage plane, the run record and its lease, the
  checkpoint answer record, and the notice and migration records.

  `@cotal-ai/runtime` is new: the mesh handler that performs a program's effects on the real planes
  (durable pauses on the checkpoint plane, event awaits over durable consumers, notices), the
  `RunDriver` the manager daemon hosts, journal-replay resume, migration onto edited source, and a
  fork that redoes work under a new run id. Effects that need durable actions refuse through one
  named seam rather than pretending to succeed.

### Patch Changes

- Updated dependencies [9939dcc]
- Updated dependencies [b7cc4fa]
  - @cotal-ai/lang@0.24.0
  - @cotal-ai/core@0.24.0
