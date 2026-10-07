---
"@cotal-ai/core": patch
---

The credential comments in `provision.ts`, `endpoint-grants.ts` and `agent-file.ts` now describe the ep rows each control credential holds. The `control-caller-privileged` and `control-caller-admin` profile members, the `MintOpts.capabilities` and `AgentFile.capabilities` docs, the agent `admin` capability branch and the `operatorInstrumentCapabilities` doc still named `ctl.<privileged>` and `ctl.<admin>` subjects or a privileged control subject that no credential is minted with. The supervisor doc said it serves the three control tiers and holds a singleton lease, and now lists what it holds: its per-instance lease key, the renewal lease key, its presence key, the delivery-admin call, the manager liveness rows and a read of the delivery lease row. No behavior changes.
