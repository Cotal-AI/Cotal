---
"@cotal-ai/manager": patch
---

A resume whose exact host session cannot be rebound now frees the seat it started only once the seat's exit is proved. It used to stop the seat best effort and free it at once, and a resumed seat keeps its retained credentials, so freeing it ran no deprovision: when the runtime's stop failed, the seat kept running while the manager no longer listed, stopped or reaped it. A seat whose stop cannot be proved now stays managed, the resume's error says so, and the manager's own stop then stops it or reports that it could not prove the exit.
