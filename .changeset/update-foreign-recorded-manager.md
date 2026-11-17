---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal update --self` no longer stops when a Manager for the selected hosted space runs on this machine from another Cotal installation. That Manager keeps its own files, so the update installs, reconciles and exits 0. Before, the update installed the new version, refused on that Manager and rolled back.
