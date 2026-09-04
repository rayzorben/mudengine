import type { IpcApi } from '../shared/ipc';

declare global {
  interface Window {
    mudengine: IpcApi;
  }
}

export {};
