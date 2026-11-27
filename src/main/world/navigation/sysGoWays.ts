/**
 * A realm's `sys go` towns as portals the router relaxes from the room each
 * search starts in (`Traveller.sysGo`, `shared/sysGo.ts`). See
 * `mudengine-world` › `parts/routing.md` › *A `sys go` town is a way*.
 */
import type { PortalExit } from '../RoomIndex';
import { roomId, type RoomId } from '../../../shared/world';
import type { SysGoWay } from '../../../shared/sysGo';

export class SysGoWays {
  /** Built once per table, which is a constant per family. */
  private readonly built = new WeakMap<readonly SysGoWay[], readonly PortalExit[]>();

  constructor(private readonly holds: (room: RoomId) => boolean) {}

  /**
   * Each town as a `Text:` way whose phrase is the command, so the step says
   * it and the walk hints the landing as any portal's. A town outside the
   * dataset is no way.
   */
  of(ways: readonly SysGoWay[] | undefined): readonly PortalExit[] {
    if (ways === undefined || ways.length === 0) return [];
    let exits = this.built.get(ways);
    if (exits === undefined) {
      exits = ways.flatMap(({ command, map, room }): PortalExit[] =>
        this.holds(roomId(map, room))
          ? [
              {
                direction: 'portal',
                map,
                room,
                requirement: { kind: 'text', raw: `Text: ${command}`, commands: [command] }
              }
            ]
          : []
      );
      this.built.set(ways, exits);
    }
    return exits;
  }
}
