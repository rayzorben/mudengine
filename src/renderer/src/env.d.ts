/// <reference types="vite/client" />
import type { IpcApi, WireApi } from '@shared/ipc';

declare global {
  interface Window {
    mudengine: IpcApi;
    /** The preload's bridge, on the desktop only; `main.tsx` makes `mudengine` of it. */
    mudengineWire?: WireApi;
  }
}

export {};
