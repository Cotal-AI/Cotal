---
"@cotal-ai/workspace": patch
---

The comment on the `space add` second-tenant refusal and the P7/P1 design note now name `ensureRootForSpace` in the CLI's `up` command as the root-pin refusal. They used to cite it as `up.ts:2233`, and that line had drifted onto an unrelated interface field. No behavior changes.
