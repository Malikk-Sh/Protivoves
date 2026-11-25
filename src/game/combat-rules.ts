import { Vector3 } from 'three';
import { forward } from '../engine/physics.ts';
import type { AttackSpec } from '../content/dry-dock.ts';

export const CUT_MIN = 2.2;

export function resolveCut(speed: number, spec: AttackSpec, zone: number, resistance: number,
  yaw: number, impulse: Vector3, transferring: boolean, damageScale = 1, qualityOverride?: number) {
  const quality = qualityOverride ?? Math.max(0, Math.min(1, (speed - CUT_MIN) / 8.8));
  const horizontal = new Vector3(impulse.x, 0, impulse.z).normalize();
  const direction = horizontal.lengthSq() > 0 ? 0.92 + 0.22 * (1 - Math.abs(forward(yaw).dot(horizontal))) : 0.92;
  const balance = Math.min(speed, 14) / 10 * spec.heft * direction * (transferring ? 1.42 : 0.82) / resistance;
  const reaction = balance >= 1.14 ? 'down' : balance >= 0.58 ? 'stagger' : 'hit';
  return { damage: Math.round((6 + (spec.maxDamage - 6) * quality) * zone * damageScale), balance, reaction } as const;
}

export function parryAngle(a: Vector3, b: Vector3, deviation = 58) {
  const cosine = Math.min(1, Math.abs(a.dot(b)));
  return Math.acos(cosine) >= (90 - deviation) * Math.PI / 180;
}
