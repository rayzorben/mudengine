/**
 * A wheel read as whole steps through a list: rolled away is `-1`, towards
 * the reader `1`, one step per notch (`WHEEL_NOTCH`) however the deltas come.
 * Where `can` says the list ends that way, the wheel is left alone so the
 * card under the pointer scrolls. React's wheel listener is passive, so this
 * is a native one.
 */
import { useEffect, useRef, type RefObject } from 'react';

import { WHEEL_NOTCH } from '../lib/wheel';

export type WheelStep = 1 | -1;

export interface WheelStepper {
  can(by: WheelStep): boolean;
  take(by: WheelStep): void;
}

export function useWheelStep(
  target: RefObject<HTMLElement | null>,
  stepper: WheelStepper | null
): void {
  const latest = useRef(stepper);
  latest.current = stepper;
  useEffect(() => {
    const node = target.current;
    if (node === null) return undefined;
    let rolled = 0;
    const onWheel = (event: WheelEvent): void => {
      const current = latest.current;
      if (current === null || event.deltaY === 0) return;
      const by: WheelStep = event.deltaY > 0 ? 1 : -1;
      if (!current.can(by)) return;
      event.preventDefault();
      if (Math.sign(rolled) !== by) rolled = 0;
      rolled += event.deltaY;
      if (Math.abs(rolled) < WHEEL_NOTCH) return;
      rolled = 0;
      current.take(by);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [target]);
}
