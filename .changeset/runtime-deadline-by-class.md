---
"@cotal-ai/runtime": patch
---

A pause-plane failure now counts as a client deadline only when it is the NATS client's own `TimeoutError` class. Before, any error named `TimeoutError` passed, such as the `DOMException` from an expired `AbortSignal.timeout()`, and so did a `RequestError` whose cause was one, a shape the client never raises. Such an error was retried as a late reply or a starved host and then failed as `L4026` or `L4025`. It now fails on the first attempt with its own error, as every other fault does. Real client deadlines are classified as before.
