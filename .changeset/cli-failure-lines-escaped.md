---
"@cotal-ai/cli": patch
---

Every `✗` failure line the CLI writes now shows a control character in the text it quotes as an
escape such as `\u001b`, as the usage refusal line already did. That covers `topology`, `meshes`,
`down -f`, `spawn`, `up`, `join`, `clean`, `attach` and the managed handoff. A path or argument
holding a terminal escape can no longer move the cursor or change the screen.
