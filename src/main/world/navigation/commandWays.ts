/**
 * A room command as the ways it opens (`WorldGraph.linkPortals`): one portal
 * to the room every try lands in, or one per chance landing, each carrying
 * the tries it is expected to take, a ship's passage's wait, and what a try can break
 * or passing takes (format 73). The command's own conditions and a roll
 * line's are one list, judged as any exit's are (`exitGates`). A room's own
 * spell is a way too (format 77), waited out standing in the room.
 */
import { tuning } from '../../app/tuning';
import {
  roomId,
  type CommandDraw,
  type CommandLanding,
  type Corridor,
  type Landing,
  type Requirement,
  type RoomCommand,
  type RoomId,
  type WorldRoom
} from '../../../shared/world';

export interface CommandWay {
  to: RoomId;
  requirement: Requirement;
}

export function commandWays(
  command: RoomCommand,
  corridor: (to: RoomId) => Corridor | null
): CommandWay[] {
  const phrase = command.say[0]?.trim();
  if (!phrase) return [];
  const way = (
    to: RoomId,
    landing?: Pick<CommandLanding, 'chance' | 'draw' | 'gates' | 'waits'>,
    drawn?: Landing
  ): CommandWay => {
    const gates = [...(command.gates ?? []), ...(landing?.gates ?? [])];
    const passage = corridor(to);
    const tries = landing === undefined ? 1 : 1 / (landing.draw ?? landing.chance);
    // A `Text:` exit in everything but the table it came from: a different command.
    const requirement: Requirement = {
      kind: 'text',
      raw: phrase,
      commands: [...command.say],
      ...(gates.length === 0 ? {} : { gates }),
      ...(passage === null ? {} : { corridor: passage }),
      ...(tries > 1 ? { tries } : {}),
      ...(landing?.waits === undefined ? {} : { waits: landing.waits }),
      ...(command.breaks === undefined ? {} : { breaks: command.breaks }),
      ...(command.takes === undefined ? {} : { takes: command.takes }),
      ...(command.asks === undefined ? {} : { asks: command.asks }),
      // A draw is planned to, never through, as a scatter exit is (`Router.scatterCosts`).
      ...(drawn === undefined ? {} : { spellEffect: 'scatters' as const, landing: drawn })
    };
    return { to, requirement };
  };
  if (command.to !== undefined) return [way(command.to)];
  return [
    ...(command.landings ?? []).map((landing) => way(landing.to, landing)),
    ...(command.draws ?? []).map((draw) =>
      way(roomId(draw.landing.map, draw.landing.low), draw, draw.landing)
    )
  ];
}

/**
 * A room's own spell as the ways it opens (format 77): one portal per landing
 * or draw, waited out where the character stands (`room-spell`) for the
 * ticks it is expected to take, behind its line's gates. A way slower than
 * `world.spellWayTicks` is a hazard nobody waits for, and opens nothing.
 */
export function spellWays(room: WorldRoom): CommandWay[] {
  const ways = room.spellWays;
  if (ways === undefined || room.spell === undefined) return [];
  const here = roomId(room.map, room.room);
  const most = tuning().world.spellWayTicks;
  const way = (
    to: RoomId,
    landing: Pick<CommandLanding, 'chance' | 'draw' | 'gates'>,
    drawn?: CommandDraw['landing']
  ): CommandWay[] => {
    const ticks = Math.ceil(1 / (landing.draw ?? landing.chance));
    if (ticks > most) return [];
    const requirement: Requirement = {
      kind: 'room-spell',
      raw: `Spell: ${room.spell}`,
      waits: { in: [here], ticks },
      ...(landing.gates === undefined ? {} : { gates: landing.gates }),
      ...(drawn === undefined ? {} : { spellEffect: 'scatters' as const, landing: drawn })
    };
    return [{ to, requirement }];
  };
  return [
    ...(ways.landings ?? []).flatMap((landing) => way(landing.to, landing)),
    ...(ways.draws ?? []).flatMap((draw) =>
      way(roomId(draw.landing.map, draw.landing.low), draw, draw.landing)
    )
  ];
}

/** Every way a room's commands and its own spell open (`WorldGraph.linkPortals`). */
export function roomWays(
  room: WorldRoom,
  corridor: (command: RoomCommand, to: RoomId) => Corridor | null
): CommandWay[] {
  return [
    ...(room.commands ?? []).flatMap((command) =>
      commandWays(command, (to) => corridor(command, to))
    ),
    ...spellWays(room)
  ];
}
