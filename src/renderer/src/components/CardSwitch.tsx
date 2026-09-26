/**
 * One card, drawn from a context: the switch over the card vocabulary that
 * the rail, the docked strips and every float draw from, so a card dragged
 * from one to another stays the same card.
 *
 * Out of `App` (todo 733); what it reads is built by `useCardContext`, and
 * when it is drawn is `useCardRenderers`'. See `mudengine-ui` ›
 * `parts/cards.md`.
 */
import type { ReactNode } from 'react';

import AutomationCard from './AutomationCard';
import BanksCard from './BanksCard';
import type { CardChrome } from './BentoCard';
import CombatCard from './CombatCard';
import ConversationCard from './ConversationCard';
import GangCard from './GangCard';
import HuntingCard from './HuntingCard';
import InventoryCard from './InventoryCard';
import LinkCard from './LinkCard';
import LoopBuilderCard from './LoopBuilderCard';
import MapCard from './MapCard';
import NavigationCard from './NavigationCard';
import NotificationsCard from './NotificationsCard';
import PartyCard from './PartyCard';
import PlayersCard from './PlayersCard';
import QuestCard from './QuestCard';
import RealmCard from './RealmCard';
import ReferenceCard from './ReferenceCard';
import RoomCard from './RoomCard';
import SelfCard from './SelfCard';
import SessionCard from './SessionCard';
import StatsCard from './StatsCard';
import StreamCard from './StreamCard';
import ToolbarCard from './ToolbarCard';
import VitalsCard from './VitalsCard';
import type { CardContext } from '../hooks/useCardContext';
import { hidesWhenEmpty, NO_CARD_SETTINGS, type CardId } from '../lib/cards';
import { ownGang, packRows } from '@shared/character';
import { movementOf } from '@shared/movement';
import { roomAddress } from '@shared/world';

/**
 * Whether a card that *can* be empty holds its place while it is.
 *
 * One test for the five cards that have an "is there anything to say" answer,
 * rather than the five different hard-coded ones they each grew: Party and
 * Navigation took themselves off the rail, Combat did until todo 04, and Gang
 * and Banks never did. `HIDES_WHEN_EMPTY` carries what each one did before as
 * its default, so nothing moved on anybody's rail — what changed is that the
 * other answer is now reachable, from the card's own gear.
 */
function emptyCardHidden(chrome: CardChrome, id: CardId, hasSomethingToSay: boolean): boolean {
  if (hasSomethingToSay) return false;
  return hidesWhenEmpty(chrome.settings?.value ?? NO_CARD_SETTINGS, id);
}

/** The card for an id, drawn from a context. Exhaustive over the vocabulary. */
export function cardElement(id: CardId, ctx: CardContext): ReactNode {
  const { chrome, character, view } = ctx;
  switch (id) {
    case 'self':
      return (
        <SelfCard
          {...chrome}
          character={character}
          // The pack stays readable after a hang-up; wearing from it does not,
          // for the reason the composer below gives.
          gear={ctx.inGame ? ctx.gear : undefined}
          inspect={ctx.inspect}
          loadWearer={ctx.loadWearer}
          profileName={ctx.profileName}
          session={ctx.session}
          /*
            Addressed at `sid` like the gang's list — and null on a pinned
            float only for the *write*: the list is drawn from its own
            character's summary, and a control that wrote the shown
            character's file from another character's card would be the
            failure every addressed field here exists to refuse.
          */
          supplies={ctx.chooseOnMap === null ? null : ctx.supplies}
          suppliesOn={ctx.toolbar.switches.supplies}
        />
      );
    case 'vitals':
      return (
        <VitalsCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          session={ctx.session}
          thresholds={ctx.thresholds}
        />
      );
    case 'room':
      return (
        <RoomCard
          {...chrome}
          ask={ctx.ask}
          locate={ctx.locate}
          character={character}
          session={ctx.session}
          forget={ctx.forget}
          inspect={ctx.inspect}
          learned={view.learned}
          finds={view.finds}
          // Null on a character not shown: the route panel belongs to the one
          // on screen, which is the rule `chooseOnMap` beside it already states.
          goToRoom={ctx.chooseOnMap === null ? null : ctx.goToRoom}
          forgetFind={ctx.forgetFind}
          verdict={view.verdict}
          asks={view.asks}
        />
      );
    case 'map':
      // A map of nowhere states nothing.
      return character.room.map === null ? null : (
        <MapCard
          {...chrome}
          character={character}
          // The realm's find log, not this character's: a room a second
          // character searched is marked here too.
          finds={view.finds}
          load={ctx.loadMap}
          // This character's own route and lap, drawn over its own
          // neighbourhood — a pinned float belongs to somebody else.
          loop={view.loop}
          onBuild={ctx.openBuilder}
          /* A pointer resting on a room opens the realm's answer about it —
             including what its lair spawns, which is the question the glyph has
             raised since the map was drawn. Null on a float, which has no realm
             of its own to ask. */
          onPeek={ctx.peekRoom}
          onPeekEnd={ctx.endPeek}
          walk={view.walk}
        />
      );
    case 'builder':
      /*
       * The shown character's only: it plans on that realm and files into
       * that scope, and a pinned float of it for somebody else would be a
       * map whose every click asked the wrong realm. Nothing is drawn there
       * rather than a card that refuses on every click.
       */
      return ctx.builder === null ? null : (
        <LoopBuilderCard
          {...chrome}
          character={character}
          characterName={ctx.builder.characterName}
          draft={ctx.builder.draft}
          // The realm's find log, as the Map card takes it: where searching has
          // turned something up is a reason to route a lap through a room.
          finds={view.finds}
          loadMap={ctx.builder.loadMap}
          /* The same quick view every other map has — the same panel, the same
             button — so the lair a room is worth picking for says what is in
             it, and the way there is offered where it is offered everywhere. */
          onPeek={ctx.peekRoom}
          onPeekEnd={ctx.endPeek}
          realmName={ctx.builder.realmName}
          save={ctx.builder.save}
          search={ctx.builder.search}
          seed={ctx.builder.seed}
        />
      );
    case 'navigation':
      // An idle walker and an idle loop are not conditions, and a card that
      // always says "nothing" is chrome. One test for both halves, so the card
      // does not appear for one face and vanish for the other — and it is the
      // same test every other emptiable card takes, so it can be turned off.
      if (emptyCardHidden(chrome, id, ctx.navigationVisible)) return null;
      return (
        <NavigationCard
          {...chrome}
          character={character}
          loop={view.loop}
          loops={ctx.loops}
          onChoose={ctx.chooseOnMap}
          onReverseLoop={ctx.reverseLoop}
          onSkipLoop={ctx.skipLoop}
          onStart={ctx.startMoving}
          onStop={ctx.stopMoving}
          walk={view.walk}
        />
      );
    case 'notifications':
      return (
        <NotificationsCard
          {...chrome}
          inspect={ctx.inspect}
          names={ctx.nameIndex}
          notices={view.notices}
          onSelect={ctx.selectPlayer}
          self={character.name}
          session={ctx.session}
        />
      );
    case 'realm':
      return (
        <RealmCard
          {...chrome}
          inGame={ctx.inGame}
          online={character.online}
          onSelect={ctx.selectPlayer}
          self={character.name}
          session={ctx.session}
          subject={ctx.subject}
        />
      );
    case 'players':
      return (
        <PlayersCard
          {...chrome}
          inGame={ctx.inGame}
          onSelect={ctx.selectPlayer}
          players={view.players}
          session={ctx.session}
          subject={ctx.subject}
        />
      );
    case 'gang':
      /*
       * Held whether or not this character is in one, by default: the card
       * carries the `@` permission grid, which is worth reaching whatever the
       * roster last said, and `ownGang` is `undefined` until something has
       * asked. Somebody who only wants it while there is a gang says so on the
       * gear — and a gang is learned from the wire, so that is a card which can
       * come and go on its own.
       */
      if (emptyCardHidden(chrome, id, ownGang(character) != null)) return null;
      return (
        <GangCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          players={view.players}
          onSelect={ctx.selectPlayer}
          onSetGangRemotes={ctx.setGangRemotes}
          onSetGangpath={ctx.setGangpath}
          remotes={ctx.remotes}
          session={ctx.session}
          subject={ctx.subject}
        />
      );
    case 'party':
      // Only while there is one, by default: a card that always says
      // "travelling alone" is chrome, and it sits above the rest of the rail.
      // Somebody who would rather it held its place says so on its gear.
      if (emptyCardHidden(chrome, id, character.party.members.length > 0)) return null;
      return (
        <PartyCard
          {...chrome}
          ask={ctx.ask}
          character={character}
          players={view.players}
          onSelect={ctx.selectPlayer}
          subject={ctx.subject}
          thresholds={ctx.thresholds}
        />
      );
    case 'combat': {
      /*
       * Drawn whether or not there is a fight, unless this character has asked
       * otherwise.
       *
       * It used to be the other way round and unconditionally so: the card
       * arrived when a fight began and left when it ended, which on a busy
       * route is several times a minute — and every card below it on the rail
       * moved each time. That is the churn a fixed card exists to prevent,
       * done to the rail by the rail's own contents, and it made the controls
       * under it a moving target while a fight was the exact thing somebody
       * was reacting to.
       *
       * So the default is *always show* — the card has something true to say
       * either way, and it says `Nothing is fighting you` rather than nothing
       * at all. The other answer is on the card's own gear.
       */
      const fighting = character.inCombat || character.combat.attackers.length > 0;
      if (emptyCardHidden(chrome, id, fighting)) return null;
      return (
        <CombatCard
          {...chrome}
          character={character}
          players={view.players}
          inspect={ctx.inspect}
          onSelect={ctx.selectPlayer}
          verdict={view.verdict}
        />
      );
    }
    case 'inventory':
      return (
        <InventoryCard
          {...chrome}
          character={character}
          gear={ctx.inGame ? ctx.gear : undefined}
          inspect={ctx.inspect}
          loadWearer={ctx.loadWearer}
          session={ctx.session}
        />
      );
    case 'banks':
      /*
       * Unconditional, unlike Party and Combat. Those say nothing at all when
       * the character is alone or idle; this one has something true to say
       * either way — a vault's balance, or that no vault has been asked, which
       * is the answer to "where is my money" for a character who has banked
       * nowhere. It is put away by default instead, so the rail is not spent on
       * it until somebody asks for it — and somebody who wants it on the rail
       * only once a counter has answered says so on its gear.
       */
      if (emptyCardHidden(chrome, id, character.banks.length > 0)) return null;
      return <BanksCard {...chrome} character={character} />;
    case 'quests':
      /*
       * Unconditional, like the vaults: a realm that scripts no quests is a
       * fact the card states, and an empty book is the honest answer for a
       * derivative whose text blocks chain nothing. Put away by default
       * instead, so the rail is not spent on it until somebody asks.
       */
      return (
        <QuestCard
          {...chrome}
          /*
            So the reader's own route through a step is the marked one. The
            long chains state fifteen — a class each, with a different reward —
            and exactly one of them belongs to whoever is reading.
          */
          characterClass={character.className}
          /*
            And its race and level, so the book can sink what this character
            cannot do. The three together are what the realm gates a quest on
            and the client holds a matching fact for; alignment is a number in
            the gate and a word on the roster, so it is left to the side chips.
          */
          characterLevel={character.progress.level}
          characterRace={character.race}
          /*
            And what is in its pack, so a step's shopping list can be ticked.
            `packRows` and not the items themselves: the realm's row is what a
            step names, the join is main's, and null is *nobody has listed the
            pack* — which ticks nothing rather than crossing everything off.
          */
          carrying={packRows(character.inventory)}
          /*
            And where it stands, so an open plan is asked again from wherever
            the character has walked to since it was drawn. Null is unplaced,
            which the plan says as itself.
          */
          here={roomAddress(character.room)}
          /*
            And whether a walk or a lap is moving it, so an open plan holds its
            ground until the walk ends rather than being asked at every room.
          */
          moving={movementOf(view.walk, view.loop).moving}
          /*
            The realm's own count of each quest counter, where the realm has a
            command that prints one. It outranks the marks the player has left
            on the track, which is why it is handed to the card rather than
            merged into them: a mark is a preference on this machine and this
            is a fact about the character.
          */
          counters={character.abilities}
          /*
            And what this character has been *seen* to do this session, which is
            the third reading and sits between the two above: better evidence
            than a mark somebody left by hand, and no evidence at all beside the
            realm's own count. See `stepSaid`.
          */
          said={view.questSaid}
          onGoTo={ctx.chooseOnMap === null ? null : ctx.goToRoom}
          /*
            Addressed like the Reference card's: the panel it opens is the
            *shown* character's, and a step's item and NPC are realm data. On a
            pinned float belonging to a character on another `world.database`
            the name would be resolved against the wrong realm, so it stays
            text there — a control bound to nowhere is worse than none.
          */
          /*
            And the order the step it is on fetches its items in, solved from
            where this character is standing. Addressed for the book's reason
            and priced for this character's — a walk chosen for somebody else
            is one this character may not be able to take.
          */
          loadErrand={ctx.loadErrand}
          loadPlan={ctx.loadPlan}
          /*
            And the run of that plan (todo 102): pressed on the card, carried
            by main, drawn from the progress main pushes for this character.
          */
          run={view.questRun}
          runPlan={ctx.runPlan}
          stopRun={ctx.stopRun}
          loadQuests={ctx.loadQuests}
          onName={ctx.chooseOnMap === null ? null : ctx.inspect}
          realmAt={ctx.realmAt}
          session={ctx.session}
        />
      );
    case 'hunting':
      /*
       * Unconditional, like the quests: a realm with no lair within reach is a
       * fact the card states. Put away by default; the palette's *Where should
       * I hunt?* brings it out. Addressed like the book, and its two actions
       * are the shown character's only, for `chooseOnMap`'s reason.
       */
      return (
        <HuntingCard
          {...chrome}
          chooseOnMap={ctx.chooseOnMap}
          createLoop={ctx.chooseOnMap === null ? null : ctx.createHunt}
          hereKey={
            character.room.map === null || character.room.number === null
              ? null
              : `${character.room.map}/${character.room.number}`
          }
          loadHunting={ctx.loadHunting}
          runLoop={ctx.chooseOnMap === null ? null : ctx.runHunt}
          session={ctx.session}
        />
      );
    case 'stats':
      /*
       * Unconditional: it has something true to say from the first blow, and
       * *nothing yet* is itself the answer for a character that has not swung.
       * It is put away by default instead, so the rail is not spent on it.
       */
      return (
        <StatsCard
          {...chrome}
          baseline={view.statsBase}
          character={character}
          onReset={ctx.resetStats}
          session={ctx.session}
        />
      );
    case 'reference':
      return (
        <ReferenceCard
          {...chrome}
          level={character.progress.level}
          lookup={ctx.lookupName}
          /*
            Addressed like `lookup` and `onRoom` beside it: the panel it opens
            is the *shown* character's, and this card's whole content is realm
            data. On a pinned float belonging to a character on another
            `world.database`, a monster clicked in `Dropped by` would otherwise
            be resolved against the wrong realm — so it stays text there, which
            is what a control bound to nowhere should be.
          */
          onName={ctx.chooseOnMap === null ? null : ctx.inspect}
          onRoom={ctx.chooseOnMap}
          realm={character.realm}
          supplies={ctx.chooseOnMap === null ? null : ctx.supplies}
        />
      );
    case 'conversation':
      return (
        <ConversationCard
          {...chrome}
          messages={view.talk}
          session={ctx.session}
          // Only while there is somewhere for it to go. A composer on an
          // offline character is a box that silently does nothing, and the
          // backlog is still worth reading without one.
          onSend={ctx.inGame ? ctx.onSend : undefined}
          onMacro={ctx.inGame ? ctx.onMacro : undefined}
          macroQueued={
            view.automation.queue.pending.filter((intent) => intent.typed === true).length
          }
          onDropMacro={ctx.dropMacro}
          onSelect={ctx.selectPlayer}
          // The `original` layout quotes the realm's whole sentence, so the
          // names in it are found the way the Alerts card finds them — through
          // the console's own index, so the two cannot disagree about what is
          // a name.
          inspect={ctx.inspect}
          names={ctx.nameIndex}
          character={character}
          players={view.players}
        />
      );
    case 'session':
      return <SessionCard {...chrome} meter={ctx.meter} size={ctx.size} state={view.state} />;
    case 'link':
      return (
        <LinkCard
          {...chrome}
          events={view.telnet}
          negotiated={view.state.negotiated}
          quiet={ctx.quiet}
        />
      );
    case 'toolbar':
      return (
        <ToolbarCard
          {...chrome}
          onPinButton={ctx.pinToolbarButton}
          pinnedButtons={ctx.toolbarPinned}
          subject={ctx.toolbar}
        />
      );
    case 'automation':
      return <AutomationCard {...chrome} automation={view.automation} />;
    case 'stream':
      return <StreamCard {...chrome} lines={view.lines} quiet={ctx.quiet} />;
    default: {
      /*
       * Exhaustive, and a compile error if it stops being.
       *
       * A card id in the vocabulary with no case here would render nothing,
       * for ever, while still appearing in the picker and the palette as
       * something to add — a control that does nothing and says nothing.
       * The same shape as a guard field the parser does not know and a
       * block type nothing produces; this one the type system can catch.
       */
      const unreachable: never = id;
      return unreachable;
    }
  }
}
