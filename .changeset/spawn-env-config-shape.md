---
"@cotal-ai/core": patch
---

The cotal config reader now refuses a `spawn` that is not an object and a `spawn.env` that is not a list of non-empty names, with the file and the field named, as it already does for `modelPolicy` and `connectors.<name>.mcpServers`. Before, a string `spawn.env` was spread into one-letter names, so a seat received every one-letter variable the string spelled and not the one the operator named. A non-string entry or an object crashed every spawn and resume with a bare `TypeError`, and a non-object `spawn` was ignored.
