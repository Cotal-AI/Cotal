/**
 * The folder question a managed launch asks on a terminal when its manager is not known to run on
 * this host. Enter keeps the manager's workspace and sends no folder, without asking the manager. A
 * typed folder goes to the manager's check as typed, a Windows drive or UNC path included, and the
 * folder the manager resolved is the one used. A folder it refuses is shown with its reason and asked
 * again, with the typed text left to edit. Cancelling gives null. The receipt names the folder and
 * the host, and a typed folder's line gives the command again with `-C` and `--on`. A manager whose
 * host is not reported is asked about as the manager's host.
 *
 * Drives the real clack prompt over in-memory streams, with a stand-in for the manager's
 * `resolve-cwd`. No binary, broker or terminal.
 *
 * Run: pnpm smoke:manager-folder
 */
import { PassThrough, Writable } from "node:stream";
import { createSuite } from "@cotal-ai/smoke-kit";
import { askManagerFolder, type FolderCheck, type ManagerSelection } from "../src/lib/manager-choice.js";

const { check, finish } = createSuite();
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const remote: ManagerSelection = { manager: { name: "remote", instanceId: "krudqi08ilzx2viqeh8sv34ygs1surr", host: "fx6-remote", activity: null, since: null }, selector: "remote" };
const unknown: ManagerSelection = { manager: { name: null, instanceId: "krudqi08ilzx2viqeh8sv34ygs1surr", host: null, activity: null, since: null }, selector: "krudqi08ilzx2viqeh8sv34ygs1surr" };

/** Ask once over in-memory streams. Each step waits for its pattern in what was written since the
 *  last step, then types its keys. */
async function ask(selection: ManagerSelection, answers: (path: string) => FolderCheck, steps: [RegExp, string][]) {
  const input = new PassThrough();
  let text = "", mark = 0;
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const asked: string[] = [];
  const result = askManagerFolder(selection, ["spawn", "-d"], async (path) => { asked.push(path); return answers(path); }, { input, output });
  for (const [pattern, keys] of steps) {
    for (let i = 0; i < 200 && !pattern.test(plain(text.slice(mark))); i++) await sleep(10);
    mark = text.length;
    input.write(keys);
  }
  const value = await Promise.race([result, sleep(3000).then(() => "unsettled" as const)]);
  input.end();
  return { value, asked, out: plain(text) };
}

const question = /Which folder on fx6-remote should the agent work in\?/;
{
  const run = await ask(remote, () => { throw new Error("not asked"); }, [[question, "\r"]]);
  check("Enter keeps the manager's workspace: no folder, and the manager is not asked", run.value === undefined && run.asked.length === 0, run);
  check("the question offers the manager's workspace as the default", run.out.includes("Manager's workspace (default)"), run.out);
  check("the receipt names the manager's workspace and the host, with no rerun line", /Folder chosen[\s\S]*Folder:\s+Manager's workspace \(default\)[\s\S]*Host:\s+fx6-remote/.test(run.out) && !run.out.includes("-C"), run.out);
}
{
  const run = await ask(remote, (path) => ({ cwd: `${path}/resolved` }), [[question, "/srv/work\r"]]);
  check("a typed folder is the one the manager resolved", run.value === "/srv/work/resolved" && run.asked.join() === "/srv/work", run);
  check("its receipt gives the command again with -C and --on", run.out.includes("spawn -d -C /srv/work/resolved --on remote"), run.out);
}
for (const typed of ["C:\\Users\\dev\\work", "\\\\server\\share\\work", "relative/path", "  /padded  "]) {
  const run = await ask(remote, (path) => ({ cwd: path }), [[question, `${typed}\r`]]);
  check(`${JSON.stringify(typed)} reaches the manager's check as typed`, run.asked.length === 1 && run.asked[0] === typed && run.value === typed, run);
}
{
  const refusal = 'cwd does not resolve on this host: "/missing" (path cannot be resolved: ENOENT)';
  const run = await ask(remote, (path) => path === "/missing" ? { refusal } : { cwd: path }, [
    [question, "/missing\r"],
    [/cannot use it[\s\S]*Which folder/, "\x7f".repeat("/missing".length) + "/srv/ok\r"],
  ]);
  check("a refused folder is shown with the manager's reason", run.out.includes(`the manager on fx6-remote cannot use it: ${refusal}`), run.out);
  check("and asked again; the next folder is the one used", run.value === "/srv/ok" && run.asked.join() === "/missing,/srv/ok", run);
}
{
  const run = await ask(remote, () => ({ refusal: "no" }), [[question, "/missing\r"], [/cannot use it[\s\S]*Which folder/, "\r"]]);
  check("asked again, the typed text is left to edit", run.asked.join() === "/missing,/missing", run);
}
{
  const run = await ask(remote, () => { throw new Error("not asked"); }, [[question, "\x03"]]);
  check("cancelling gives null and asks the manager nothing", run.value === null && run.asked.length === 0 && run.out.includes("nothing was done - no folder was chosen"), run);
}
{
  const run = await ask(unknown, () => { throw new Error("not asked"); }, [[/Which folder on the manager's host should the agent work in\?/, "\r"]]);
  check("a manager whose host is not reported is asked about as the manager's host", run.value === undefined && /Host:\s+not reported/.test(run.out), run.out);
}
finish();
