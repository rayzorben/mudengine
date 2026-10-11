import fs from 'node:fs/promises';
import path from 'node:path';

import type { AutomationSnapshot } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import {
  engageText,
  formatDebugReport,
  safetyText,
  shown,
  type DebugRecord,
  type ReportSection
} from '../../shared/debug';
import type { DebugSave } from '../../shared/ipc';
import type { RealmBuild } from '../../shared/realm';
import { secretIn, type Secret } from '../../shared/secrets';
import { t } from '../app/i18n';

/**
 * The bug report, built and written (todo 75). See `mudengine-session` for why
 * main writes it into `logs/`, where `check:secrets` walks.
 *
 * Passwords stay out at the source (`Publisher.reportable`); this checks the
 * finished text against every configured password and writes nothing when one
 * is there, since that is a broken invariant, not something to mask here.
 */
export interface BugReportInputs {
  directory: string;
  /** The file's slug, from the character's name. */
  slug: string;
  header: Parameters<typeof formatDebugReport>[0];
  character: CharacterState;
  automation: AutomationSnapshot;
  /** The realm database's own `Info` row, or null when unknown. */
  build: RealmBuild | null;
  records: readonly DebugRecord[];
  secrets: readonly Secret[];
  /** The host's download link for a written file (web), or null. */
  deliver(file: string): string | null;
}

export async function writeBugReport(inputs: BugReportInputs): Promise<DebugSave> {
  const text = formatDebugReport(inputs.header, inputs.records, reportSections(inputs));
  const found = secretIn(text, inputs.secrets);
  // By whose file it is, never by value, so the player knows which to change.
  if (found !== null) return { error: t('app.debug.secretFound', { owner: found.owner }) };
  const stamp = new Date(inputs.header.at).toISOString().replace(/[:.]/g, '-');
  const file = path.join(inputs.directory, `debug-${inputs.slug}-${stamp}.txt`);
  await fs.mkdir(inputs.directory, { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return { path: file, download: inputs.deliver(file) };
}

/** What holds now, ahead of the trace. Exported for the test. */
export function reportSections(
  inputs: Pick<BugReportInputs, 'character' | 'automation' | 'build'>
): ReportSection[] {
  const { character: c, automation, build } = inputs;
  const at = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
  return [
    {
      title: t('app.debug.section.character'),
      lines: [
        `phase      ${c.phase}`,
        `name       ${shown(c.name)} (${shown(c.race)} ${shown(c.className)})`,
        `level      ${shown(c.progress.level)}, exp ${shown(c.progress.exp)}`,
        `hp         ${shown(c.vitals.hp)} / ${shown(c.vitals.hpMax)}`,
        `mana       ${shown(c.vitals.mana)} / ${shown(c.vitals.manaMax)}`,
        `room       ${shown(c.room.name)} (${shown(c.room.map)}/${shown(c.room.number)}, ` +
          `${shown(c.room.resolvedBy)} ${Math.round(c.room.confidence * 100)}%, ` +
          `${c.room.candidates.length} candidates)`,
        `in combat  ${c.inCombat}`,
        `automation ${automation.enabled ? 'on' : 'off'}`
      ]
    },
    {
      title: t('app.debug.section.safety'),
      lines: automation.safety.map((d) => `${at(d.at)} ${safetyText(d)}`)
    },
    {
      title: t('app.debug.section.engagements'),
      lines: automation.engagements.map((d) => `${at(d.at)} ${engageText(d)}`)
    },
    {
      title: t('app.debug.section.realmData'),
      lines:
        build === null
          ? [t('app.debug.realmDataUnknown')]
          : [
              `custom     ${shown(build.custom)}`,
              `data       ${shown(build.data)}`,
              `date       ${shown(build.date)} ${shown(build.time)}`
            ]
    }
  ];
}
