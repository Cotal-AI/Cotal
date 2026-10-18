---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

`MeshAgent` now arms the `turn-pending` poll and the turn-boundary re-poll only when `config.managerInstanceId` (`COTAL_MANAGER_INSTANCE`) is set, and `Manager` (`spawnDelegated`) / `delegatedSeatCommand` / `cotal spawn` (`applyHandoffManagerInstance`) now carry `COTAL_MANAGER_INSTANCE` alongside local spawn, restart, and resume so every manager-launched seat polls its launching manager while a directly connected session never polls a manager. `cotal spawn` with `COTAL_MANAGED_HANDOFF_FILE` now requires `COTAL_MANAGER_INSTANCE` before any broker or exchange plane is touched (`COTAL_MANAGED_HANDOFF_FILE requires COTAL_MANAGER_INSTANCE`; a newer CLI child under an older manager or runtime refuses every delegated launch). Because only manager-launched seats poll, `notePullTrouble` now reports `no responder answered` once per outage while keeping only the startup `still reconciling` window silent.
