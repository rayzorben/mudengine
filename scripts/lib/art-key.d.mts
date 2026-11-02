type Env = Record<string, string | undefined>;

export function secretFile(env?: Env): string;
export function artSecret(env?: Env): string | null;
export function artKeyId(env?: Env): string;
