/* global AudioWorkletProcessor, registerProcessor */
class InterviewMicProcessor extends AudioWorkletProcessor {
  frame = new ArrayBuffer(6400);
  view = new DataView(this.frame);
  offset = 0;
  energy = 0;

  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data !== "drain") return;
      const pcm = this.frame.slice(0, this.offset);
      this.offset = 0;
      this.energy = 0;
      this.port.postMessage({ tail: pcm }, [pcm]);
    };
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;

    for (const sample of samples) {
      const value = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.offset, value < 0 ? value * 32768 : value * 32767, true);
      this.offset += 2;
      this.energy += value * value;
      if (this.offset === this.frame.byteLength) {
        const level = Math.sqrt(this.energy / (this.offset / 2));
        this.port.postMessage({ pcm: this.frame, level }, [this.frame]);
        this.frame = new ArrayBuffer(6400);
        this.view = new DataView(this.frame);
        this.offset = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}

registerProcessor("interview-mic", InterviewMicProcessor);
