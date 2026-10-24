---
"@cotal-ai/cli": patch
---

The refusal `reset store`, `reset space` and the other store and identity commands give on a space
that may still run now names each process once. The manager and the delivery daemon were listed by
their own pidfiles and again as stack members. Such a process is now listed as its stack member, with
the pidfile's pid and the member's instance.
