---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Create a missing Cotal config directory with mode 0700 from every writer, not only the extension
writer. Under a group-writable umask, `config set`, the seed store and lock files made it 0775, and
`completion` and `ext seed` then refused the directory cotal had just created. A completion file
that cannot be read now names why instead of a bare PERMISSION_DENIED.
