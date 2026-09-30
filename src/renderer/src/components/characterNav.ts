/**
 * The character page's rail: each section's name and the fieldsets inside it,
 * in the order `CHARACTER_SECTIONS` lists them. Beside the form rather than in
 * it, since the rail and the search headings read it and the form only names.
 */
import type { NavFieldset, NavSection } from './SettingsNav';

import { t } from '../lib/i18n';
import { CHARACTER_SECTIONS, type CharacterSection } from '../lib/characterForm';

export const CHARACTER_SECTION_LABEL: Record<CharacterSection, string> = {
  profile: t('settings.sections.character'),
  login: t('settings.sections.login'),
  combat: t('settings.tabs.combat'),
  health: t('settings.tabs.health'),
  spells: t('settings.tabs.spells'),
  party: t('settings.tabs.party'),
  movement: t('settings.tabs.movement'),
  gear: t('settings.tabs.gear'),
  train: t('settings.tabs.train'),
  quests: t('settings.tabs.quests'),
  remotes: t('settings.tabs.remotes'),
  talk: t('settings.tabs.talk'),
  alerts: t('settings.tabs.alerts'),
  rewrites: t('settings.tabs.rewrites')
};

/**
 * The fieldsets inside each section, as the rail's jump targets (todo 02).
 *
 * Written down rather than read off the DOM: a fieldset drawn only when a
 * switch is on (Combat's three) would come and go from a list built by
 * counting, and the rail would then scroll to whichever fieldset happened to
 * be third today. Each `id` matches the `data-fieldset` on the fieldset
 * itself, which is the whole of the contract between the two.
 *
 * A section with one fieldset lists none: the section's own row already goes
 * there, and a single child under it would be the same press written twice.
 * `profile` has no fieldsets at all: its fields sit directly in the section.
 */
const SECTION_FIELDSETS: Record<CharacterSection, readonly NavFieldset[]> = {
  profile: [],
  login: [{ id: 'login', label: t('settings.login.legend') }],
  combat: [
    { id: 'combat-attack', label: t('settings.combat.attackLegend') },
    { id: 'combat-attacks', label: t('settings.combat.attacksLegend') },
    { id: 'combat-monsters', label: t('settings.combat.monstersLegend') },
    { id: 'combat-mob-rules', label: t('settings.combat.mobRuleLegend') }
  ],
  health: [
    { id: 'health-recover', label: t('settings.health.recoverLegend') },
    { id: 'health-retreat', label: t('settings.health.retreatLegend') },
    { id: 'health-hangup', label: t('settings.health.hangUpLegend') },
    { id: 'health-potions', label: t('settings.health.potionRuleLegend') }
  ],
  spells: [
    { id: 'spells-round', label: t('settings.spells.legend') },
    { id: 'spells-drain', label: t('settings.spells.drainLegend') },
    { id: 'spells-heal', label: t('settings.spells.healLegend') },
    { id: 'spells-cures', label: t('settings.spells.cureLegend') },
    { id: 'spells-blessings', label: t('settings.spells.blessingsLegend') }
  ],
  party: [
    { id: 'party-follow', label: t('settings.party.legend') },
    { id: 'party-healing', label: t('settings.party.healLegend') },
    { id: 'party-remotes', label: t('settings.party.remotesLegend') }
  ],
  movement: [
    { id: 'movement-doors', label: t('settings.movement.doorsLegend') },
    { id: 'movement-stealth', label: t('settings.movement.stealthLegend') },
    { id: 'movement-light', label: t('settings.movement.lightLegend') },
    { id: 'movement-afflictions', label: t('settings.movement.afflictionsLegend') },
    { id: 'movement-keep-out', label: t('settings.movement.keepOutLegend') },
    { id: 'movement-carry', label: t('settings.movement.carryLegend') },
    { id: 'hunting', label: t('settings.hunting.legend') }
  ],
  gear: [
    { id: 'gear', label: t('settings.gear.legend') },
    { id: 'gear-offround', label: t('settings.gear.offRoundLegend') }
  ],
  train: [{ id: 'train', label: t('settings.train.legend') }],
  quests: [{ id: 'quests', label: t('settings.quests.legend') }],
  remotes: [{ id: 'remotes', label: t('settings.remotes.legend') }],
  talk: [
    { id: 'talk', label: t('settings.talk.legend') },
    { id: 'talk-pvp', label: t('settings.health.pvpLegend') }
  ],
  alerts: [
    { id: 'alerts-rules', label: t('settings.alerts.ruleLegend') },
    { id: 'alerts-afk', label: t('settings.afk.legend') }
  ],
  rewrites: [{ id: 'rewrites-statline', label: t('settings.statline.legend') }]
};

/** The rail's rows for the character page, in the order the form draws them. */
export const CHARACTER_NAV: readonly NavSection[] = CHARACTER_SECTIONS.map((id) => ({
  id,
  label: CHARACTER_SECTION_LABEL[id],
  fieldsets: SECTION_FIELDSETS[id]
}));
