---
---

The remotion header variants now center the ASCII wordmark with the shared `WM_WIDTH` constant, and the console variant uses it as the wordmark's row width. Seven call sites used to write the width as a literal `42` while `WM_WIDTH` had no reader, so a wider or narrower wordmark would have rendered off-center. The rendered frames do not change. This touches the `remotion/` asset project only; no published package changes.
