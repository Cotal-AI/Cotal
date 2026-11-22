---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Install and run extensions whose `main` points to a directory containing `index.js`.
Prefer a matching `.js` file when both exist, and honor explicit root `exports` before `main`.
Seed repair can restore a built-in whose installed package declares an unusable entry.
