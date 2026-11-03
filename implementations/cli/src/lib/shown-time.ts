/** A message's time as a person reads it: the local time of day, with the local date when it is not
 *  today. `history` and `chat` both show times this way; a JSON document or `--stdio` record keeps
 *  the machine-readable time. */
export function shownTime(at: string | number, now = new Date()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString();
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}
