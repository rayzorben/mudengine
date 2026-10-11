import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type AppConfig } from '../config';
import { configuredSecrets, secretIn, SECRET_MIN_LENGTH } from '../secrets';

const withPassword = (password: string): AppConfig => ({
  ...DEFAULT_CONFIG,
  connection: {
    ...DEFAULT_CONFIG.connection,
    login: { ...DEFAULT_CONFIG.connection.login, password }
  }
});

describe('configured passwords', () => {
  it('collects each distinct password once, under its first owner, and skips the short ones', () => {
    const short = 'x'.repeat(SECRET_MIN_LENGTH - 1);
    const secrets = configuredSecrets([
      { owner: 'Festus', config: withPassword('hunter22') },
      { owner: 'Rayzor', config: withPassword('hunter22') },
      { owner: 'Vaelor', config: withPassword(short) },
      { owner: 'options', config: DEFAULT_CONFIG }
    ]);
    expect(secrets).toEqual([{ owner: 'Festus', value: 'hunter22' }]);
  });

  it('finds one anywhere in a text and says whose it is', () => {
    const secrets = [{ owner: 'Festus', value: 'hunter22' }];
    expect(secretIn('sent hunter22 at the prompt', secrets)).toEqual(secrets[0]);
    expect(secretIn('sent •••••••• at the prompt', secrets)).toBeNull();
  });
});
