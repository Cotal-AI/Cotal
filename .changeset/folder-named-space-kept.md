---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

A new project's space, which a bare `cotal up` names after its folder, now keeps that name after
`cotal down`. Its registration stays while it is stopped. Another folder of the same name is refused
`CONFLICT`, naming the stopped project, where it used to take the name over. The stopped project's
`ps` and `spawn` no longer reach that other folder's stack. `cotal up` in the project starts it again
on the same launcher, and `cotal space forget <name>` frees the name. An explicit `up --space` still
takes over a stopped holder, and the `down` of any other legacy folder still drops its registration.
`status` names the `cotal up` that starts again a stopped stack this machine started, where it used to
say its saved registration needed attention.
