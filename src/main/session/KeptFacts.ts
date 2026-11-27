import type { KeptLives, KeptRoom } from '../../shared/belongings';
import type { SessionId } from '../../shared/ipc';
import type { ConnectionTarget } from '../../shared/types';
import { Belongings, peekLives, peekName, peekRoom } from './Belongings';

/** What the reads need of the client: whose record is open, where the files are, which realm a target plays. */
export interface KeptFactsPorts {
  open(id: SessionId): Belongings | undefined;
  file(id: SessionId): string;
  /** The realm `id` plays at `target`, as `realmName` writes it. */
  realmAt(id: SessionId, target: ConnectionTarget): string;
  /** The server a character's file names, or undefined when it has none. */
  targetOf(id: SessionId): ConnectionTarget | undefined;
}

/**
 * Reads of what a character's record kept, for the realm a target plays. The
 * open record answers when it is that realm's (the file lags it by a deferred
 * write), else the file is read without opening it: a launch has no window yet
 * to hear what an unreadable one says.
 */
export function keptFacts(ports: KeptFactsPorts) {
  function from<T>(
    id: SessionId,
    target: ConnectionTarget,
    live: (open: Belongings) => T,
    peek: (file: string, realm: string) => T
  ): T {
    const realm = ports.realmAt(id, target);
    const open = ports.open(id);
    return open?.realm === realm ? live(open) : peek(ports.file(id), realm);
  }

  function ofPlayedRealm<T>(
    id: SessionId,
    live: (open: Belongings) => T,
    peek: (file: string, realm: string) => T
  ): T | null {
    const target = ports.targetOf(id);
    return target ? from(id, target, live, peek) : null;
  }

  return {
    from,
    /** Where the record last placed the character, so the tab draws the room before any dial. */
    roomFor: (id: SessionId): KeptRoom | null =>
      ofPlayedRealm(id, (open) => open.recallRoom(), peekRoom),
    /** The lives the record last read on the realm at `target`, for the ask before a dial there. */
    livesAt: (id: SessionId, target: ConnectionTarget): KeptLives | null =>
      from(id, target, (open) => open.recallLives(), peekLives),
    /** The name a stat sheet gave. Paradigm's welcome line names the login handle instead. */
    nameFor: (id: SessionId): string | null =>
      ofPlayedRealm(id, (open) => open.recallName(), peekName)
  };
}
