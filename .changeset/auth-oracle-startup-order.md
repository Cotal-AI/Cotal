---
"@cotal-ai/cli": patch
---

Start delivery's liveness oracle before the user-auth startup step on ordinary mesh startup and refresh, with manager startup afterward. A crashed auth predecessor can then be checked in the first repair invocation without weakening its claim guard or changing lease waits.
