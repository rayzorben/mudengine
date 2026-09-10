/**
 * The listings the player has the console draw itself, on both settings
 * pages: the status line's designer first, then one designer per kind with
 * its templates and the listing as it will be drawn — by the same renderers
 * the console uses, against sample facts, so the preview and the console
 * cannot disagree. `mudengine-ui` § The console is rewritten in one grammar.
 */
import { CheckField, SelectField, TextField } from './FormField';
import StatlineDesigner from './StatlineDesigner';
import { MARK_GLYPH } from './marks';
import { t } from '../lib/i18n';
import type { RewritesUiConfig } from '@shared/config';
import type { ItemEntity } from '@shared/entities';
import { equipVerdict, type Wearer } from '@shared/gear';
import {
  REWRITE_KINDS,
  REWRITE_SPECS,
  renderExperience,
  renderInventory,
  renderParty,
  renderShop,
  renderWho,
  tagsOf,
  type RewriteDesign,
  type RewriteKind,
  type Rewritten
} from '@shared/rewrites';
import type { StatlineFigures } from '@shared/statline';
import { isAnsiColour, type Drawn, type PlacedGlyph, type Segment } from '@shared/template';
import type { TerminalPalette } from '@shared/themes';
import { quotedInCopper } from '@shared/coins';

export interface RewritesDesignerProps {
  value: RewritesUiConfig;
  onChange(next: RewritesUiConfig): void;
  palette: TerminalPalette;
  /** The character's own figures for the prompt row's preview, or null for the sample. */
  figures: StatlineFigures | null;
  /** The stem every control's name is built from, so two pages never share an id. */
  idPrefix: string;
}

export default function RewritesDesigner({
  value,
  onChange,
  palette,
  figures,
  idPrefix
}: RewritesDesignerProps): React.JSX.Element {
  return (
    <>
      <StatlineDesigner
        figures={figures}
        idPrefix={idPrefix}
        onChange={(statline) => onChange({ ...value, statline })}
        palette={palette}
        value={value.statline}
      />
      <p className="settings-note">{t('settings.rewrites.note')}</p>
      {REWRITE_KINDS.map((kind) => (
        <RewriteDesigner
          bands={value.statline.bands}
          idPrefix={`${idPrefix}-${kind}`}
          key={kind}
          kind={kind}
          onChange={(design) => onChange({ ...value, [kind]: design })}
          palette={palette}
          value={value[kind]}
        />
      ))}
    </>
  );
}

/* Literal calls, one per kind and per line, so the dictionary's coverage test reads them. */
const KIND_LEGEND: Record<RewriteKind, string> = {
  inventory: t('settings.rewrites.inventory.legend'),
  who: t('settings.rewrites.who.legend'),
  shop: t('settings.rewrites.shop.legend'),
  party: t('settings.rewrites.party.legend'),
  experience: t('settings.rewrites.experience.legend')
};
const LINE_LABEL: Record<string, string> = {
  row: t('settings.rewrites.lines.row'),
  keys: t('settings.rewrites.lines.keys'),
  wealth: t('settings.rewrites.lines.wealth'),
  load: t('settings.rewrites.lines.load'),
  head: t('settings.rewrites.lines.head'),
  line: t('settings.rewrites.lines.line')
};
const STYLE_OPTIONS = [
  { value: 'table', label: t('settings.rewrites.styleTable') },
  { value: 'lines', label: t('settings.rewrites.styleLines') }
];

function RewriteDesigner({
  kind,
  value,
  onChange,
  palette,
  bands,
  idPrefix
}: {
  kind: RewriteKind;
  value: RewriteDesign;
  onChange(next: RewriteDesign): void;
  palette: TerminalPalette;
  bands: RewritesUiConfig['statline']['bands'];
  idPrefix: string;
}): React.JSX.Element {
  const spec = REWRITE_SPECS[kind];
  const tabular = spec.lines.some((line) => line.repeated);
  const drawn = sample(kind, value, bands);
  return (
    <fieldset className="settings-menus">
      <legend>{KIND_LEGEND[kind]}</legend>
      <div className="settings-inline">
        <CheckField
          checked={value.enabled}
          hint={t('settings.rewrites.enabledHint')}
          label={t('settings.rewrites.enabledLabel')}
          name={`${idPrefix}-enabled`}
          onChange={(enabled) => onChange({ ...value, enabled })}
        />
        {tabular && (
          <SelectField
            hint={t('settings.rewrites.styleHint')}
            label={t('settings.rewrites.styleLabel')}
            name={`${idPrefix}-style`}
            onChange={(style) => {
              if (style === 'table' || style === 'lines') onChange({ ...value, style });
            }}
            options={STYLE_OPTIONS}
            value={value.style}
          />
        )}
        {tabular && value.style === 'table' && (
          <CheckField
            checked={value.header}
            hint={t('settings.rewrites.headerHint')}
            label={t('settings.rewrites.headerLabel')}
            name={`${idPrefix}-header`}
            onChange={(header) => onChange({ ...value, header })}
          />
        )}
      </div>
      {spec.lines.map((line) => (
        <TextField
          hint={t('settings.rewrites.lineHint', { tags: tagsOf(kind, line.key).join(' ') })}
          key={line.key}
          label={LINE_LABEL[line.key] ?? line.key}
          name={`${idPrefix}-${line.key}`}
          onChange={(template) =>
            onChange({ ...value, lines: { ...value.lines, [line.key]: template } })
          }
          spellCheck={false}
          value={value.lines[line.key] ?? ''}
          wide
        />
      ))}
      <span className="settings-label">{t('settings.rewrites.previewLabel')}</span>
      <Preview drawn={drawn} palette={palette} />
    </fieldset>
  );
}

/* ───────────────────────────────────────────────── the sample listing */

const SAMPLE_WEARER: Wearer = {
  classId: 2,
  raceId: 1,
  level: 12,
  strength: 60,
  classNames: { 1: 'Warrior', 2: 'Mystic' },
  raceNames: { 1: 'Human' }
};

function sampleItem(
  name: string,
  realm: Partial<ItemEntity>,
  wire: { slot?: string; equipped?: boolean; charges?: number; count?: number } = {}
): ItemEntity {
  return {
    name,
    source: realm.id === undefined ? 'wire' : 'hybrid',
    slot: wire.slot ?? null,
    equipped: wire.equipped ?? false,
    charges: wire.charges ?? null,
    ...(wire.count === undefined ? {} : { count: wire.count }),
    ...realm
  };
}

const SAMPLE_PACK: ItemEntity[] = [
  sampleItem(
    'visored greathelm',
    { id: 1, encumbrance: 120, kind: 'armour', realmSlot: 'Head', armour: { ac: 4, dr: 1 } },
    { slot: 'Head', equipped: true }
  ),
  sampleItem(
    'shimmering longsword',
    {
      id: 2,
      encumbrance: 200,
      kind: 'weapon',
      realmSlot: 'Weapon Hand',
      weapon: { min: 4, max: 13 }
    },
    { slot: 'Weapon Hand', equipped: true }
  ),
  sampleItem('golden battleaxe', {
    id: 3,
    encumbrance: 400,
    kind: 'weapon',
    realmSlot: 'Weapon Hand',
    weapon: { min: 8, max: 20 },
    classes: [1]
  }),
  sampleItem('padded gloves', {
    id: 4,
    encumbrance: 40,
    kind: 'armour',
    realmSlot: 'Hands',
    armour: { ac: 1, dr: 0 }
  }),
  sampleItem(
    'torch',
    { id: 5, encumbrance: 30, kind: 'light', realmSlot: 'Readied' },
    { count: 6 }
  ),
  sampleItem('token of Silvermere', {})
];

function sample(
  kind: RewriteKind,
  design: RewriteDesign,
  bands: RewritesUiConfig['statline']['bands']
): Rewritten {
  switch (kind) {
    case 'inventory':
      return renderInventory(
        design,
        {
          items: SAMPLE_PACK.map((item) => ({
            item,
            verdict: equipVerdict(item, SAMPLE_WEARER, t)
          })),
          keys: ['bone key'],
          coins: { gold: 2, silver: 3, copper: 50 },
          wealth: 2350,
          encumbrance: 1744,
          encumbranceMax: 4128,
          encumbranceWord: 'Medium'
        },
        t
      );
    case 'who':
      return renderWho(
        design,
        [
          {
            name: 'Vaelor',
            title: 'Kai Warrior',
            alignment: 'Good',
            gang: 'Mudengine',
            flags: 'S'
          },
          { name: 'Rand', title: 'Apprentice', alignment: null, gang: 'Mudengine', flags: null },
          { name: 'Beaver IzCoo', title: 'Squire', alignment: 'Seedy', gang: null, flags: null }
        ],
        t
      );
    case 'shop': {
      const rows = [
        ['padded gloves', 3, '12 silver crowns', SAMPLE_PACK[3]!],
        ['golden battleaxe', 1, '18 gold crowns', SAMPLE_PACK[2]!],
        ['torch', 20, '5 copper farthings', SAMPLE_PACK[4]!]
      ] as const;
      return renderShop(
        design,
        rows.map(([name, quantity, price, item]) => ({
          name,
          quantity,
          price,
          cost: quotedInCopper(price),
          note: null,
          item,
          verdict: equipVerdict(item, SAMPLE_WEARER, t)
        })),
        2350,
        t
      );
    }
    case 'party':
      return renderParty(
        design,
        [
          {
            name: 'Vaelor',
            class: 'Mystic',
            health: 92,
            mana: 40,
            rank: 'Frontrank',
            flag: null,
            invited: false
          },
          {
            name: 'Soul',
            class: 'Warrior',
            health: 35,
            mana: null,
            rank: 'Backrank',
            flag: 'R',
            invited: false
          }
        ],
        bands,
        t
      );
    case 'experience':
      return renderExperience(design, {
        gained: 25,
        exp: 1386695,
        need: 14377,
        level: 12,
        expSession: 12525
      });
  }
}

/* ────────────────────────────────────────────────────────── the preview */

type Piece =
  { kind: 'text'; segment: Segment; text: string } | { kind: 'glyph'; glyph: PlacedGlyph };

/**
 * A drawn line as pieces to render: its runs, with each glyph's two blank
 * cells replaced by the glyph itself. Walked cell by cell, because the
 * blanks may have merged into the run before them.
 */
function piecesOf(line: Drawn): Piece[] {
  const pieces: Piece[] = [];
  const glyphs = [...line.glyphs].sort((a, b) => a.x - b.x);
  let cells = 0;
  let next = 0;
  for (const segment of line.segments) {
    let text = '';
    const chars = [...segment.text];
    for (let i = 0; i < chars.length; i += 1) {
      const glyph = glyphs[next];
      if (glyph !== undefined && glyph.x === cells && chars[i] === ' ' && chars[i + 1] === ' ') {
        if (text.length > 0) pieces.push({ kind: 'text', segment, text });
        text = '';
        pieces.push({ kind: 'glyph', glyph });
        next += 1;
        cells += 2;
        i += 1;
        continue;
      }
      text += chars[i];
      cells += 1;
    }
    if (text.length > 0) pieces.push({ kind: 'text', segment, text });
  }
  return pieces;
}

function Preview({
  drawn,
  palette
}: {
  drawn: Rewritten;
  palette: TerminalPalette;
}): React.JSX.Element {
  const colourOf = (colour: string | null): string | undefined =>
    colour === null ? undefined : isAnsiColour(colour) ? palette[colour] : colour;
  return (
    <output
      className="rewrite-preview"
      style={{ background: palette.background, color: palette.foreground }}
    >
      {drawn.lines.length === 0
        ? t('settings.rewrites.previewEmpty')
        : drawn.lines.map((line, row) => (
            <div key={row}>
              {piecesOf(line).map((piece, index) =>
                piece.kind === 'glyph' ? (
                  <span
                    aria-label={piece.glyph.label}
                    className="rewrite-glyph"
                    dangerouslySetInnerHTML={{ __html: MARK_GLYPH[piece.glyph.icon] }}
                    data-mark={piece.glyph.icon}
                    key={index}
                    role="img"
                    title={piece.glyph.label}
                  />
                ) : (
                  <span
                    key={index}
                    style={{
                      background: colourOf(piece.segment.bg),
                      color: colourOf(piece.segment.fg),
                      fontWeight: piece.segment.bold ? 700 : undefined,
                      opacity: piece.segment.dim ? 0.6 : undefined
                    }}
                  >
                    {piece.text}
                  </span>
                )
              )}
            </div>
          ))}
    </output>
  );
}
