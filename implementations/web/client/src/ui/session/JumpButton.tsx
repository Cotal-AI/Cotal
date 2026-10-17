import { ArrowDown02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../../icons/Icon.tsx";

/** What the Live chip becomes while the reader is scrolled up (mock C, `ui-jump`): how many steps
 *  arrived below, and a click back down to them. */
export function JumpButton({ count, onJump }: { count: number; onJump: () => void }) {
  return (
    <button type="button" className="ui-jump" onClick={onJump}>
      <Icon icon={ArrowDown02Icon} size={16} className="ui-ic" />
      {count === 1 ? "1 new step" : `${count} new steps`}
    </button>
  );
}
