---
"@cotal-ai/cli": patch
---

A refresh of an open mesh (`cotal up` while it runs) now ensures its manager as the first boot does, unless it runs with `--no-manager`. A bare refresh used to skip that step unless it carried `--runtime`, so over a manager pidfile that holds no pid it printed the already-running line and exited 0 with no manager, while the same refresh with `--runtime` reported `! control plane degraded:` and exited 1. Both now report the degraded control plane and exit 1, and a bare refresh restores a manager that is missing.
