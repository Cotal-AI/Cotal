---
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": patch
---

A bare `cotal up` in a new project now names its space after the project folder. Two new folders,
such as `~/Desktop/alpha` and `~/Desktop/beta`, start the spaces `alpha` and `beta`, where both used
to start `main` and the second refused. A folder name that is not a valid space name, such as
`My Project`, refuses `USAGE_INVALID`. A name another folder on this machine already registered or
prepared refuses `CONFLICT` and is not taken over. Both refusals write nothing and name
`cotal up --space <name>`. `--space` still names the space, and a folder whose records already name
one, or a folder inside such a project, keeps its recorded space. The receipt says the space was
named after the folder.

This changes a default. A script that ran a bare `cotal up` in a new folder and then addressed
`main`, such as `cotal spawn --space main`, now finds the folder's name there. Pass `--space main` to
`up` to keep the old name.
