---
"@cotal-ai/cli": patch
---

`cotal completion install` and `uninstall` now name the way out when they refuse an owned stub or startup block you edited. The new `--force` rewrites (install) or removes (uninstall) the recorded stub and each block from `# >>> cotal completion >>>` to `# <<< cotal completion <<<`, keeping startup content outside the markers. A block whose end marker is gone is still refused, naming the file to edit by hand. The stub refusal names the stub, and for an integration you modified bare `cotal completion` offers `install` and `uninstall` only with `--force`.
