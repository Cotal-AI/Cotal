import { CommandFailure, type Connection } from "@cotal-ai/workspace";

/** The refusal for a space whose streams are not on its broker. A live `cotal space delete` leaves
 *  the space so until `cotal up` creates them again, and before then a read finds nothing and a send
 *  finds no stream to store it. */
export function streamsAbsent(conn: Pick<Connection, "space" | "root">): CommandFailure {
  return new CommandFailure("refused", "TARGET_UNAVAILABLE", `the streams of ${conn.space} are not on its broker; a space delete removes them, and nothing can be read or stored until they are created again`, {
    target: { space: conn.space },
    remedy: conn.root ? `run cotal up in ${conn.root} to create them again, empty` : "run cotal up where this space's stack runs to create them again, empty",
  });
}
