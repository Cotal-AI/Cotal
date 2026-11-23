import { once } from "node:events";
import { EpEnvelopeError } from "@cotal-ai/core";
import { authorityWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { openUsernameAssignment } from "../src/username-assignment.js";

interface RaceInput {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  owner: string;
  username: string;
}

const [input] = await once(process, "message") as [RaceInput];
const { server, space, dataAccount, owner, username } = input;
const writer = await openAuthorityClient({ server, space, dataAccount, label: "username-cas-smoke",
  grants: (id) => authorityWriterGrants(space, id), log: console.error });
try {
  // Exercise only assignment. The full auth service admits one authority plane per space.
  const assignment = await openUsernameAssignment(writer.nc, space, { assertHeld: async () => {} }, console.error);
  const start = once(process, "message");
  process.send!("ready");
  await start;
  const result = await assignment.choose(owner, {}, username).catch((error: unknown) => {
    if (error instanceof EpEnvelopeError && error.code === "conflict" && /already reserved for another owner/.test(error.message))
      return { conflict: true };
    throw error;
  });
  process.send!(result);
} finally {
  await writer.close();
  process.disconnect();
}
