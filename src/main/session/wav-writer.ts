import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { int16ToBytes } from '../../core/audio/pcm';
import { wavHeader } from '../../core/audio/wav';

/**
 * Streams 16-bit mono PCM to a WAV file. The header's sizes are rewritten on every flush, so the
 * file stays playable even if the app crashes mid-meeting.
 */
export class WavFileWriter {
  private fd: number | null;
  private bytes = 0;
  private sinceHeader = 0;

  constructor(
    readonly path: string,
    private readonly sampleRate: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
    writeSync(this.fd, wavHeader(0, sampleRate, 1), 0, 44, 0);
  }

  get seconds(): number {
    return this.bytes / 2 / this.sampleRate;
  }

  write(samples: Int16Array): void {
    if (this.fd === null || !samples.length) return;
    const data = int16ToBytes(samples);
    writeSync(this.fd, data, 0, data.length, 44 + this.bytes);
    this.bytes += data.length;
    this.sinceHeader += data.length;
    // Refresh the header about once a second of audio.
    if (this.sinceHeader >= this.sampleRate * 2) this.flushHeader();
  }

  /** Pads with silence up to `seconds` (keeps tracks aligned to the meeting clock). */
  padTo(seconds: number): void {
    const missing = Math.floor(seconds * this.sampleRate) - this.bytes / 2;
    if (missing > 0 && missing < this.sampleRate * 3600) this.write(new Int16Array(missing));
  }

  flushHeader(): void {
    if (this.fd === null) return;
    writeSync(this.fd, wavHeader(this.bytes, this.sampleRate, 1), 0, 44, 0);
    this.sinceHeader = 0;
  }

  close(): void {
    if (this.fd === null) return;
    this.flushHeader();
    closeSync(this.fd);
    this.fd = null;
  }
}

/** Appends MediaRecorder chunks to a file. */
export class ChunkFileWriter {
  private fd: number | null;
  private size = 0;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
  }
  get bytes(): number {
    return this.size;
  }
  write(data: Uint8Array): void {
    if (this.fd === null) return;
    writeSync(this.fd, data, 0, data.length);
    this.size += data.length;
  }
  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}
