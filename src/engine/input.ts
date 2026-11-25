import { ticks } from '../content/dry-dock.ts';

export interface Move {
  x: number;
  y: number;
}

export interface Intent {
  move: Move;
  turn: -1 | 0 | 1;
  release: boolean;
}

const ZERO: Move = { x: 0, y: 0 };
const minSwingMagnitude = 0.55;
const minimumTurn = 55 * Math.PI / 180;
const largestTurn = 145 * Math.PI / 180;
const turnWindow = Math.floor(0.14 * 60);
const keys: Readonly<Record<string, Move>> = {
  KeyW: { x: 0, y: 1 }, ArrowUp: { x: 0, y: 1 },
  KeyS: { x: 0, y: -1 }, ArrowDown: { x: 0, y: -1 },
  KeyD: { x: 1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  KeyA: { x: -1, y: 0 }, ArrowLeft: { x: -1, y: 0 },
};

export function angleDelta(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export class Gesture {
  private samples: { tick: number; angle: number }[] = [];
  private movingTicks = 0;
  private smoothed: Move = ZERO;

  sample(raw: Move, tick: number, released: boolean): Intent {
    const magnitude = Math.hypot(raw.x, raw.y);
    const release = released && this.movingTicks >= ticks(0.15);
    let turn: Intent['turn'] = 0;

    if (magnitude < minSwingMagnitude) {
      this.samples.length = 0;
    } else {
      const angle = Math.atan2(-raw.x, raw.y);
      this.samples = this.samples.filter(sample => tick - sample.tick <= turnWindow);
      if (this.movingTicks >= ticks(0.14)) {
        for (const sample of this.samples) {
          const delta = angleDelta(sample.angle, angle);
          if (Math.abs(delta) >= minimumTurn && Math.abs(delta) <= largestTurn) {
            turn = delta < 0 ? -1 : 1;
            this.samples.length = 0;
            break;
          }
        }
      }
      this.samples.push({ tick, angle });
    }

    this.movingTicks = magnitude > 0 ? this.movingTicks + 1 : 0;
    const smoothing = 1 - Math.exp(-1 / (60 * 0.045));
    this.smoothed = magnitude > 0 ? {
      x: this.smoothed.x + (raw.x - this.smoothed.x) * smoothing,
      y: this.smoothed.y + (raw.y - this.smoothed.y) * smoothing,
    } : ZERO;
    return { move: this.smoothed, turn, release };
  }

  reset() {
    this.samples.length = 0;
    this.movingTicks = 0;
    this.smoothed = ZERO;
  }
}

export class BrowserInput {
  private active = false;
  private mode: 'pointer' | 'keys' = 'keys';
  private pointer: number | null = null;
  private origin: Move = ZERO;
  private pointerMove: Move = ZERO;
  private pressed = new Set<string>();
  private released = false;
  private guarding = false;
  private gesture = new Gesture();

  private surface: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;

  constructor(surface: HTMLElement, stick: HTMLElement, knob: HTMLElement) {
    this.surface = surface;
    this.stick = stick;
    this.knob = knob;
    surface.addEventListener('pointerdown', this.down);
    surface.addEventListener('pointermove', this.move);
    surface.addEventListener('pointerup', this.up);
    surface.addEventListener('pointercancel', this.cancel);
    surface.addEventListener('lostpointercapture', this.cancel);
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
  }

  setActive(active: boolean) {
    this.active = active;
    this.reset();
  }

  reset() {
    const pointer = this.pointer;
    this.pointer = null;
    if (pointer !== null && this.surface.hasPointerCapture(pointer)) {
      this.surface.releasePointerCapture(pointer);
    }
    this.pointerMove = ZERO;
    this.stick.hidden = true;
    this.pressed.clear();
    this.guarding = false;
    this.released = false;
    this.gesture.reset();
  }

  sample(tick: number): Intent {
    let raw = ZERO;
    if (this.mode === 'pointer') {
      raw = this.pointerMove;
    } else if (!this.guarding) {
      const directions = [...this.pressed].map(code => keys[code]);
      const x = Math.sign(directions.reduce((sum, value) => sum + value.x, 0));
      const y = Math.sign(directions.reduce((sum, value) => sum + value.y, 0));
      const scale = Math.max(1, Math.hypot(x, y));
      raw = { x: x / scale, y: y / scale };
    }
    const result = this.gesture.sample(raw, tick, this.released);
    this.released = false;
    return result;
  }

  private down = (event: PointerEvent) => {
    if (!this.active || this.pointer !== null || event.button !== 0) return;
    const rect = this.surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const style = getComputedStyle(this.surface);
    const inset = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
    if (y < rect.height * 0.48 || y > rect.height - inset('padding-bottom') ||
      x < inset('padding-left') || x > rect.width - inset('padding-right')) return;

    this.mode = 'pointer';
    this.pressed.clear();
    this.pointer = event.pointerId;
    this.origin = { x, y };
    this.pointerMove = ZERO;
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    this.knob.style.transform = '';
    this.stick.hidden = false;
    this.surface.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private move = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer) return;
    const rect = this.surface.getBoundingClientRect();
    const x = event.clientX - rect.left - this.origin.x;
    const y = event.clientY - rect.top - this.origin.y;
    const distance = Math.hypot(x, y);
    const strength = Math.min(1, Math.max(0, (distance - 12) / 48));
    this.pointerMove = distance > 0 ? { x: x / distance * strength, y: -y / distance * strength } : ZERO;
    const limit = Math.min(1, 62 / Math.max(1, distance));
    this.knob.style.transform = `translate(${x * limit}px, ${y * limit}px)`;
  };

  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer) return;
    this.pointer = null;
    this.pointerMove = ZERO;
    this.stick.hidden = true;
    this.released = this.mode === 'pointer';
  };

  private cancel = (event: PointerEvent) => {
    if (event.pointerId === this.pointer) this.reset();
  };

  private keydown = (event: KeyboardEvent) => {
    if (!keys[event.code] && event.code !== 'Space') return;
    if (!this.active) return;
    event.preventDefault();
    if (event.repeat) return;
    this.mode = 'keys';
    if (event.code === 'Space') {
      this.guarding = true;
      this.released = true;
    } else {
      this.pressed.add(event.code);
    }
  };

  private keyup = (event: KeyboardEvent) => {
    if (event.code === 'Space') this.guarding = false;
    this.pressed.delete(event.code);
  };
}
