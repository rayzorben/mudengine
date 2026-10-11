import type { BuildStamp } from '../../src/shared/build';

export const COMMIT_LENGTH: number;
export function buildStamp(root: string): BuildStamp & { builtAt: string };
