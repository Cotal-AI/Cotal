---
"@cotal-ai/cli": patch
---

The guided service add form now shows a preset option's default and treats Enter as leaving that option to it.

Typing a value still uses that value. An empty answer leaves the option to its default, including Enter on a yes-or-no option, and an option with no default stays required. The flag form is unchanged.
