---
"@cotal-ai/cli": patch
---

An editor that exits non-zero during `persona edit`, as vim's `:cq` does, now cancels the edit: it
exits 0 with a `USER_CANCELLED` warning, saves nothing, and keeps and names a draft it changed. It
used to fail with `OPERATION_FAILED`, exit 5. A draft left as it was now saves nothing and says the
persona is unchanged instead of "Persona saved".
