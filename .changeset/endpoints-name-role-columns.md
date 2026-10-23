---
"@cotal-ai/cli": patch
---

`cotal endpoints` now shows each participant's name and role in separate columns, as `cotal who` does. The Participant column held `<name>/<role>`, such as `manager/manager`, and following the Next line with that value, `cotal endpoint describe manager/manager`, was refused. The Participant column now holds the name `endpoint describe` takes. The `--json` rows are unchanged.
