---
"@cotal-ai/acp": patch
---

A Cotal thread in T3 Code and other ACP clients now has a Harness option for picking which application the agent runs.
The option lists the applications that can run a thread, such as claude, codex, jcode and pi. Choosing another harness starts it on that application's default model, and choosing a model moves the harness to that model's application, so the two always agree. The model list stays complete, because T3 Code checks a thread's saved model against it before it applies the other options. A thread that only drives an agent it loaded does not offer it.
