import { errorMessage } from '../../../shared/values';

/** The runtime's own complaint, so an expected notice is built as the code builds it. */
export function complaint(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error('expected the call to throw');
}
