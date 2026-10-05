---
"@cotal-ai/web": patch
---

The dashboard's ONLINE roster now groups live peers by the machine each one reports as its host (`card.meta.host`), with a count per machine, so an operator can see where seats run and how they are spread across machines without opening each agent. A peer that reports no host, such as a manager, is listed last under "host not reported". Seats do not report which manager runs them, so there is no manager grouping yet.
