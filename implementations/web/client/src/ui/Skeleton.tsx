/** One skeleton row: a square where the icon goes and a bar `width` wide where the label goes. */
function Row({ width }: { width: string }) {
  return (
    <div className="ui-skel-row">
      <span className="ui-skel-av" />
      <span className="ui-skel" style={{ width }} />
    </div>
  );
}

/** One skeleton message: an avatar square and a bar per line, `lines` the bars' widths. */
function Message({ lines }: { lines: string[] }) {
  return (
    <div className="ui-skel-msg">
      <span className="ui-skel-av" />
      <div style={{ display: "grid", gap: 8, paddingTop: 4 }}>
        {lines.map((w, i) => <span key={i} className="ui-skel" style={{ width: w }} />)}
      </div>
    </div>
  );
}

/** The sidebar's places while the first reads are outstanding (mock section B, Loading): two rows
 *  where Needs you and Activity go, then the Channels and Direct messages headings over rows of
 *  bars, with the mock's widths. The bars are drawing, not content, so assistive tech skips them and
 *  the list says it is busy. */
export function SkeletonPlaces() {
  return (
    <nav className="ui-side-scroll" aria-label="Places" aria-busy="true">
      <div aria-hidden="true">
        <Row width="55%" />
        <Row width="42%" />
        <div className="ui-sec">Channels</div>
        <Row width="50%" />
        <Row width="38%" />
        <Row width="62%" />
        <div className="ui-sec">Direct messages</div>
        <Row width="46%" />
      </div>
    </nav>
  );
}

/** The centre while the first reads are outstanding (mock section B, Loading): a bar where the
 *  view's title goes and two skeleton messages. */
export function SkeletonView() {
  return (
    <div aria-hidden="true" style={{ display: "contents" }}>
      <header className="ui-bar"><span className="ui-skel" style={{ width: 120, height: 12 }} /></header>
      <div className="ui-col" style={{ width: "100%" }}>
        <Message lines={["30%", "85%"]} />
        <Message lines={["24%", "70%", "52%"]} />
      </div>
    </div>
  );
}
