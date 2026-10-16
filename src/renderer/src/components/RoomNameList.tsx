/**
 * The player's own room names, `rooms:` (todo 153), on the Global page: a row
 * per entry in `PotionList`'s idiom, the code, name and room on one line and
 * MegaMUD's marks under them, with the reason under a row the client does
 * not load. Read through the one parser the client loads them with
 * (`roomNameFaults`), so the page and the file agree. See `mudengine-settings`
 * › `parts/pages.md`.
 */
import Icon from './Icon';
import { t } from '../lib/i18n';
import {
  level,
  roomNameFaults,
  roomNameFaultText,
  type StatedRoomName
} from '@shared/roomNicknames';

export interface RoomNameListProps {
  rows: readonly StatedRoomName[];
  onChange(rows: StatedRoomName[]): void;
  /** Distinguishes the controls for the harnesses. */
  namePrefix: string;
}

const BLANK: StatedRoomName = {
  code: '',
  name: '',
  room: '',
  stopBefore: false,
  avoid: false,
  hidden: false,
  minLevel: null,
  maxLevel: null
};

/** A level as typed, read by the rule the file is read by: blank or anything else is none. */
const levelOf = (text: string): number | null => level(Number.parseInt(text, 10));

export default function RoomNameList({ rows, onChange, namePrefix }: RoomNameListProps) {
  const update = (index: number, change: Partial<StatedRoomName>): void =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  const faults = roomNameFaults(rows);

  return (
    <div className="settings-list">
      {rows.length > 0 && (
        <ul className="settings-steps settings-pairs settings-room-names">
          {rows.map((row, index) => {
            const number = index + 1;
            const fault = faults.get(index);
            const name = `${namePrefix}-room-${index}`;
            return (
              // Keyed by position, as the login rows are: a row is edited in place.
              <li data-refused={fault !== undefined} key={index}>
                <div className="blessing-line">
                  <input
                    aria-label={t('settings.rooms.codeAria', { number })}
                    className="answer"
                    name={`${name}-code`}
                    onChange={(event) => update(index, { code: event.target.value })}
                    placeholder={t('settings.rooms.codePlaceholder')}
                    spellCheck={false}
                    value={row.code}
                  />
                  <input
                    aria-label={t('settings.rooms.nameAria', { number })}
                    name={`${name}-name`}
                    onChange={(event) => update(index, { name: event.target.value })}
                    placeholder={t('settings.rooms.namePlaceholder')}
                    value={row.name}
                  />
                  <input
                    aria-label={t('settings.rooms.roomAria', { number })}
                    name={`${name}-room`}
                    onChange={(event) => update(index, { room: event.target.value })}
                    placeholder={t('settings.rooms.roomPlaceholder')}
                    spellCheck={false}
                    value={row.room}
                  />
                  <button
                    aria-label={t('settings.rooms.removeAria', { number })}
                    className="quiet"
                    onClick={() => onChange(rows.filter((_, at) => at !== index))}
                    title={t('settings.rooms.removeAria', { number })}
                    type="button"
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className="blessing-line blessing-detail">
                  <label>
                    <input
                      checked={row.stopBefore}
                      name={`${name}-stop`}
                      onChange={(event) => update(index, { stopBefore: event.target.checked })}
                      type="checkbox"
                    />
                    <span>{t('settings.rooms.stopBefore')}</span>
                  </label>
                  <label>
                    <input
                      checked={row.avoid}
                      name={`${name}-avoid`}
                      onChange={(event) => update(index, { avoid: event.target.checked })}
                      type="checkbox"
                    />
                    <span>{t('settings.rooms.avoid')}</span>
                  </label>
                  <label>
                    <span>{t('settings.rooms.levels')}</span>
                    <input
                      aria-label={t('settings.rooms.minLevelAria', { number })}
                      className="level"
                      inputMode="numeric"
                      name={`${name}-min`}
                      onChange={(event) => update(index, { minLevel: levelOf(event.target.value) })}
                      value={row.minLevel ?? ''}
                    />
                    <span aria-hidden="true">-</span>
                    <input
                      aria-label={t('settings.rooms.maxLevelAria', { number })}
                      className="level"
                      inputMode="numeric"
                      name={`${name}-max`}
                      onChange={(event) => update(index, { maxLevel: levelOf(event.target.value) })}
                      value={row.maxLevel ?? ''}
                    />
                  </label>
                </div>
                {fault !== undefined && (
                  <span className="pair-refusal">{roomNameFaultText(fault, t)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button className="quiet add-step" onClick={() => onChange([...rows, BLANK])} type="button">
        <Icon name="plus" />
        <span>{t('settings.rooms.add')}</span>
      </button>
    </div>
  );
}
