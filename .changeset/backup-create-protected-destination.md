---
"@cotal-ai/cli": patch
---

`backup create` refuses a destination in a folder another local account could write, with the same
`PERMISSION_DENIED` refusal and `chmod` remedy that `backup verify` and `backup restore` give for
the artifact there. It used to publish the artifact, which its own verify then refused.
