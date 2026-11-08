---
"@cotal-ai/cli": patch
---

Export a registered remote user-auth space to a private connection-bundle file with `cotal space export <name> --out <private-file>`.

Preserve recorded trust pins, transport and event policy, and existing sentinel custody without copying a login session or signing authority. Existing output paths and unsupported registrations refuse; secret material stays out of command output.
