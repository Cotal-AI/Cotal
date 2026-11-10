# Presence render proofs

`presence-render-sinks.json` classifies the census candidates. Each `honest-text` sink
needs an output assertion or a checked shared-renderer proof.

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
