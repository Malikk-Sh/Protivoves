import type { HitResult } from '../game/dry-dock.ts';

export class DockAudio {
  muted = false;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;

  unlock() {
    if (!window.AudioContext) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.gain = this.context.createGain();
        this.gain.gain.value = 0.20;
        this.gain.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
    } catch {
      // The combat telegraph and contact effects are available without audio.
    }
  }

  briefing() {
    for (const delay of [0, 0.28, 0.56]) this.note(191, 147, 0.18, 0.25, 'triangle', delay);
  }

  signal() {
    this.note(113, 171, 0.16, 0.30, 'triangle');
  }

  swing() {
    this.note(105, 41, 0.14, 0.18, 'sine');
  }

  gate() {
    this.note(128, 253, 0.24, 0.19, 'sine');
    this.note(255, 383, 0.27, 0.12, 'triangle', 0.12);
  }

  impact(result: HitResult) {
    if (result === 'parry') {
      this.note(1240, 725, 0.13, 0.24, 'triangle');
      this.note(1670, 940, 0.17, 0.20, 'triangle', 0.049);
    } else if (result === 'block' || result === 'glance') {
      this.note(940, 382, 0.11, result === 'block' ? 0.16 : 0.09, 'triangle');
    } else {
      this.note(191, 62, 0.16, 0.33, 'triangle');
      this.note(756, 286, 0.08, 0.10, 'triangle');
    }
  }

  private note(from: number, to: number, duration: number, volume: number, type: OscillatorType, delay = 0) {
    if (this.muted || !this.context || !this.gain || this.context.state !== 'running') return;
    const time = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, time);
    oscillator.frequency.exponentialRampToValueAtTime(to, time + duration);
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0.001, time);
    envelope.gain.exponentialRampToValueAtTime(volume, time + 0.009);
    envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
    oscillator.connect(envelope).connect(this.gain);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };
  }
}
