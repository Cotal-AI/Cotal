---
"@cotal-ai/workspace": patch
"@cotal-ai/delivery": patch
"@cotal-ai/cli": patch
---

Offline registered spaces now name `cotal space forget` as the command to unregister them.
The connection refusal and delivery daemon no longer suggest the hidden legacy `cotal meshes rm` command.
Discovered spaces instead name removal from the provider's catalog followed by `cotal sync`, since their registrations cannot be forgotten locally.
