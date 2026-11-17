/**
 * The clauses a session's own refusals take from the front end that hosts it, so the library never
 * names another front end's commands or keys.
 */
export interface ChatWords {
  /** How to get a session that may use `channel`. It ends a grant refusal's sentence. */
  readonly reopen: (channel: string) => string;
  /** How to answer one message. It ends the refusal for a name that several gone senders carry. */
  readonly answerOne: string;
}
