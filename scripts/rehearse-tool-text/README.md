# Tool text rehearsal

Fresh agents on a throwaway mesh, given the eight coordination scenarios from #5625. The rehearsal
runs once on the tool text a tree ships today (the baseline) and once on the revised text, with the
same personas and prompts, and grades each run against the scenario's pass check.

## Run it

Install and build both trees first (`pnpm install && pnpm build`), because a seat reads the tool
text from its tree's built connectors.

```bash
node scripts/rehearse-tool-text/rehearse.mjs --tree <main-checkout> --label baseline --harness claude --out <out>
node scripts/rehearse-tool-text/rehearse.mjs --tree <this-checkout> --label revised --harness claude --out <out>
node scripts/rehearse-tool-text/rehearse.mjs --tree <main-checkout> --label baseline --harness jcode --out <out>
node scripts/rehearse-tool-text/rehearse.mjs --tree <this-checkout> --label revised --harness jcode --out <out>
node scripts/rehearse-tool-text/report.mjs <out>
```

`--scenario <id>[,<id>]` runs some of them. `--timeout-min` (default 15) bounds one scenario, and
`--settle-s` (default 60) is how long every seat must stay idle before a run counts as finished.
A jcode run copies jcode's provider files from `--jcode-config` (default
`$XDG_CONFIG_HOME/jcode`) into the sandbox.

## What one run does

Each scenario gets its own sandbox under `--work` (default `$TMPDIR/rehearse-tool-text`), mode 700.
It holds its own `COTAL_HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and project root, and a broker on a free
loopback port. Keep `--work` short: the manager binds a Unix socket under the sandbox TMPDIR, so
`<work>/r-XXXXXX/tmp` must fit in 64 bytes. The CLI runs under a scrubbed environment, so it never reaches another mesh or the operator's
connector store. The tree's Claude Code and jcode connectors are added with `cotal ext add`.

The run seeds the scenario's channels and posts, writes the personas in `personas/` and alice's
persona from `scenarios.json`, and starts any seats the scenario needs already present. Then it
spawns alice with the scenario's prompt and waits until every seat has been idle for `--settle-s`
seconds, and for a scenario that asks for it, until the seats alice started have left.

## What it records

Under `<out>/<label>-<harness>-<scenario>/`:

- `history.json`: `cotal history` for DMs and for every channel involved.
- `calls.json` and `spawns.json`: each seat's Cotal tool calls with their arguments and results,
  read from the seat's own transcript. The manager does not log accepted spawn arguments, so these
  come from the caller's side. `ps.json` holds the `cotal ps` snapshots taken every five seconds,
  which name each seat's spawner.
- `manager.log`: how each seat ended, stopped by someone or exited on its own.
- `personas/`: every persona in the catalog at the end, including those the agents wrote.
- `roster.json`: the roster at the end.
- `transcripts/`: every seat's transcript, Claude Code and jcode. `record.json` keeps the helpers' tool
  calls with their times, which the get-help check reads to tell when a helper started on the PR.
- `cli.json`: every `cotal` command the run issued, with its exit status and output.
- `teardown.json`: what the teardown stopped, and anything that still held the sandbox.
- `record.json`: the normalized record `grade.mjs` reads, and `result.json`: the graded result.

## Where a run writes outside its sandbox

Seats run under your own `HOME`, because Claude Code and jcode read your logins there. Claude Code
writes a project folder per working directory under `~/.claude/projects`. After the run the script
deletes the folders this run created: a folder counts as the run's when it is new since the run
started, is named for a path in the sandbox, and every transcript in it records a working directory
inside the sandbox. Claude Code also adds an entry per working directory to `~/.claude.json`. The
script leaves that file alone, because your live sessions write to it too.

## Teardown

The sandbox holds copies of your harness credentials while it runs, so nothing in it is kept. After
`cotal down`, the script stops the processes the run started, which it knows by the sandbox's own
`COTAL_HOME`, `XDG_CONFIG_HOME` or `TMPDIR` in their environment. Before each signal it checks that
the pid still names the same process.

Then it renames the sandbox to `<sandbox>.gone` and sets its mode to 000, so no process can enter it
by any path. It looks at every process you own for a working directory, an open file or a sandbox
path in its environment, inside the sandbox or inside this run's Claude Code project folders. Only
Claude Code processes working in the sandbox write to those folders, so the same look covers them.
If nothing holds either, it deletes them. A process that still holds one keeps the sandbox, with its
mode set back to 700, and fails the run; remove it once that process exits.

The barrier holds against path access only. Your own processes can still enter the sandbox after its
mode is set back to 700 for the delete, and the script does not guard against that. `--work` is
resolved to its real path at the start, because the kernel reports a process's working directory and
open files by their real path.

## Reading the results

`grade-cases.mjs` runs the pass checks on records built by hand, including runs that look right but
did not do the thing, and fails if any is graded wrong. `report.mjs` grades every run again from the files it kept, so runs from different days are read by
the same checks. A run that ended in an error fails whatever its checks say.

A scenario the baseline already passes proves nothing about the revised text. A revised run that
fails either changes the text before merge or is written into the PR as a known limit. One run per
cell is a single sample of a model's behaviour, so a difference of one cell is weak evidence.
