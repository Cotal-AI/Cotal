---
"@cotal-ai/cli": patch
---

With nothing selected, `cotal config` and `cotal config get` now read through the space `spawn` uses from this folder, its prepared or registered space or the only running one, so they show the per-space value a launch here takes. They used to show your defaults while `spawn` used the folder's value. A `config set persona` there warns with `PERSONA_NOT_FOUND` when that space's catalog does not hold the persona. The report names the space with "(this folder's)" or "(the only running space)", and `--json` gives `scope.from` as `folder` or `running`.
