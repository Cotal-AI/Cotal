---
"@cotal-ai/cli": patch
---

`cotal persona edit` keeps your edited draft when it refuses with `CONFLICT` because the persona changed or was removed while the editor was open. It deleted the draft, so the edit was lost. The refusal now names the draft and how to use it, and a persona file that is gone is reported as removed.
