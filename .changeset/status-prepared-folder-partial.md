---
"@cotal-ai/cli": patch
---

`cotal status` with a selected space that is not registered and a `~/.cotal/prepared` it cannot read now reports partial, exit 4, naming the folder under `meshes.unreadable`, as it does for an unreadable mesh registry folder. It refused the whole report. A hint two readers give is listed once.
