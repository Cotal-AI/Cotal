---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Stop assuming the default space after a project forgets its space or when its control directory is empty. Persona, team, identity and spawn previews now report that no space is selected. Explicit startup can still initialize an empty project.

Name a nearby Mesh team file and its declared space in the available next steps. Entry help also finds the project-root file from a subdirectory, and unrelated prepared-space inventory no longer hides its actions. Discovery skips non-regular and oversized files and does not launch the team.
