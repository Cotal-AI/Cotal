---
"@cotal-ai/manager": patch
---

A spawn or launch refusal now reaches the caller under the code the manager refused it with. A refusal thrown as an envelope during a spawn kept its message and details but lost its code, and a spawn refused before acceptance was always served as `failed-precondition`, so an invalid persona file, which the manager refuses as `bad-request`, arrived as `failed-precondition`. A refusal that carries no code is still `failed-precondition`.
