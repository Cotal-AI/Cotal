---
"@cotal-ai/pi": minor
---

A pi agent's own commands, prompt templates and skills can now be listed and run from its agent endpoint, and its running turn interrupted, on pi 0.84.2 or later. The pi extension gives its mesh agent a command dispatcher: it lists pi's `getCommands()`, runs a listed name through pi's own command path (`sendUserMessage` with `expandPromptTemplates`), refuses a name pi does not list before pi sees it, and stops a turn with pi's abort. On an older pi, which would send `/name args` to its model as text, `commands` answers `supported: false`.
