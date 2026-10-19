/**
 * The game view's bottom bar (todo 140): only the commands that work now, each
 * on its letter key, then the room's exits. A press of the key and a click on
 * the button are the same act (`GameView`'s key layer runs both).
 */
import { memo } from 'react';

import type { Direction } from '@shared/world';
import type { CommandGlyph, GameCommand, GameCommands } from '../../lib/gameCommands';
import { PLACE_PATHS, placeTone } from '../../lib/gameIcons';
import { t } from '../../lib/i18n';
import Icon, { type IconName } from '../Icon';

const GLYPH: Record<CommandGlyph, IconName> = {
  attack: 'sword',
  backstab: 'crosshair',
  sneak: 'eye',
  hide: 'eyeOff',
  look: 'eye',
  rest: 'moon',
  search: 'search',
  get: 'coins',
  party: 'users',
  run: 'run',
  next: 'next',
  character: 'user',
  talk: 'broadcast',
  pack: 'bag'
};

export interface CommandBarProps {
  commands: GameCommands;
  /** The key last pressed, lit for a moment. */
  fired: string | null;
  /** The player's own key for each way, from `keys:`, for the exit's title. */
  bound: Partial<Record<Direction, string>>;
  onCommand(command: GameCommand): void;
  onMove(direction: Direction): void;
}

function Button({
  command,
  fired,
  compact,
  onCommand
}: {
  command: GameCommand;
  fired: boolean;
  /** Key and icon only, the word in its title: the group about the character, where room is short. */
  compact: boolean;
  onCommand(command: GameCommand): void;
}) {
  return (
    <button
      className="gv-command"
      data-fired={fired ? 'true' : undefined}
      data-main={command.main === true ? 'true' : undefined}
      onClick={() => onCommand(command)}
      title={compact ? command.label : undefined}
      type="button"
    >
      <kbd>{command.key}</kbd>
      {command.place ? (
        <svg aria-hidden="true" data-tone={placeTone(command.place)} viewBox="0 0 24 24">
          <path d={PLACE_PATHS[command.place]} fillRule="evenodd" />
        </svg>
      ) : command.glyph === null ? null : (
        <Icon name={GLYPH[command.glyph]} />
      )}
      {compact ? null : command.label}
      {command.badge === undefined ? null : <b className="gv-badge">{command.badge}</b>}
    </button>
  );
}

function CommandBar({ commands, fired, bound, onCommand, onMove }: CommandBarProps) {
  const group = (list: readonly GameCommand[], compact = false) =>
    list.length === 0 ? null : (
      <div className="gv-group">
        {list.map((command) => (
          <Button
            compact={compact}
            command={command}
            fired={fired === command.key}
            key={command.key}
            onCommand={onCommand}
          />
        ))}
      </div>
    );
  return (
    <nav aria-label={t('game.commands.aria')} className="gv-hud gv-commands">
      <div className="gv-glass gv-pill">
        {group(commands.fight)}
        {group(commands.here)}
        {commands.exits.length > 0 && (
          <div className="gv-group">
            <span className="gv-quiet">{t('game.commands.move')}</span>
            {commands.exits.map((exit) => (
              <button
                className="gv-move"
                data-door={exit.blocked ? 'true' : undefined}
                key={exit.direction}
                onClick={() => onMove(exit.direction)}
                title={[
                  exit.name ?? exit.direction,
                  exit.direction.length === 2
                    ? t('game.commands.diagonal', {
                        first: exit.direction[0]!,
                        second: exit.direction[1]!
                      })
                    : null,
                  bound[exit.direction] === undefined
                    ? null
                    : t('game.commands.bound', { key: bound[exit.direction]! })
                ]
                  .filter((one) => one !== null)
                  .join(' · ')}
                type="button"
              >
                {exit.direction}
              </button>
            ))}
          </div>
        )}
        {group(commands.you, true)}
      </div>
    </nav>
  );
}

export default memo(CommandBar);
