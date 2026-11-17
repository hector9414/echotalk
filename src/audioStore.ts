import type { SynthesizedAudio } from './providers/types';

// In-memory store of synthesized TTS clips, keyed by TranscriptSegment id.
// Nothing here ever touches disk - clearing a session clears its audio too.
export class AudioStore {
  private readonly clips = new Map<string, SynthesizedAudio>();

  set(id: string, audio: SynthesizedAudio): void {
    this.clips.set(id, audio);
  }

  get(id: string): SynthesizedAudio | undefined {
    return this.clips.get(id);
  }

  delete(id: string): void {
    this.clips.delete(id);
  }

  clear(): void {
    this.clips.clear();
  }
}
