/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * Captures mono audio, downsamples it to 16 kHz Int16 and posts 100 ms frames plus a level.
 * Runs on the audio rendering thread.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.frame = new Int16Array(1600);
    this.fill = 0;
    this.pos = 0; // fractional read position into the incoming stream
    this.prev = 0;
    this.acc = 0;
    this.accN = 0;
    this.sumSq = 0;
    this.levelN = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    const n = ch0.length;
    for (let i = 0; i < n; i++) {
      const s = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.sumSq += s * s;
      this.levelN++;
      // Box-filter decimation: average the samples that fall into each output sample.
      this.acc += s;
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        const c = v < -1 ? -1 : v > 1 ? 1 : v;
        this.frame[this.fill++] = c < 0 ? c * 0x8000 : c * 0x7fff;
        if (this.fill === this.frame.length) {
          const level = Math.sqrt(this.sumSq / Math.max(1, this.levelN));
          this.sumSq = 0;
          this.levelN = 0;
          const out = this.frame;
          this.port.postMessage({ pcm: out.buffer, level }, [out.buffer]);
          this.frame = new Int16Array(1600);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
