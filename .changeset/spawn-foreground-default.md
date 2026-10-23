---
"@cotal-ai/cli": patch
---

A bare `cotal spawn [<persona>]` runs the application in this terminal again, on every kind of
mesh, with no manager involved, as it did before 0.91.0. Since 0.91.0 it launched through a manager
and attached, so several live managers refused it or asked which to use. A manager runs a launch
only with `--detach` (`-d`) or `--on <instance>`, and `spawn -d` still asks which of several
managers to use on a terminal.
`--restarts`, `--creds`, `--json` and `--plain` without `-d` or `--on` are refused with a Next that
adds `-d`. A missing persona names `--file <persona.md>`, and a remote user-auth mesh that advertises
no agent-provisioning endpoint names `-d` among its remedies.
