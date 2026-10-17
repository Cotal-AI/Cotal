/** The Live chip in a session's header (mock S, `ui-livechip`): new steps arrive as the agent
 *  publishes them. */
export function LiveChip({ name }: { name: string }) {
  return <span className="ui-livechip" title={`New steps appear as ${name} publishes them`}><i />Live</span>;
}
