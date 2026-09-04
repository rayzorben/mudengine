import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

import { reconcileWithTemplate } from '../reconcile';

let dir: string;
let file: string;
let template: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-reconcile-'));
  file = path.join(dir, 'default.yaml');
  template = path.join(dir, 'template.yaml');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE = `# The options template.

# What the client keeps about itself.
terminal:
  size: 16

# Added in a later version than the file below.
logging:
  # Blank is the client's own logs directory.
  directory: ''
`;

describe('bringing an options file up to the template', () => {
  it('adds a block the file predates, with the comments that explain it', () => {
    fs.writeFileSync(template, TEMPLATE);
    fs.writeFileSync(file, '# Mine.\nterminal:\n  size: 22\n');

    const result = reconcileWithTemplate(file, template);

    expect(result).toEqual({ added: ['logging'], error: null });
    const text = fs.readFileSync(file, 'utf8');
    // The template *is* the documentation, so a block arrives with its prose.
    expect(text).toContain("Blank is the client's own logs directory.");
    expect(parse(text)).toEqual({ terminal: { size: 22 }, logging: { directory: '' } });
  });

  it('leaves a block that is already there alone, however old its value', () => {
    fs.writeFileSync(template, TEMPLATE);
    fs.writeFileSync(file, 'terminal:\n  size: 22\nlogging:\n  directory: /var/log/mud\n');

    expect(reconcileWithTemplate(file, template)).toEqual({ added: [], error: null });
    expect(parse(fs.readFileSync(file, 'utf8')).logging.directory).toBe('/var/log/mud');
  });

  it('does nothing the second time, so a launch is not a rewrite', () => {
    fs.writeFileSync(template, TEMPLATE);
    fs.writeFileSync(file, 'terminal:\n  size: 22\n');

    expect(reconcileWithTemplate(file, template).added).toEqual(['logging']);
    const after = fs.readFileSync(file, 'utf8');
    expect(reconcileWithTemplate(file, template).added).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(after);
  });

  it('refuses a file that does not parse rather than rebuilding it', () => {
    // Somebody's only copy of their own notes and credentials, halfway through
    // an edit. Filling in what "looks missing" would throw the rest away.
    const broken = 'terminal:\n  size: 22\n  : :\n';
    fs.writeFileSync(template, TEMPLATE);
    fs.writeFileSync(file, broken);

    expect(reconcileWithTemplate(file, template).added).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });

  it('says nothing about a file that is not there yet', () => {
    // First run: the template is copied whole, so there is no gap to close.
    fs.writeFileSync(template, TEMPLATE);
    expect(reconcileWithTemplate(file, template)).toEqual({ added: [], error: null });
  });
});
