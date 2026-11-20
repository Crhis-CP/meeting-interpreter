import type { FromAudio, RendererApi, ToAudio } from '../shared/ipc';

declare global {
  interface Window {
    api: RendererApi;
    platform: string;
    audioBridge: {
      send(msg: FromAudio): void;
      onMessage(fn: (msg: ToAudio) => void): void;
    };
  }
}

export {};
