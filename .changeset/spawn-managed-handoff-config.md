---
"@cotal-ai/cli": patch
---

A delegated seat command (`COTAL_MANAGED_HANDOFF_FILE` with `cotal spawn --config <persona-file> … --expect-owner … --expect-lifecycle-uid …`, as `delegatedSeatCommand` builds it) is accepted again. Since the command-line redesign, `cotal` took the handoff file before checking spawn's arguments, so the check no longer saw the variable and refused `--config` as "reserved for persisted internal launch callers". Without a handoff, `--expect-owner` and `--expect-lifecycle-uid` are refused first, naming `COTAL_MANAGED_HANDOFF_FILE`. `cotal spawn --help` now says `--creds` and `--on` apply to any managed launch, not only `--detach`, and that `--runtime` and `--allow-stale` are refused in favour of `cotal team deploy <file>`.
