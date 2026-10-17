---
"@cotal-ai/core": patch
---

Delete the presence and channel-registry watch consumers when an endpoint stops, when a silent presence watch is rebound, and when a manual reconnect retires a live connection, including a watch whose bind was still in flight at that moment. They used to stay on the broker for five minutes, so repeated starts and stops or a silent bucket piled up idle consumers on both KV streams.
