/**
 * Everything the realm knows about one room, for a room nobody is standing in.
 *
 * `CharacterTracker` resolves the shop, the lair, the script and the spell onto
 * the room the character *is* in, and every card reads them from the character
 * it was handed. A room on the map or on a route list gets none of that — a
 * `MapCell` carries a name, its exits and two booleans — so the lair glyph
 * raised the question *what is in there* and nothing could answer it.
 *
 * One query per room, resolved here where the realm's tables are, rather than
 * a cell fattened with every lair on the map: a fetch draws two hundred rooms
 * and a reader asks about one of them.
 *
 * See `mudengine-world` › *The realm data answers before the server is asked*.
 */
import type { RealmFamily } from '../../shared/realm';
import type { RoomBrief, RoomBriefExit, RoomId } from '../../shared/world';
import { describeObstacle } from './obstacle';
import type { WorldGraph } from './WorldGraph';

/**
 * `family` is the one thing here that is not the realm file's: it decides the
 * lair's respawn clock, whose only interpretation outside the column is
 * GreaterMUD's own offset. See `WorldGraph.lair`.
 */
export function roomBrief(
  graph: WorldGraph,
  id: RoomId,
  family: RealmFamily | null,
  /**
   * The reader's own level, so a room spell the realm gates on level is
   * described as it applies to them (todo 01): the desert's sandstorm is
   * `maxlevel 19`, and the panel said *it moves you somewhere else* to a
   * level 21 character on 979 rooms. Null keeps the whole hazard.
   */
  level?: number | null
): RoomBrief | null {
  const room = graph.byId(id);
  if (!room) return null;

  const exits: RoomBriefExit[] = room.exits.map((exit) => {
    /*
     * Where the exit *goes*. An exit whose cast teleports puts the character
     * in the spell's room and never in the table's, and this list is hovered
     * beside a route panel that walks it to the spell's — two surfaces
     * disagreeing about one corridor. A draw keeps the table's room, and the
     * chip beside it says it is a draw (`describeObstacle`), because there is
     * no single room to name.
     */
    const to = graph.beyond(exit);
    // A destination the realm does not hold is a hole in the data: the way out
    // is still real and still worth listing, and it is listed without a name
    // rather than with a fabricated one.
    const destination = graph.byId(to);
    return {
      direction: exit.direction,
      to,
      ...(destination === undefined ? {} : { name: destination.name }),
      ...(exit.requirement === null
        ? {}
        : {
            // The word that opens it, where the room itself holds one: this is
            // what a player reads *while standing here*, so it is the last
            // surface that should still be saying `Door, pick/bash 1000`.
            obstacle: describeObstacle(
              exit.requirement,
              graph,
              graph.leversHere(id, exit.direction)
            )
          })
    };
  });

  const brief: RoomBrief = { id, name: room.name, exits };

  /*
   * The place, by kind and name — never its stock. A shop's inventory is a
   * table of its own on the Room card, and a panel that opened beside a room
   * on the map to say what lives in the lair is not where somebody prices a
   * flask.
   */
  const shop = room.shop === undefined ? undefined : graph.shop(room.shop);
  if (shop !== undefined) brief.place = { kind: shop.kind ?? 'shop', name: shop.name };

  const lair = graph.lair(room, family);
  if (lair !== null) brief.lair = lair;

  const npc = room.npcId === undefined ? undefined : graph.mobById(room.npcId);
  if (npc !== undefined && room.npcId !== undefined) brief.npc = { id: room.npcId, name: npc.name };

  const spell = room.spell === undefined ? null : graph.spellById(room.spell);
  if (spell !== null) brief.spell = spell;
  /*
   * And what it does. The name alone does not answer the question — `river
   * damage` and `inn rest` are the same column, and the realm states which is
   * which. The items that stop it are named here, where the item table is.
   */
  const hazard = graph.hazardOf(room, level);
  if (hazard !== null) {
    brief.hazard = hazard;
    const named = (hazard.avoidedBy ?? []).flatMap((id) => {
      const item = graph.item(id);
      return item === undefined ? [] : [{ id, name: item.name }];
    });
    if (named.length > 0) brief.hazardItems = named;
  }

  if (room.light !== undefined) brief.light = room.light;
  if (room.commands !== undefined && room.commands.length > 0) brief.commands = room.commands;

  /*
   * What the realm furnishes the room with — format 42. Named here, where the
   * item table is; a number the table lacks is one the server skips too.
   */
  const placed = (room.placed ?? []).flatMap((item) => {
    const known = graph.item(item);
    if (known === undefined) return [];
    return [
      { id: item, name: known.name, ...(known.gettable === false ? { fixed: true as const } : {}) }
    ];
  });
  if (placed.length > 0) brief.placed = placed;

  return brief;
}
