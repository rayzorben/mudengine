/**
 * The help page's content (todo 75): what the client is for, how to make a
 * character, what each card is, what automation does unasked, how to report a
 * bug. Every word is in `locales/ui.en.yaml` under `help:`; the settings stay
 * explained where they are edited, never here (`docs/terminology.md`).
 */
import { AUTOMATION_SWITCH_NAMES, DEFAULT_CONFIG, readAutomationSwitch } from '@shared/config';
import { CLIENT_KEYS } from '@shared/keys';

import { cardLabel, CARDS, type CardId } from './cards';
import { t } from './i18n';
import { clientChord } from './platform';
import { switchLabel } from './toolbar';

export interface HelpSection {
  id: 'about' | 'character' | 'cards' | 'automation' | 'report';
  title: string;
  paragraphs: string[];
  /** Label and sentence pairs, drawn as a list under the paragraphs. */
  rows: { label: string; text: string }[];
}

/**
 * One sentence per card, by an exhaustive switch over the card ids, so a card
 * added to `CARDS` with no sentence here does not compile.
 */
function cardSentence(id: CardId): string {
  switch (id) {
    case 'toolbar':
      return t('help.cards.toolbar');
    case 'self':
      return t('help.cards.self');
    case 'vitals':
      return t('help.cards.vitals');
    case 'combat':
      return t('help.cards.combat');
    case 'room':
      return t('help.cards.room');
    case 'map':
      return t('help.cards.map');
    case 'builder':
      return t('help.cards.builder');
    case 'navigation':
      return t('help.cards.navigation');
    case 'party':
      return t('help.cards.party');
    case 'notifications':
      return t('help.cards.alerts');
    case 'realm':
      return t('help.cards.realm');
    case 'players':
      return t('help.cards.players');
    case 'gang':
      return t('help.cards.gang');
    case 'inventory':
      return t('help.cards.inventory');
    case 'banks':
      return t('help.cards.banks');
    case 'shops':
      return t('help.cards.shops');
    case 'quests':
      return t('help.cards.quests');
    case 'hunting':
      return t('help.cards.hunting');
    case 'gear':
      return t('help.cards.gear');
    case 'conversation':
      return t('help.cards.talk');
    case 'reference':
      return t('help.cards.reference');
    case 'stats':
      return t('help.cards.stats');
    case 'extension':
      return t('help.cards.extension');
    case 'session':
      return t('help.cards.session');
    case 'link':
      return t('help.cards.link');
    case 'automation':
      return t('help.cards.automation');
    case 'stream':
      return t('help.cards.stream');
    default: {
      const unreachable: never = id;
      return unreachable;
    }
  }
}

/**
 * The switches a new character starts with on, read from the defaults so the
 * page cannot disagree with them, by the toolbar's own labels.
 */
function switchesOnByDefault(): string[] {
  return AUTOMATION_SWITCH_NAMES.filter(
    (name) => name !== 'automation' && readAutomationSwitch(DEFAULT_CONFIG.automation, name)
  ).map(switchLabel);
}

export function helpSections(): HelpSection[] {
  return [
    {
      id: 'about',
      title: t('help.about.title'),
      paragraphs: [
        t('help.about.what'),
        t('help.about.palette', { palette: clientChord(CLIENT_KEYS.palette) })
      ],
      rows: []
    },
    {
      id: 'character',
      title: t('help.character.title'),
      paragraphs: [
        t('help.character.make', { settings: clientChord(CLIENT_KEYS.settings) }),
        t('help.character.files')
      ],
      rows: []
    },
    {
      id: 'cards',
      title: t('help.cards.title'),
      paragraphs: [t('help.cards.arrange')],
      rows: CARDS.map((card) => ({ label: cardLabel(card.id), text: cardSentence(card.id) }))
    },
    {
      id: 'automation',
      title: t('help.automation.title'),
      paragraphs: [
        t('help.automation.master', { automation: switchLabel('automation') }),
        t('help.automation.onByDefault', { switches: switchesOnByDefault().join(', ') }),
        t('help.automation.stop', { hangUp: clientChord(CLIENT_KEYS.hangUp) }),
        t('help.automation.refusals')
      ],
      rows: []
    },
    {
      id: 'report',
      title: t('help.report.title'),
      paragraphs: [
        t('help.report.how', { palette: clientChord(CLIENT_KEYS.palette) }),
        t('help.report.what'),
        t('help.report.passwords')
      ],
      rows: []
    }
  ];
}
