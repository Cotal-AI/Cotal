/** Decode an auth face's answer without inventing a result when its body is unreadable.
 * The caller still checks the shape and interprets any authorization or operation outcome. */
export async function readAuthResponseJson(response: Response, face: string): Promise<unknown> {
  return response.json().catch(() => {
    throw new Error(`${face} answered HTTP ${response.status} with a body that could not be read as JSON`);
  });
}
