---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

A pty seat whose declared startup confirmation never appears is now stopped the way a graceful stop ends it, so a child that ignores SIGTERM is killed 3 seconds later. The in-process pty runtime, which `createRuntime("pty")` uses for every launch, sent SIGTERM once and never escalated, so such a child kept running behind a failed gate and the launch resolved as uncertain instead of failing. Both pty runtimes now share one `StartupConfirmGate` from `@cotal-ai/seat`, which owns the prompt match, the 15-second window, the failure message and the exit diagnostic.
