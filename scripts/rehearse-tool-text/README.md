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
- `record.json`: the normalized record `grade.mjs` reads, and `result.json`: the graded result.

After the run every process inside the sandbox is stopped and the sandbox is deleted, along with the
Claude Code project folders its seats created. The sandbox holds copies of the operator's harness
credentials while it runs, so nothing in it is kept. A process that will not stop keeps the
sandbox in place and fails the run.

## Reading the results

A scenario the baseline already passes proves nothing about the revised text. A revised run that
fails either changes the text before merge or is written into the PR as a known limit. One run per
cell is a single sample of a model's behaviour, so a difference of one cell is weak evidence.
