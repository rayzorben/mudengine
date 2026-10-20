/**
 * The pictures on the game view tutorial's pages: the arena, the command bar,
 * the compass keys, the console, the panels and a fight, each drawn from the
 * view's own pieces (`.gv-command`, `kbd`, the `--game-*` tokens) so the page
 * looks like what it explains. Decorative; the page's words say the same.
 */
import { memo, type ReactNode } from 'react';

import { GAME_KEYS } from '../../lib/gameCommands';
import { t } from '../../lib/i18n';
import Icon, { type IconName } from '../Icon';

export type TutorialScene = 'map' | 'keys' | 'moving' | 'console' | 'panels' | 'fight';

/** A key as its cap reads. */
function keyCap(key: string): string {
  return key === GAME_KEYS.back ? 'Esc' : key;
}

function Cap({ k, big }: { k: string; big?: true }) {
  return <kbd data-big={big ? 'true' : undefined}>{keyCap(k)}</kbd>;
}

/** The arena on the map: rooms around, the circle with its exits, you and a monster. */
function MapScene() {
  const rooms: ReadonlyArray<readonly [number, number]> = [
    [160, 8],
    [262, 95],
    [160, 178],
    [58, 95],
    [262, 20],
    [58, 170],
    [300, 150]
  ];
  return (
    <svg className="gvt-svg" viewBox="0 0 320 190">
      <path
        className="gvt-link"
        d="M160 8V43M212 95H262M160 147V178M108 95H58M262 20V95M58 95V170M262 95L300 150"
      />
      {rooms.map(([x, y]) => (
        <rect
          className="gvt-room"
          height="16"
          key={`${x}/${y}`}
          rx="4"
          width="16"
          x={x - 8}
          y={y - 8}
        />
      ))}
      <circle className="gvt-arena" cx="160" cy="95" r="52" />
      {(
        [
          ['n', 160, 43],
          ['e', 212, 95],
          ['s', 160, 147],
          ['w', 108, 95]
        ] as const
      ).map(([way, x, y]) => (
        <g key={way}>
          <circle className="gvt-exit" cx={x} cy={y} r="9" />
          <text className="gvt-exit-text" x={x} y={y + 3.5}>
            {way}
          </text>
        </g>
      ))}
      <circle className="gvt-you" cx="150" cy="98" r="13" />
      <text className="gvt-you-text" x="150" y="102">
        {t('game.arena.you').slice(0, 1)}
      </text>
      <circle className="gvt-foe" cx="182" cy="104" r="8" />
      <circle
        className="gvt-gauge"
        cx="182"
        cy="104"
        pathLength="100"
        r="11"
        strokeDasharray="70 30"
      />
      <rect className="gvt-pill" height="18" rx="9" width="112" x="104" y="20" />
      <text className="gvt-pill-text" x="160" y="32.5">
        {t('game.tutorial.sample.room')}
      </text>
    </svg>
  );
}

const BAR: ReadonlyArray<{ key: string; icon: IconName; label: string; main?: true }> = [
  {
    key: GAME_KEYS.attack,
    icon: 'sword',
    label: t('game.commands.attack', { name: t('game.tutorial.sample.monster') }),
    main: true
  },
  { key: GAME_KEYS.sneak, icon: 'eye', label: t('game.commands.sneak') },
  { key: GAME_KEYS.hide, icon: 'eyeOff', label: t('game.commands.hide') },
  { key: GAME_KEYS.search, icon: 'search', label: t('game.commands.search') }
];

/** One press, one line sent, and the bar that offers it. */
function KeysScene() {
  return (
    <div className="gvt-keys">
      <div className="gvt-sent">
        <Cap big k={GAME_KEYS.attack} />
        <span className="gvt-arrow" />
        <code>{`a ${t('game.tutorial.sample.monster')}`}</code>
        <span className="gv-quiet">{t('game.tutorial.keys.sent')}</span>
      </div>
      <div className="gv-glass gv-pill gvt-bar">
        {BAR.map((one) => (
          <span className="gv-command" data-main={one.main ? 'true' : undefined} key={one.key}>
            <Cap k={one.key} />
            <Icon name={one.icon} />
            {one.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The compass on the keys: four ways, the diagonals as two presses, up and down. */
function MovingScene() {
  const diagonal = (first: string, second: string) => (
    <span className="gvt-diagonal" title={t('game.tutorial.moving.diagonal', { first, second })}>
      <Cap k={first} />
      <Cap k={second} />
    </span>
  );
  return (
    <div className="gvt-moving">
      <div className="gvt-compass">
        {diagonal('n', 'w')}
        <Cap big k="n" />
        {diagonal('n', 'e')}
        <Cap big k="w" />
        <span className="gvt-compass-you" />
        <Cap big k="e" />
        {diagonal('s', 'w')}
        <Cap big k="s" />
        {diagonal('s', 'e')}
      </div>
      <div className="gvt-updown">
        <Cap big k="u" />
        <Cap big k="d" />
      </div>
      <p className="gvt-aside">
        <Icon name="route" />
        {t('game.tutorial.moving.click')}
      </p>
    </div>
  );
}

/** A small window: the map, and the console docked along its bottom. */
function ConsoleScene() {
  return (
    <div className="gvt-console">
      <div className="gvt-window">
        <svg className="gvt-svg" viewBox="0 0 240 90">
          <path className="gvt-link" d="M40 30H120V60H200M120 30V10" />
          <circle className="gvt-arena" cx="120" cy="45" r="22" />
          <circle className="gvt-you" cx="120" cy="45" r="6" />
        </svg>
        <div className="gvt-dock">
          <span>{t('game.tutorial.sample.exits')}</span>
          <span>{t('game.tutorial.sample.statline')}</span>
        </div>
      </div>
      <dl className="gvt-legend">
        <dt>
          <Cap big k={GAME_KEYS.console} />
        </dt>
        <dd>{t('game.tutorial.console.open')}</dd>
        <dt>
          <Cap big k={GAME_KEYS.back} />
        </dt>
        <dd>{t('game.tutorial.console.shut')}</dd>
      </dl>
    </div>
  );
}

const PANELS: ReadonlyArray<{ key: string; icon: IconName; label: string; what: string }> = [
  {
    key: GAME_KEYS.character,
    icon: 'user',
    label: t('game.commands.character'),
    what: t('game.tutorial.panels.character')
  },
  {
    key: GAME_KEYS.pack,
    icon: 'bag',
    label: t('game.commands.pack'),
    what: t('game.tutorial.panels.pack')
  },
  {
    key: GAME_KEYS.talk,
    icon: 'broadcast',
    label: t('game.commands.talk'),
    what: t('game.tutorial.panels.talk')
  },
  {
    key: GAME_KEYS.party,
    icon: 'users',
    label: t('game.commands.party'),
    what: t('game.tutorial.panels.party')
  }
];

function PanelsScene() {
  return (
    <div className="gvt-tiles">
      {PANELS.map((one) => (
        <div className="gvt-tile" key={one.key}>
          <Icon name={one.icon} />
          <b>
            <Cap k={one.key} /> {one.label}
          </b>
          <span className="gv-quiet">{one.what}</span>
        </div>
      ))}
    </div>
  );
}

const FIGHT_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: GAME_KEYS.attack, label: t('game.tutorial.fight.attack') },
  { key: GAME_KEYS.next, label: t('game.tutorial.fight.next') },
  { key: GAME_KEYS.backstab, label: t('game.tutorial.fight.backstab') },
  { key: GAME_KEYS.run, label: t('game.tutorial.fight.run') }
];

/** The round's glow, the target large with its gauge, two more behind. */
function FightScene() {
  return (
    <div className="gvt-fight">
      <svg className="gvt-svg" viewBox="0 0 200 150">
        <circle className="gvt-ring-wait" cx="100" cy="75" r="64" />
        <circle
          className="gvt-ring-sweep"
          cx="100"
          cy="75"
          pathLength="100"
          r="64"
          strokeDasharray="62 38"
          transform="rotate(-90 100 75)"
        />
        <circle className="gvt-arena" cx="100" cy="75" r="56" />
        <circle className="gvt-you" cx="72" cy="80" r="11" />
        <circle className="gvt-foe" cx="120" cy="74" r="17" />
        <circle
          className="gvt-gauge"
          cx="120"
          cy="74"
          pathLength="100"
          r="21"
          strokeDasharray="55 45"
          transform="rotate(90 120 74)"
        />
        <circle className="gvt-foe" cx="136" cy="48" r="7" />
        <circle className="gvt-foe" cx="138" cy="102" r="7" />
      </svg>
      <dl className="gvt-legend">
        {FIGHT_KEYS.map((one) => (
          <FightKey key={one.key} k={one.key} label={one.label} />
        ))}
      </dl>
    </div>
  );
}

function FightKey({ k, label }: { k: string; label: string }) {
  return (
    <>
      <dt>
        <Cap k={k} />
      </dt>
      <dd>{label}</dd>
    </>
  );
}

const SCENES: Record<TutorialScene, () => ReactNode> = {
  map: MapScene,
  keys: KeysScene,
  moving: MovingScene,
  console: ConsoleScene,
  panels: PanelsScene,
  fight: FightScene
};

function TutorialScenes({ scene }: { scene: TutorialScene }) {
  const Scene = SCENES[scene];
  return (
    <div aria-hidden="true" className="gvt-scene" data-scene={scene}>
      <Scene />
    </div>
  );
}

export default memo(TutorialScenes);
