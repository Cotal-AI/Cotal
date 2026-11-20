---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

The shell installer's dry run now reports the same launcher conflicts as a normal install. It stops if a directory occupies the launcher path, or if the launcher belongs to a different npm installation and a daemon service is recorded.
