---
"@cotal-ai/cli": patch
---

`cotal up --root <root> --no-manager` run from another folder now quotes the root in the `cotal up --root` its Next offers when a shell would split it, so a folder name with a space, an apostrophe or a `$` pastes as one word. It used to print the path raw, which a shell split at its spaces, expanded at its `$`, or refused as an unmatched quote. The `--json` result and the `cotal down` description still name the path as it is.
