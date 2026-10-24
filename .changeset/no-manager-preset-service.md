---
"@cotal-ai/cli": patch
---

On a stack started with `--no-manager` whose root runs a `manager` preset service, `status` names that
service on its Manager row, and in `--json` as `folder.managerService`, instead of saying no manager
runs and that bare `up` adds one. Bare `up` there refuses naming the service and the
`cotal svc stop <name> --instance <id> --space <space> --yes` that stops it, instead of calling it a
legacy pidfile process with no next step.
