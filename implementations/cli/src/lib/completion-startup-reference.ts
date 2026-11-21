import { CommandFailure } from "@cotal-ai/workspace";

const bashCommentPrefix = /^[ \t]*#/;

/** Bash can treat a line beginning with # as data inside a multiline word or here-document. */
export async function completionStartupReference(source: string, stub: string, shell: string, path: string): Promise<string | undefined> {
  if (!source.includes(stub)) return undefined;
  const references = source.split("\n").flatMap((line, index) => line.includes(stub) ? [{ line, index }] : []);
  const possibleWiring = references.find(({ line }) => shell !== "bash" || !bashCommentPrefix.test(line));
  if (possibleWiring) return possibleWiring.line.trim();

  const comments = new Map<number, number>();
  try {
    const { LangVariant, parse, walk } = await import("sh-syntax");
    walk(await parse(source, { keepComments: true, variant: LangVariant.LangBash }), (node) => {
      if (node.type === "Comment") comments.set(node.hash.line - 1, node.hash.column);
    });
  } catch {
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `${path} could not be parsed to verify the remaining references to the completion stub; nothing was changed`, {
      target: { shell, path }, remedy: `verify the remaining stub mentions in ${path}, then run \`cotal completion uninstall bash\` again`,
    });
  }
  return references.find(({ line, index }) => comments.get(index) !== bashCommentPrefix.exec(line)![0].length - 1)?.line.trim();
}
