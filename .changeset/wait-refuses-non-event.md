---
"@cotal-ai/runtime": patch
---

A workflow `wait` given a value that is not an event, such as `wait("never-sent")`, now fails its step with a message that names the four event constructors and the value it was given. Before, the hosted and local runtime failed it with the host's own `Cannot read properties of undefined (reading 'split')`.
