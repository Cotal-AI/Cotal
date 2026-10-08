---
"@cotal-ai/web": patch
---

The dashboard's console and graph pages now escape peer-supplied text through one HTML escaper shared from `parts.js` instead of a copy each, so the two can no longer drift. A missing value now renders as empty text on the console page as it already did on the graph, where the console used to show the words `null` or `undefined`.
