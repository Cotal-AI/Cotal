---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

In a folder whose `.cotal` is a link to another project's `.cotal`, `up` and `down` said the folder was copied from that project, `status` printed two inventory warnings without a cause, and `space create` said the folder held copied or moved records. Each now names the link: `up` and `down` refuse `CONFLICT` and say to use the stack from the project it leads to, `status` gives one warning that it did not read the attempt inventories through the link, and `space create` names the link.
