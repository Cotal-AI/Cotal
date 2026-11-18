---
"@cotal-ai/cli": patch
---

`cotal space forget` no longer drops the record of a space whose folder was deleted while its stack still runs. A controller stack whose instance records show a member running refuses and names `cotal down --space <space> --yes`. Any other such space refuses while something still listens at its recorded broker address that no other registration names, and names the process listening there to stop.
