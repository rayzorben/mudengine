import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The run of a quest plan, as a banner over the console (2026-09-22): three
 * halves in three files, each read out of its own source. Why each is so is
 * `mudengine-ui` › quests, *the run is a banner*.
 */
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** One CSS rule's body, by its selector line. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const body = css.slice(at);
  return body.slice(0, body.indexOf('}'));
}

describe('the quest run banner', () => {
  const terminal = read('src/renderer/src/components/SessionTerminal.tsx');
  const banner = read('src/renderer/src/components/QuestRunBanner.tsx');
  const css = read('src/renderer/src/styles/index.css');

  it('is drawn inside the pane it reports on, before the terminal', () => {
    const layer = terminal.indexOf('className="terminal-layer"');
    const drawn = terminal.indexOf('<QuestRunBanner');
    const view = terminal.indexOf('<TerminalView');
    expect(layer).toBeGreaterThan(-1);
    expect(drawn).toBeGreaterThan(layer);
    expect(view).toBeGreaterThan(drawn);
  });

  it('floats over the pane rather than taking rows from it, and is not blurred', () => {
    expect(rule(css, '.terminal-layer')).toContain('position: relative');
    const surface = rule(css, '.quest-banner');
    expect(surface).toContain('position: absolute');
    expect(surface).toContain('backdrop-filter: saturate');
    expect(surface).not.toContain('--glass-blur');
  });

  it('wears the three words, with now the loudest and done ticked and quiet', () => {
    expect(banner).toContain('data-progress={step.state}');
    expect(
      rule(css, ".quest-banner-steps > li[data-progress='now'] > .quest-banner-node")
    ).toContain('var(--accent)');
    expect(
      rule(css, ".quest-banner-steps > li[data-progress='done'] > .quest-banner-name")
    ).toContain('var(--text-lo-quiet)');
    expect(banner).toContain('step.state === \'done\' ? <Icon name="check"');
  });

  it('centres the walk count on the connector and draws it over the line (todo 02)', () => {
    const count = rule(css, '.quest-banner-walk');
    expect(count).toContain('left: 0;');
    expect(count).toContain('transform: translate(-50%, -50%)');
    expect(count).toContain('top: calc(var(--quest-node) / 2)');
    expect(count).toContain('z-index: 1');
    expect(count).toContain('background:');
    expect(count).not.toMatch(/(top|left|right): -?\d*[1-9]/);
    expect(rule(css, '.quest-banner-steps > li + li::before')).toContain(
      'top: calc((var(--quest-node) - var(--quest-line)) / 2)'
    );
  });

  it('names the quest and the steps in the words main pushed, as the card does', () => {
    const runner = read('src/main/automation/QuestRunner.ts');
    const card = read('src/renderer/src/components/QuestCard.tsx');
    expect(runner).toContain('words: this.wordsOf(step)');
    expect(runner).toContain('name: run.quest.name');
    expect(banner).toContain('{step.words}');
    expect(banner).toContain('{run.name');
    expect(card).toContain('{step.words}');
    expect(card).not.toContain('planAct(');
  });

  it('gives its clipped text the ascender slack every ellipsised box carries', () => {
    const slack = css.slice(css.indexOf(':is(\n  .progression .step-name'));
    const listed = slack.slice(0, slack.indexOf(') {'));
    for (const box of ['.quest-banner-title', '.quest-banner-detail', '.quest-banner-name']) {
      expect(listed).toContain(box);
    }
  });

  it('takes an ended run down by what it says, on a named clock or the ×, and never by object', () => {
    expect(banner).toContain(
      "if (run.status === 'idle' || (ended && endingOf(run) === down)) return null;"
    );
    expect(banner).toContain('tuning().questRunLingerMs');
    expect(banner).not.toContain('run === dismissed');
  });
});
