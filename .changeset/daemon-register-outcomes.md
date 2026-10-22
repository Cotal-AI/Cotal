---
"cotal-ai": patch
---

`cotal daemon register` reports what actually happened when nothing reached the space. A sign-in the provider rejected is `AUTH_REQUIRED` with the sign-in step, and any other failure before sending is `DEPENDENCY_UNAVAILABLE`; only an answer that may have reached the space is `OPERATION_UNKNOWN`. A space refusal reason or pending phase the daemon does not recognize is reported as `UNRECOGNIZED`, and the space's own text is never shown.
