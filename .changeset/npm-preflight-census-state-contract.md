---
---

The release preflight's published type now carries the census verdict it can actually return. Its declaration described the verdict as an arbitrary string, so renaming or dropping a verdict changed nothing a reader could see, and a caller got no help from the type. The verdict is now named in the preflight itself and appears in the generated declaration, and the release smoke refuses a declaration that describes it loosely again.

Refs #1585
