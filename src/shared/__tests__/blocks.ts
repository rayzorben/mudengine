import { domainOf, type Block, type BlockType } from '../blocks';

/**
 * A classified line as the classifier would hand it on: its type's own domain,
 * a newline terminator, a text match's confidence. For the tests that drive a
 * reducer or one of its clusters with a block rather than a line.
 */
export function blockOf(
  type: BlockType,
  text: string,
  groups: Record<string, string>,
  at: number
): Block {
  return {
    seq: 0,
    at,
    type,
    domain: domainOf(type),
    groups,
    text,
    terminator: 'newline',
    confidence: 0.8
  };
}
