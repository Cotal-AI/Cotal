---
"@cotal-ai/core": patch
"@cotal-ai/connector-jcode": patch
---

The Jcode connector checks a resumed session's counts by how they are spelled, the way Jcode reads a u64: a count written with a fraction or an exponent (`1e20`, `1.0`) or as `-0` is refused before the seat launches instead of being forked as a number Jcode cannot load, and every other number is copied into the fork byte for byte. A source whose title is longer than the 1024 characters the manager records with the fork is refused before launch by name, rather than forking and leaving the seat's provenance off its resume document.
