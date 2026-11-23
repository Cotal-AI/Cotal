import * as prompts from "@clack/prompts";
import { isCredentialTransportUrl } from "@cotal-ai/core";
import { oneLine, resolveMeshTarget, untilInputEnds, userAuthStateDir } from "@cotal-ai/workspace";
import { fetchIdpJwt, normalizeIdpUrl, type IdpSession } from "./login.js";
import { readAuthResponseJson } from "./response-json.js";
import { loadAuthServiceInfo } from "./store.js";
import { USERNAME_BACKFILL_PATH, USERNAME_PICK_PATH } from "./username-routes.js";

type UsernameReply = { suggestion?: string; username?: string; code?: string; error?: string };
type Request = (username?: string) => Promise<{ status: number; body: UsernameReply }>;

async function usernameRequest(base: string, path: string, body: object, cap?: string): Promise<{ status: number; body: UsernameReply }> {
  const url = new URL(base);
  if (!isCredentialTransportUrl(url) || url.username || url.password)
    throw new Error("username service requires HTTPS or a loopback HTTP URL");
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", ...(cap ? { authorization: `Bearer ${cap}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await readAuthResponseJson(response, "the space's username service") as UsernameReply };
}

/** Nonterminal logins leave the registry untouched, including the suggestion lookup. */
export async function pickUsername(interactive: boolean, request: Request, ask: (suggestion: string, refusal?: string) => Promise<string | undefined>): Promise<string | undefined> {
  if (!interactive) return undefined;
  const initial = await request();
  if (initial.status === 403 || initial.status === 404) return undefined;
  if (initial.status !== 200) throw new Error(initial.body.error ?? "the username service did not return a suggestion");
  const suggestion = initial.body.suggestion;
  if (typeof suggestion !== "string") return initial.body.username;
  let refusal: string | undefined;
  for (;;) {
    const username = await ask(suggestion, refusal);
    if (username === undefined) return undefined;
    const answer = await request(username);
    if (answer.status === 200 && typeof answer.body.username === "string") return answer.body.username;
    if (answer.status !== 400 && answer.status !== 409) throw new Error(answer.body.error ?? "the username service did not confirm the choice");
    if (answer.status === 409) {
      const current = await request();
      if (current.status === 200 && typeof current.body.username === "string") return current.body.username;
      if (current.status !== 200) throw new Error(current.body.error ?? "the username service could not confirm the account state");
    }
    refusal = answer.body.error ?? "the username was refused";
  }
}

export async function pickLoginUsername(idp: string, session: IdpSession, interactive: boolean, space?: string): Promise<string | undefined> {
  if (!interactive) return undefined;
  let mesh: ReturnType<typeof resolveMeshTarget>;
  try { mesh = resolveMeshTarget(process.cwd(), { space, readOnly: true }); }
  catch (error) { if (space !== undefined) throw error; return undefined; }
  if (mesh.mode !== "user" || !mesh.userAuth || normalizeIdpUrl(mesh.userAuth.idp.url) !== idp) return undefined;
  const local = mesh.userAuth.remote ? undefined : loadAuthServiceInfo(userAuthStateDir(mesh.root, mesh.space));
  const base = mesh.userAuth.remote ? mesh.userAuth.endpoints?.url : local?.url;
  if (!base) return undefined;
  const request: Request = async (username) => usernameRequest(base, USERNAME_PICK_PATH,
    { idpToken: await fetchIdpJwt(idp, session.token), ...(username === undefined ? {} : { username }) }, local?.cap);
  return pickUsername(interactive, request, async (suggestion, refusal) => {
    if (refusal) prompts.log.warn(oneLine(refusal));
    const answer = await untilInputEnds((signal) => prompts.text({ message: `Choose your permanent username for ${oneLine(mesh.space)}`, initialValue: suggestion, signal }));
    return prompts.isCancel(answer) ? undefined : answer;
  });
}

export async function backfillUsername(dir: string, owner: string): Promise<string> {
  const service = loadAuthServiceInfo(dir);
  if (!service) throw new Error("start the space's auth service before backfilling a username");
  const { status, body } = await usernameRequest(service.url, USERNAME_BACKFILL_PATH, { owner }, service.cap);
  if (status !== 200 || typeof body.username !== "string") throw new Error(body.error ?? "the auth service did not confirm the backfill");
  return body.username;
}
