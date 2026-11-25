import { DANIL, M01, WATCHMAN } from './dry-dock.ts';
import type { AttackSpec, FighterSpec } from './dry-dock.ts';

export type MissionId = 'M01' | 'M02' | 'M03' | 'M04';
export type WeaponId = 'W1' | 'W2';
export type DifficultyId = 'story' | 'normal' | 'master';
export type ActorId = 'E1' | 'E2' | 'E3' | 'B1';
export type Position = readonly [x: number, z: number];

export interface Obstacle {
  id: string;
  kind: 'container' | 'screen';
  x: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface BoardZone {
  x: number;
  minZ: number;
  maxZ: number;
  cleanSeconds: number;
  intrusionSeconds: number;
}

export interface Spawn {
  id: string;
  actor: ActorId;
  at: Position;
  afterSeconds: number;
  when?: 'clearance';
}

export interface Mission {
  id: MissionId;
  title: string;
  summary: string;
  objective: string;
  stars: readonly [string, string];
  width: number;
  length: number;
  player: Position;
  combatLine: number;
  exitZ: number;
  exitHalfWidth: number;
  threats: readonly [Spawn, ...Spawn[]];
  obstacles?: readonly Obstacle[];
  dummy?: Position;
  crates?: readonly Position[];
  boarding?: BoardZone;
}

export const MISSIONS: Record<MissionId, Mission> = {
  M01: {
    id: 'M01',
    title: 'Сухой док',
    summary: 'Победи Докового сторожа и открой проход к эвакуационной платформе.',
    objective: 'Победи сторожа',
    stars: ['Заверши миссию с 60 HP или больше', 'Парируй удар сторожа'],
    width: M01.width, length: M01.length, player: M01.player, combatLine: M01.combatLine,
    exitZ: M01.exitZ, exitHalfWidth: M01.exitHalfWidth, dummy: M01.dummy,
    threats: [{ id: 'm01.w1.e1', actor: 'E1', at: [0, 13], afterSeconds: 0 }],
  },
  M02: {
    id: 'M02',
    title: 'Грузовой проход',
    summary: 'Обойди контейнер, победи щитоносца и сторожа и пройди через ворота.',
    objective: 'Зачисти оба прохода',
    stars: ['Получи не больше двух попаданий', 'Сбей щитоносца с опоры боковым ударом'],
    width: 13, length: 23, player: [0, 2], combatLine: 6, exitZ: 21.5, exitHalfWidth: 1.2,
    obstacles: [{ id: 'container', kind: 'container', x: 0, z: 11, width: 2.4, height: 2.55, depth: 4 }],
    crates: [[-4.7, 8.5], [4.8, 15.2]],
    threats: [
      { id: 'm02.w1.e2', actor: 'E2', at: [2.7, 10.5], afterSeconds: 0 },
      { id: 'm02.w2.e1', actor: 'E1', at: [-3.1, 16], afterSeconds: 6, when: 'clearance' },
    ],
  },
  M03: {
    id: 'M03',
    title: 'Последний у трапа',
    summary: 'Дойди до зоны посадки и удержи проход, пока бригада не окажется на платформе.',
    objective: 'Удержи зону посадки',
    stars: ['Заверши посадку за 38 секунд', 'Отбрось машину за границу зоны'],
    width: 14, length: 21, player: [0, 3], combatLine: 13, exitZ: 19.5, exitHalfWidth: 1.2,
    boarding: { x: 3.1, minZ: 13, maxZ: 19, cleanSeconds: 26, intrusionSeconds: 8 },
    threats: [
      { id: 'm03.w1.e1', actor: 'E1', at: [-5.4, 9], afterSeconds: 0 },
      { id: 'm03.w2.e3', actor: 'E3', at: [5.4, 8], afterSeconds: 9 },
      { id: 'm03.w3.e1', actor: 'E1', at: [4.8, 11], afterSeconds: 17 },
    ],
  },
  M04: {
    id: 'M04',
    title: 'Доковый мастер',
    summary: 'Дождись тяжёлого промаха Докового мастера, освободи пролёт и пройди к платформе.',
    objective: 'Победи Докового мастера',
    stars: ['Заверши миссию с 50 HP или больше', 'Дважды сбей мастера на колено в разных окнах'],
    width: 16, length: 21, player: [0, 4], combatLine: 8, exitZ: 19.5, exitHalfWidth: 1.2,
    obstacles: [-1, 1].map(side => ({
      id: side < 0 ? 'screen.left' : 'screen.right', kind: 'screen',
      x: side * 4.75, z: 10.5, width: 0.5, height: 1.85, depth: 5,
    })),
    threats: [{ id: 'm04.w1.b1', actor: 'B1', at: [0, 14], afterSeconds: 0 }],
  },
};

export const MISSION_ORDER: readonly MissionId[] = ['M01', 'M02', 'M03', 'M04'];

export const WEAPONS = {
  W1: { title: 'Аварийный резак', description: 'Клинок 1 м · уверенная боковая дуга', fighter: DANIL },
  W2: {
    title: 'Короткий тесак',
    description: 'Клинок 0,75 м · короткое окно восстановления',
    fighter: {
      ...DANIL,
      blade: { length: 0.75, mass: 1.70, radius: 0.040 },
      attack: { id: 'W2', windup: 0.08, active: 0.16, recovery: 0.16, maxDamage: 18, heft: 0.82 },
    } satisfies FighterSpec,
  },
} as const;

export const DIFFICULTIES = {
  story: { title: 'История', damage: 0.70, windup: 1.24, parryDeviation: 70, gap: 0.35 },
  normal: { title: 'Обычная', damage: 1, windup: 1, parryDeviation: 58, gap: 0.20 },
  master: { title: 'Мастер', damage: 1.15, windup: 0.90, parryDeviation: 48, gap: 0.12 },
} as const;

export const ACTORS: Record<ActorId, FighterSpec> = {
  E1: { ...WATCHMAN, name: 'Доковый сторож' },
  E2: {
    id: 'E2', name: 'Щитоносец', hp: 68, mass: 96, resistance: 1.16, pace: 2.60, shield: true,
    blade: { length: 0.72, mass: 2.0, radius: 0.045 },
    attack: { id: 'E2.sweep', motion: 'swing', range: [0.74, 1.56], windup: 0.60, active: 0.18,
      recovery: 0.56, maxDamage: 16, heft: 1 },
  },
  E3: {
    id: 'E3', name: 'Наладчик', hp: 45, mass: 62, resistance: 0.88, pace: 3.45, scale: 0.92,
    blade: { length: 0.66, mass: 1.56, radius: 0.043 },
    attack: { id: 'E3.diagonal', motion: 'swing', range: [0.73, 1.38], windup: 0.46, active: 0.15,
      recovery: 0.47, maxDamage: 16, heft: 0.85 },
  },
  B1: {
    id: 'B1', name: 'Доковый мастер', hp: 154, mass: 158, resistance: 1.18, pace: 2.55, scale: 2.42 / 1.72,
    blade: { length: 1.45, mass: 5.0, radius: 0.067 },
    attack: { id: 'B1A', motion: 'overhead', range: [1.55, 2.50], windup: 0.86, active: 0.20,
      recovery: 0.86, maxDamage: 25, heft: 1.16 },
  },
};

export const SHIELD_BASH: AttackSpec = {
  id: 'E2.bash', motion: 'bash', range: [0.70, 1.39],
  windup: 0.72, active: 0.20, recovery: 0.58, maxDamage: 12, heft: 1.25,
};

export const MASTER_SWEEP: AttackSpec = {
  id: 'B1B', motion: 'swing', range: [1.35, 2.20],
  windup: 0.74, active: 0.24, recovery: 0.68, maxDamage: 22, heft: 1.16,
};

export const MASTER_LUNGE: AttackSpec = {
  id: 'B1C', motion: 'lunge', range: [2.05, 3.05],
  windup: 0.69, active: 0.20, recovery: 0.76, maxDamage: 24, heft: 1.16,
};

export const MASTER_PHASE_HP = 84;
