/**
 * A notice sink for a module under test: each line it said and the decision
 * the line reports (todo 119), index for index, so a test can assert the
 * gear icon's settings beside the words.
 */
import type { DecisionKind, NoticeSink } from '../../../shared/decisionSettings';

export interface NoticeLog {
  notices: string[];
  kinds: Array<DecisionKind | undefined>;
  notice: NoticeSink;
  /** The decision the first line reading `message` reports. */
  kindOf(message: string): DecisionKind | undefined;
}

export function noticeLog(): NoticeLog {
  const notices: string[] = [];
  const kinds: Array<DecisionKind | undefined> = [];
  return {
    notices,
    kinds,
    notice: (message, decision) => {
      notices.push(message);
      kinds.push(decision);
    },
    kindOf: (message) => kinds[notices.indexOf(message)]
  };
}
