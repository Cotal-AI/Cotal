---
"@cotal-ai/core": patch
---

`CotalEndpoint` emits one `error` event when the broker refuses the subscription behind `serveControl()`, `serveLiveness()` or `tap()`. It emitted two for that one refusal: the raw permission violation that ended the subscription, and the described permission denial from the connection status. Only the described denial is emitted now. Other faults that end those subscriptions are still emitted.
