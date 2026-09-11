---
"@cotal-ai/core": patch
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
"cotal-ai": patch
---

Make `cotal input` wait for the target runtime to acknowledge the PTY write before printing its byte receipt. Custodial and in-process PTY writes now return the accepted UTF-8 byte count or reject, and the manager refuses missing, partial, or failed acknowledgements with an error that names the seat. A dropped write therefore exits non-zero without a `sent` receipt instead of claiming delivery from the intended buffer.
