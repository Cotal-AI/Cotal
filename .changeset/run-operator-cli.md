---
"@cotal-ai/runtime": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/pi": minor
"cotal-ai": minor
---

`cotal run`, the workflow-run operator surface, self-registered by `@cotal-ai/runtime` and composed
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
