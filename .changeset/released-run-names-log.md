---
"@cotal-ai/runtime": patch
---

`cotal run show` on a released run says that its status does not record why and names
`cotal service logs stack-manager --space <space>`, where a hosted run's manager logs each release
with its reason. It used to show only the state.
