---
---

The mutation coverage validator now runs in CI. `pnpm smoke:mutation-metadata` checks every tracked mutation config against the validator's metadata and gradability rules without executing any suite, so a config that `mutation-proof` grades KILLED but the validator refuses no longer merges silently. The refusals already on main are pinned by config content and refusal text in `scripts/mutation-coverage.recorded.json`. A new or edited config must pass, and an entry fails the gate when it is not in the parent commit's record, or once its config is accepted, changed, refused for another reason, or no longer tracked. This changes repository tooling only; no published package changes.
