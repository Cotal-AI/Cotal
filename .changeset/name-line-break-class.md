---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

`assertValidName` now refuses a name holding any line break a Unicode-aware splitter honours: VT, FF, NEL (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029), as well as CR and LF. Before, it tested only CR and LF, so `new CotalEndpoint`, agent-file loading, the gateway connect request and the manager's launch spec accepted such a name and published presence under it, although the validator states a single-line rule. The class is now exported from `@cotal-ai/core` as `LINE_BREAK`, and the connector's message framing uses the same definition.
