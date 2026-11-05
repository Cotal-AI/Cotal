/** Compile-time reply checks, included by the core smoke typecheck. */
import type { EndpointReply, EpError } from "../src/index.js";

function replyTypes(reply: EndpointReply, error: EpError) {
  // @ts-expect-error A failed reply must carry its error.
  const missingError: EndpointReply = { v: 1, id: "missing", ok: false };
  // @ts-expect-error A successful reply cannot carry an error.
  const successError: EndpointReply = { v: 1, id: "success-error", ok: true, error };
  const copiedSuccess = { v: 1 as const, id: "copied", ok: true as const, error };
  // @ts-expect-error The rule also applies beyond fresh object literals.
  const copiedError: EndpointReply = copiedSuccess;
  // @ts-expect-error The discriminant is a boolean, not a string.
  const badOk: EndpointReply = { v: 1, id: "bad-ok", ok: "yes" };
  const success: EndpointReply = { v: 1, id: "success", ok: true, data: null, receipt: "receipt" };
  const failure: EndpointReply = { v: 1, id: "failure", ok: false, error };
  const followed: EndpointReply = { v: 1, id: "followed", ok: false, error, data: { name: "allocated" } };
  if (reply.ok === false) {
    const message: string = reply.error.message;
    void message;
  }
  if (reply.ok === true) {
    const absent: undefined = reply.error;
    void absent;
  }
  void [missingError, successError, copiedError, badOk, success, failure, followed];
}
void replyTypes;
