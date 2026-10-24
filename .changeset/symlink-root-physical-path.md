---
"@cotal-ai/workspace": patch
---

A path refused because a symlink is in it, such as `cotal space create <name> --root <link>`, now names the physical path it resolves to as the remedy, `use the physical path <path>`, in place of the general advice to use a path without symlinks. The refusal itself stays.
