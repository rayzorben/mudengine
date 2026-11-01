/**
 * A name's first letter on a tinted disc, the way a chat client marks who is
 * speaking: the people in the Talk card's backlog. Decorative beside the name,
 * which is always drawn or given as its `title`. See `mudengine-ui` ›
 * `parts/viz.md`.
 */
import { memo } from 'react';

function Initial({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="initial">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export default memo(Initial);
