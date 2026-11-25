export const TICK_RATE = 60;
export const STEP = 1 / TICK_RATE;
export const ticks = (seconds: number) => Math.ceil(seconds * TICK_RATE - 1e-9);

export interface AttackSpec {
  id: string;
  motion?: 'overhead' | 'swing' | 'bash' | 'lunge';
  range?: readonly [number, number];
  windup: number;
  active: number;
  recovery: number;
  maxDamage: number;
  heft: number;
}

export interface FighterSpec {
  id: string;
  name?: string;
  scale?: number;
  shield?: boolean;
  hp: number;
  mass: number;
  resistance: number;
  pace: number;
  blade: { length: number; mass: number; radius: number };
  attack: AttackSpec;
}

export const DANIL: FighterSpec = {
  id: 'hero.danil',
  hp: 100,
  mass: 68,
  resistance: 1,
  pace: 4.1,
  blade: { length: 1, mass: 2.35, radius: 0.043 },
  attack: { id: 'W1', windup: 0.10, active: 0.20, recovery: 0.23, maxDamage: 22, heft: 1 },
};

export const WATCHMAN: FighterSpec = {
  id: 'E1',
  hp: 54,
  mass: 74,
  resistance: 0.96,
  pace: 2.85,
  blade: { length: 0.78, mass: 2.05, radius: 0.046 },
  attack: { id: 'E1.overhead', windup: 0.64, active: 0.18, recovery: 0.56, maxDamage: 18, heft: 1 },
};

export const M01 = {
  id: 'M01',
  width: 10,
  length: 22,
  player: [0, 2],
  enemy: [0, 13],
  dummy: [3.1, 5.2],
  combatLine: 8,
  exitZ: 20.5,
  exitHalfWidth: 1.2,
  healthForStar: 60,
} as const;

export const CAMERA_AZIMUTH = Math.PI / 10;
export const CAMERA_TILT = 40 * Math.PI / 180;

export const SUPPORT_DRILL = {
  player: [0, 10.7],
  enemy: [0.22, 11.885],
  strikeAt: 0.64,
} as const;
