---
"@cotal-ai/seat": patch
"cotal-ai": patch
---

Compile the seat JavaScript and type entrypoints during pack and publish after validating both native helpers. A new installed-distribution smoke packs the full CLI closure from an assembled seat tree and proves a fresh npm install imports seat, imports the manager, and prints the packaged CLI help banner.
