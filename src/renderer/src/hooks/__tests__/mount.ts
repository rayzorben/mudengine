import type { ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/**
 * A hook's probe component, mounted on the first `render` and re-rendered in
 * place after, each inside `act`, so a hook test sees one component live
 * through the renders a case steps it through. `unmount` in an `afterEach`.
 */
export interface Mount {
  render(element: ReactElement): void;
  /** The mounted tree, for a component test to find what it drew. */
  root(): ReactTestInstance;
  unmount(): void;
}

export function mount(): Mount {
  // React warns on every `act` outside a test environment that says it is one.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | null = null;
  return {
    render(element) {
      const live = renderer;
      if (live === null) {
        act(() => {
          renderer = create(element);
        });
      } else {
        act(() => live.update(element));
      }
    },
    root() {
      if (renderer === null) throw new Error('nothing is mounted');
      return renderer.root;
    },
    unmount() {
      const live = renderer;
      renderer = null;
      if (live !== null) act(() => live.unmount());
    }
  };
}
