---
"@cotal-ai/cli": patch
---

On a static-auth root, `cotal endpoint invoke` of an endpoint other than the manager is refused by the broker, because the operator's own credential requests the manager only. That refusal now names the paired caller file that makes the call, `cotal auth mint <name> --endpoint <endpoint> --space <space> --out <private-file>`, to pass with `--creds`. It names the space the call resolved and any `--server` it was given, so the caller is issued for the space that refused even when another space is current. The remedy appears when the call and the endpoint's whole surface are untargeted synchronous ephemeral commands with no instance pin, scatter, cast, wait or admin flag. `cotal endpoint init` ends with the `ep check` command for the contract it created, quoted for the shell, instead of a `<directory>` placeholder.
