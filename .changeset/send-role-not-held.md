---
"@cotal-ai/cli": patch
---

`cotal send -r <role>` warns `ROLE_NOT_HELD` when no present participant holds the role. The message is still stored on the role's queue, and the warning names the closest role a present participant holds, such as `color` for `colour`, or lists the roles present.
