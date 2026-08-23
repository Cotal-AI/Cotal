---
"@cotal-ai/connector-jcode": patch
---

A jcode seat now records which provider is actually carrying its model, and refuses a
provider-prefixed model id at the launch boundary. The connector already refused to join under a
model label it did not receive, but that guarantee stopped at the model: a seat could be truthfully
labelled while its traffic was carried by a component nobody named, and `RuntimeInfo` already
carried the provider and routes in the same response the model check reads. A `provider/model`
specifier was forwarded verbatim to an endpoint that expects a bare id, so the refusal came back as
`model_not_found` naming neither the connector nor the prefix; it is now refused where the accepted
form can be named.
