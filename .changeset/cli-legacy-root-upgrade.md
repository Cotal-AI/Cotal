---
"@cotal-ai/cli": patch
---

Start a project folder an earlier release created with plain `cotal up` after a normal `down`. A folder with no stack journal that is neither prepared nor registered took the controller route, because an absent prepared root compared equal to the working directory, and then refused with no route back. It now keeps its retained launcher, identity, store and history. A controller `up` checks that the space is prepared or locally started at its root before it writes trust, configuration, a service definition, an instance or the stack journal, so a refusal leaves the folder unchanged and a hand-added registration is a known refusal rather than an unknown outcome. `space create` in a stopped legacy folder names `cotal up` instead of only "another folder".
