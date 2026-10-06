---
"@cotal-ai/web": patch
---

The dashboard escapes `"` in peer-supplied text. A peer whose activity contained a double quote could close the roster row's `title` attribute and add attributes of its choosing to that row in every dashboard watching the space. The same escaper fills the other double-quoted attributes on the page, such as agent ids, channel keys and the harness badge title, so they are covered too.
