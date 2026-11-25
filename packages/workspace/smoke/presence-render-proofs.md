# Presence render proofs

`presence-render-sinks.json` classifies the census candidates. Each `honest-text` sink
needs an output assertion or a checked shared-renderer proof.

Each exclusion resolves to its entry's `rationale`, when present, or the rationale
for its class in `classRationales`. Entries with the same mechanics may share the
class reason. An exception needs its own reason identifying the different mechanics.
The census checks that both forms resolve to a non-empty explanation of at least
12 characters. It does not cap repeated wording. An explicit blank reason is invalid,
even when the class has a default.

`presence-render-proofs.ts` records reviewed smoke assertions by source path and sink
anchor. An assertion must read that sink's output. A check of another output in the
same module is insufficient. Component proofs must render the component, rather than
only call its formatting helper.

When changing a sink, update its manifest entry and reviewed binding together. Both
`smoke:presence-render-proofs` and `smoke:presence-render-census` reject missing source
anchors, missing proofs and unused bindings. The census also checks AST membership
and the source-renderer proof allowlist.

Run `pnpm smoke:presence-render-proofs` and the suites containing the cited assertions.
`pnpm smoke:view` captures `runWatchStream` output and mounts `WatchView` in Ink,
including presence updates. The live ToolLine sites cite the running-call assertion
in `pnpm smoke:web-agents-view`; its finished-call assertion is a negative control.
For a census check without the source-injection scanner probes, run
`COTAL_PRESENCE_RENDER_PROBE_CHILD=1 pnpm smoke:presence-render-census`.
