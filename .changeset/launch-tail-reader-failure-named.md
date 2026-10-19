---
"@cotal-ai/manager": patch
---

A launch that exits before it joins the mesh, and a supervised restart that fails, now say `last output unreadable: <reason>` when the manager cannot read the child's last line. Before, every failure of that read was dropped, so a broken reader looked like a seat that printed nothing. A runtime that cannot attach, such as tmux, still reports no last output.
