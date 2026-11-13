class IntercomCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 32000;
    this.chunkSamples = 1024;
    this.outBuffer = new Int16Array(this.chunkSamples);
    this.outIndex = 0;
    this.phase = 0;
    this.prevSample = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    const srcRate = sampleRate || 48000;
    const step = srcRate / this.targetRate;

    while (this.phase < input.length) {
      const idx = Math.floor(this.phase);
      const frac = this.phase - idx;
      const s0 = idx === 0 ? this.prevSample : input[idx - 1];
      const s1 = input[idx];
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuffer[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.outIndex >= this.chunkSamples) {
        const copy = this.outBuffer.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.outIndex = 0;
      }
      this.phase += step;
    }

    this.phase -= input.length;
    this.prevSample = input[input.length - 1];
    return true;
  }
}

registerProcessor("intercom-capture-processor", IntercomCaptureProcessor);
