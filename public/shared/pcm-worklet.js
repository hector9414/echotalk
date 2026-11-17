// Runs on the audio rendering thread. Converts the presenter's mic input
// (Float32, already resampled to 16kHz by the AudioContext) into LINEAR16
// PCM chunks of ~200ms and posts each one to the main thread as a
// transferable ArrayBuffer, ready to send straight over the WebSocket - no
// container/codec involved, which is what lets the server restart the
// Speech-to-Text stream mid-session without the browser needing to know.
class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSamples = 3200; // ~200ms at 16kHz
    this.buffer = new Int16Array(this.targetSamples);
    this.writeIndex = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush();
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.writeIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.writeIndex++;

      if (this.writeIndex >= this.targetSamples) {
        this.flush();
      }
    }

    return true;
  }

  flush() {
    if (this.writeIndex === 0) return;
    const chunk = this.buffer.slice(0, this.writeIndex);
    this.port.postMessage(chunk.buffer, [chunk.buffer]);
    this.buffer = new Int16Array(this.targetSamples);
    this.writeIndex = 0;
  }
}

registerProcessor('pcm-worklet-processor', PcmWorkletProcessor);
