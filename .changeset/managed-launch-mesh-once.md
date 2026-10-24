---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A managed `cotal spawn` and `cotal attach --on` name the mesh once, in the `Mesh:` heading of the
report that answers. The launch and attach blocks name the space as a field, and the `→ using mesh`
line is gone. The waiting line now says the manager answers when it refuses the launch, or when the
agent joins or exits, within about 30 seconds, and wraps to the terminal.
