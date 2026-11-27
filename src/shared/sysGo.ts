import type { RealmFamily } from './character';

/**
 * The towns a realm's `sys go <word>` puts a player in, from wherever they
 * stand. Stock MajorMUD has four (the user, 2026-11-27); the sil, khaz and
 * lost landings are on OCI's wire (`2026-11-22_03-18-14_soul.log:970,993,1047`),
 * rhud only the user's word. GreaterMUD's `sys go` is a mudop's goto by map
 * and room (`SysCommand.cs` `GotoCommand`), so it has none, and Paradigm's is
 * unmeasured. The router takes one from the room each search starts in when
 * `automation.movement.sysGo` is on (`Traveller.sysGo`).
 */
export interface SysGoWay {
  /** What is typed, in full. */
  command: string;
  map: number;
  room: number;
}

/** Each family's ways; empty where the realm has none or none is measured. */
export const SYS_GO_WAYS: Record<RealmFamily, readonly SysGoWay[]> = {
  majormud: [
    { command: 'sys go sil', map: 1, room: 2189 },
    { command: 'sys go khaz', map: 6, room: 1249 },
    { command: 'sys go lost', map: 16, room: 426 },
    { command: 'sys go rhud', map: 2, room: 2519 }
  ],
  greatermud: [],
  paradigm: []
};

/** The ways a walk may take on this realm with the switch at `on`; none while the family is unread. */
export function sysGoWaysOf(family: RealmFamily | null, on: boolean): readonly SysGoWay[] {
  return on && family !== null ? SYS_GO_WAYS[family] : [];
}
