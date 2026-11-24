import type { WantedItem } from '@shared/world';

/**
 * *Acquire item*: go and get this item, for one character. Declared here
 * because the palette's rows (`lib/`) and the item card's button share it.
 */
export type AcquireItem = (item: WantedItem) => void;
