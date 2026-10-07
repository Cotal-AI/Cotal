---
"@cotal-ai/manager": patch
---

The manager's three resume control parsers, `parseResumeControlArgs`, `parseResumeCommitArgs` and `parseResumeFinalizeArgs`, now run one bounded parse with their own op name, byte cap and schema, and their argument schemas share one `attemptId` grammar. Before, each parser carried its own copy of the serializable and JSON-object refusals, the byte cap check and the issue formatting, and each schema spelled out the attempt-id rule, so a change made at one copy let `commitResume` refuse an attempt id that `resumePreserved` and `finalizeResume` still accepted. Shipped behaviour and error messages are unchanged.
