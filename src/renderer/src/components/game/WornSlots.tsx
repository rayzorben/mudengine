/**
 * The paper doll (todo 20261018-2032-01): the body in five coloured regions,
 * a square per worn slot round it, each with a line to where it is worn, in
 * its region's colour. Once the art server has drawn the character, the
 * drawing takes the body's place and the lines run dotted to it (todo
 * 20261019-0931-01); a press on it shows it whole. The layout is
 * `lib/paperDoll.ts`; what fills a square is `lib/wornSlots.ts`.
 */
import { memo, useMemo } from 'react';

import type { RealmFamily } from '@shared/character';
import { t } from '../../lib/i18n';
import { pictureOf, type ItemArtIndex } from '../../lib/itemArt';
import {
  DOLL_BOX as BOX,
  DOLL_GEOMETRY,
  DOLL_REGIONS,
  DRAWING_BOX,
  DRAWING_GEOMETRY,
  layoutDoll,
  type DollRegion
} from '../../lib/paperDoll';
import type { WornSlots as Worn } from '../../lib/wornSlots';
import ItemPicture from './ItemPicture';

const REGION_LABEL: Record<DollRegion, string> = {
  head: t('game.sheet.region.head'),
  torso: t('game.sheet.region.torso'),
  arms: t('game.sheet.region.arms'),
  held: t('game.sheet.region.held'),
  lower: t('game.sheet.region.lower')
};

/** The body, 200 x 400, each part in its region. */
function Figure() {
  return (
    <g>
      <ellipse cx="71" cy="44" data-region="head" rx="6" ry="10" />
      <ellipse cx="129" cy="44" data-region="head" rx="6" ry="10" />
      <circle cx="100" cy="42" data-region="head" r="28" />
      <path d="M88 70 h24 v14 h-24z" data-region="torso" />
      <path d="M58 88 Q100 76 142 88 L150 192 Q100 204 50 192 Z" data-region="torso" />
      <path d="M56 92 L30 170 L24 222 L38 224 L50 176 L70 120 Z" data-region="arms" />
      <path d="M144 92 L170 170 L176 222 L162 224 L150 176 L130 120 Z" data-region="arms" />
      <circle cx="30" cy="234" data-region="held" r="11" />
      <circle cx="170" cy="234" data-region="held" r="11" />
      <path d="M52 196 Q100 210 148 196 L150 218 Q100 230 50 218 Z" data-region="lower" />
      <path d="M56 222 L96 226 L92 330 L88 378 L64 378 L62 330 Z" data-region="lower" />
      <path d="M144 222 L104 226 L108 330 L112 378 L136 378 L138 330 Z" data-region="lower" />
      <path d="M60 378 h30 l4 14 h-40 z" data-region="lower" />
      <path d="M110 378 h30 l10 14 h-40 z" data-region="lower" />
    </g>
  );
}

function WornSlots({
  worn,
  art,
  realm,
  drawing,
  name,
  onOpen
}: {
  /** Null until the pack is listed: every square is unknown. */
  worn: Worn | null;
  art: ItemArtIndex | null;
  realm: RealmFamily | null;
  /** The art server's drawing of the character, or null for the doll's own body. */
  drawing: string | null;
  /** Whose drawing, for its alt text. */
  name: string;
  /** The drawing pressed: shown whole. */
  onOpen(): void;
}) {
  const geometry = drawing === null ? DOLL_GEOMETRY : DRAWING_GEOMETRY;
  const placed = useMemo(() => layoutDoll(geometry), [geometry]);
  const { figure } = geometry;
  return (
    <div className="gv-doll">
      <div className="gv-doll-legend">
        {DOLL_REGIONS.map((region) => (
          <span data-region={region} key={region}>
            <i />
            {REGION_LABEL[region]}
          </span>
        ))}
      </div>
      <div
        className="gv-doll-box"
        data-drawn={drawing === null ? undefined : 'true'}
        style={{ width: BOX.width, height: BOX.height }}
      >
        {drawing !== null && (
          <img
            alt={name}
            className="gv-doll-drawing"
            draggable={false}
            onClick={onOpen}
            src={drawing}
            style={{ left: DRAWING_BOX.left, top: DRAWING_BOX.top, height: DRAWING_BOX.height }}
          />
        )}
        <svg
          aria-hidden="true"
          height={BOX.height}
          viewBox={`0 0 ${BOX.width} ${BOX.height}`}
          width={BOX.width}
        >
          {drawing === null && (
            <g
              className="gv-doll-figure"
              transform={`translate(${figure.x} ${figure.y}) scale(${figure.scale})`}
            >
              <Figure />
            </g>
          )}
          {placed.map((slot) => (
            <g data-region={slot.region} key={slot.id}>
              <path
                className="gv-doll-line"
                d={`M${slot.line[0][0]} ${slot.line[0][1]} L${slot.line[1][0]} ${slot.line[1][1]}`}
              />
              <circle className="gv-doll-dot" cx={slot.line[1][0]} cy={slot.line[1][1]} r="2.6" />
            </g>
          ))}
        </svg>
        {placed.map((slot) => {
          const item = worn?.bySlot.get(slot.id) ?? null;
          const state = worn === null ? 'unknown' : item === null ? 'empty' : 'worn';
          return (
            <div
              className="gv-slot"
              data-region={slot.region}
              data-state={state}
              key={slot.id}
              style={{ left: slot.x, top: slot.y, width: geometry.size, height: geometry.size }}
              title={item === null ? slot.word : `${item.name} (${slot.word})`}
            >
              {item !== null && (
                <ItemPicture
                  name={item.name}
                  src={art === null ? null : pictureOf(art, realm, item)}
                />
              )}
              {state === 'unknown' && <span className="gv-slot-unknown">?</span>}
              <span className="gv-slot-word">{slot.word}</span>
            </div>
          );
        })}
      </div>
      {worn !== null && worn.elsewhere.length > 0 && (
        <p className="gv-quiet gv-doll-elsewhere">
          {t('game.sheet.elsewhere', { items: worn.elsewhere.map((item) => item.name).join(', ') })}
        </p>
      )}
    </div>
  );
}

export default memo(WornSlots);
