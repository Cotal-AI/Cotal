---
"@cotal-ai/auth": minor
---

`cotal auth-service --spaces <manifest>` takes service endpoints per space. A version 2 manifest entry takes `"serviceEndpoints": true` (or `false`, the same as leaving it out). A lane whose entry sets it opens the service endpoint host, its discovery and service callout connections and its admission record, and serves `/service-endpoint-authority` and `/service-endpoint-host` on both faces, as `auth-service --space --service-endpoints` does. A lane without it opens none of that and answers both routes 404. Changing the field closes and reopens that space's lane alone. The field needs no public face.

**Breaking:** `--service-endpoints` now refuses beside `--spaces`, where from 0.112.0 it turned service endpoints on for every lane. Set `"serviceEndpoints": true` on the entry of each space that keeps them and drop the flag; see UPGRADING.

`@cotal-ai/auth` exports `parseAuthHostManifest(text)` and the `AuthHostEntry` type, so a program that writes the manifest checks it with the parser the host applies, and gets the host's message, before it renames the file into place.
