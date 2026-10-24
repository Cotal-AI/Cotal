---
"@cotal-ai/auth": patch
---

`cotal actor list --sub <subject>` and `cotal auth grants --sub <subject>` list one IdP subject's rows. The ledger still stores no subject: the subject derives to its owner as `actor grant --sub` does, and the report is titled `Rows for <subject> (owner <u_…>)`. JSON adds `subject` and `owner` to the result.
