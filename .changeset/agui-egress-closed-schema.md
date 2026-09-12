---
---

AG-UI egress fence now validates the whole frame envelope against a closed schema, refusing any unknown or extra property at the frame level or inside individual events and naming the path. Previously, the fence only checked `.events[].type`, so tool bytes on a sibling property of the event, on an unknown top-level property, or nested inside an allowed event's unknown field passed untouched.
