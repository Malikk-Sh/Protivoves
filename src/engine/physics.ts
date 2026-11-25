import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { STEP } from '../content/dry-dock.ts';
import type { Mission, Obstacle } from '../content/campaign.ts';

export type Pose = { position: Vector3; rotation: Quaternion };
export type Volume = { shape: RAPIER.Shape; before: Pose; after: Pose };
export type Contact = { fraction: number; point: Vector3; normal: Vector3 };
export type Solid = { id: string; collider: RAPIER.Collider; pose: Pose; half: Vector3 };

export const UP = new Vector3(0, 1, 0);
export const ROOT_HEIGHT = 0.80;
export const ROOT_RADIUS = 0.32;
export const WORLD = 1;
export const BODY = 2;
export const BLADE = 4;
export const HERO_BLADE = 8;
export const SHIELD = 16;
export const groups = (members: number, filter: number) => (members << 16) | filter;
export const vector = ({ x, y, z }: RAPIER.Vector) => new Vector3(x, y, z);
export const rotation = ({ x, y, z, w }: RAPIER.Rotation) => new Quaternion(x, y, z, w);
export const pose = (body: RAPIER.RigidBody): Pose => ({
  position: vector(body.translation()),
  rotation: rotation(body.rotation()),
});
export const interpolate = (a: Pose, b: Pose, fraction: number): Pose => ({
  position: a.position.clone().lerp(b.position, fraction),
  rotation: a.rotation.clone().slerp(b.rotation, fraction),
});
export const forward = (yaw: number) => new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
export const right = (yaw: number) => new Vector3(-Math.cos(yaw), 0, Math.sin(yaw));

export class DockPhysics {
  readonly world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  readonly solids: Solid[] = [];

  readonly crates: { body: RAPIER.RigidBody; collider: RAPIER.Collider }[] = [];
  private obstacles: Obstacle[];
  private mission: Mission;

  constructor(mission: Mission) {
    this.mission = mission;
    const { width, length, exitHalfWidth, dummy } = mission;
    const side = width / 2;
    this.obstacles = [...(mission.obstacles ?? [])];
    this.world.timestep = STEP;
    this.world.maxCcdSubsteps = 3;
    this.box('deck', 0, -0.18, length / 2, side, 0.18, length / 2);
    this.box('rail.left', -side + 0.075, 0.525, length / 2, 0.075, 0.525, length / 2);
    this.box('rail.right', side - 0.075, 0.525, length / 2, 0.075, 0.525, length / 2);
    this.box('rail.start', 0, 0.525, 0.075, side, 0.525, 0.075);
    const endHalf = (side - exitHalfWidth) / 2;
    for (const sign of [-1, 1]) {
      this.box(`rail.end.${sign}`, sign * (exitHalfWidth + endHalf), 0.525,
        length - 0.075, endHalf, 0.525, 0.075);
    }
    this.box('gate', 0, 1.25, length - 0.07, exitHalfWidth, 1.25, 0.11);
    this.box('stop', 0, 0.525, length - 0.025, exitHalfWidth, 0.525, 0.025);
    if (dummy) this.box('dummy-base', dummy[0], 0.11, dummy[1], 0.38, 0.11, 0.38);
    for (const block of this.obstacles) {
      this.box(block.id, block.x, block.height / 2, block.z, block.width / 2, block.height / 2, block.depth / 2);
    }
    for (const [x, z] of mission.crates ?? []) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, 0.27, z).setAngularDamping(0.75).setLinearDamping(0.42).setCcdEnabled(true));
      const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.27, 0.27, 0.27)
        .setMass(9).setFriction(0.73).setCollisionGroups(groups(WORLD, WORLD | BODY | BLADE)), body);
      this.crates.push({ body, collider });
    }
  }

  openGate() {
    this.removeSolid('gate');
  }

  foldScreens() {
    for (const block of this.obstacles) if (block.kind === 'screen') this.removeSolid(block.id);
    this.obstacles = this.obstacles.filter(block => block.kind !== 'screen');
  }

  private removeSolid(id: string) {
    const index = this.solids.findIndex(solid => solid.id === id);
    if (index < 0) return;
    this.world.removeCollider(this.solids[index].collider, true);
    this.solids.splice(index, 1);
  }

  waypoint(from: Vector3, goal: Vector3, clearance: number) {
    const rectangles = this.obstacles.map(block => ({
      x: block.x, z: block.z, xHalf: block.width / 2 + clearance, zHalf: block.depth / 2 + clearance,
    }));
    for (const block of rectangles) {
      const dx = from.x - block.x;
      const dz = from.z - block.z;
      const side = block.xHalf - Math.abs(dx);
      const end = block.zHalf - Math.abs(dz);
      if (side < 0 || end < 0) continue;
      const exit = from.clone();
      if (side < end) exit.x = block.x + (Math.sign(dx) || 1) * (block.xHalf + 0.10);
      else exit.z = block.z + (Math.sign(dz) || 1) * (block.zHalf + 0.10);
      return exit;
    }
    const visible = (a: Vector3, b: Vector3) =>
      rectangles.every(block => !crossesRectangle(a, b, block));
    if (visible(from, goal)) return goal;

    const nodes = [from, goal];
    for (const block of rectangles) {
      for (const x of [-1, 1]) for (const z of [-1, 1]) {
        nodes.push(new Vector3(block.x + x * (block.xHalf + 0.10), 0, block.z + z * (block.zHalf + 0.10)));
      }
    }
    const costs = nodes.map((_, index) => index === 0 ? 0 : Infinity);
    const firstStep = nodes.map((_, index) => index);
    const pending = new Set(nodes.keys());
    while (pending.size) {
      const index = [...pending].reduce((best, next) => costs[next] < costs[best] ? next : best);
      pending.delete(index);
      if (!Number.isFinite(costs[index])) break;
      if (index === 1) return nodes[firstStep[index]];
      for (const next of pending) {
        if (!visible(nodes[index], nodes[next])) continue;
        const cost = costs[index] + nodes[index].distanceTo(nodes[next]);
        if (cost < costs[next]) {
          costs[next] = cost;
          firstStep[next] = index === 0 ? next : firstStep[index];
        }
      }
    }
    return goal;
  }

  solverContact(first: RAPIER.Collider, second: RAPIER.Collider): Contact | null {
    let resolved: Contact | null = null;
    this.world.contactPair(first, second, (manifold, flipped) => {
      for (let index = 0; index < manifold.numContacts(); index++) {
        if (resolved || manifold.contactImpulse(index) <= 0.001) continue;
        const point = manifold.solverContactPoint(0);
        if (point) resolved = {
          fraction: 1,
          point: vector(point),
          normal: vector(manifold.normal()).multiplyScalar(flipped ? -1 : 1),
        };
      }
    });
    return resolved;
  }

  floorAt(x: number, z: number) {
    if (Math.abs(x) > this.mission.width / 2 || z < 0 || z > this.mission.length) return null;
    return 0;
  }

  private box(id: string, x: number, y: number, z: number, hx: number, hy: number, hz: number) {
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z).setFriction(0.78).setCollisionGroups(groups(WORLD, WORLD | BODY | BLADE)));
    this.solids.push({
      id,
      collider,
      pose: { position: new Vector3(x, y, z), rotation: new Quaternion() },
      half: new Vector3(hx, hy, hz),
    });
  }
}

function crossesRectangle(a: Vector3, b: Vector3, block: { x: number; z: number; xHalf: number; zHalf: number }) {
  let entry = 0;
  let exit = 1;
  for (const axis of ['x', 'z'] as const) {
    const half = axis === 'x' ? block.xHalf : block.zHalf;
    const local = a[axis] - block[axis];
    const distance = b[axis] - a[axis];
    if (Math.abs(distance) < 0.00001) {
      if (Math.abs(local) > half) return false;
      continue;
    }
    const near = (-half - local) / distance;
    const far = (half - local) / distance;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry > exit) return false;
  }
  return true;
}

// Recast the translating convex volumes on short arcs. Both trajectories are sampled
// in the same interval, including the true end rotations for tip-only contacts.
export function sweep(first: Volume, second: Volume): Contact | null {
  const maxAngle = Math.max(first.before.rotation.angleTo(first.after.rotation),
    second.before.rotation.angleTo(second.after.rotation));
  const segments = Math.max(1, Math.ceil(maxAngle / (Math.PI / 30)));
  for (let segment = 0; segment < segments; segment++) {
    const start = segment / segments;
    const end = (segment + 1) / segments;
    const a = interpolate(first.before, first.after, start);
    const b = interpolate(second.before, second.after, start);
    const nextA = interpolate(first.before, first.after, end);
    const nextB = interpolate(second.before, second.after, end);
    const motionA = nextA.position.clone().sub(a.position);
    const motionB = nextB.position.clone().sub(b.position);
    const middleA = a.rotation.clone().slerp(nextA.rotation, 0.5);
    const middleB = b.rotation.clone().slerp(nextB.rotation, 0.5);
    const hit = first.shape.castShape(a.position, middleA, motionA, second.shape,
      b.position, middleB, motionB, 0.003, 1, true);
    if (hit && hit.time_of_impact >= 0 && hit.time_of_impact <= 1) {
      const local = hit.time_of_impact;
      return {
        fraction: (segment + local) / segments,
        point: vector(hit.witness1).applyQuaternion(middleA).add(a.position).addScaledVector(motionA, local),
        normal: vector(hit.normal1).applyQuaternion(middleA).normalize(),
      };
    }
    const overlap = first.shape.contactShape(nextA.position, nextA.rotation, second.shape,
      nextB.position, nextB.rotation, 0.003);
    if (overlap) return { fraction: end, point: vector(overlap.point1), normal: vector(overlap.normal1) };
  }
  return null;
}

export function pointSpeed(volume: Volume, contact: Contact) {
  const frame = interpolate(volume.before, volume.after, contact.fraction);
  const local = contact.point.clone().sub(frame.position).applyQuaternion(frame.rotation.invert());
  const before = local.clone().applyQuaternion(volume.before.rotation).add(volume.before.position);
  const after = local.applyQuaternion(volume.after.rotation).add(volume.after.position);
  return after.sub(before).divideScalar(STEP);
}
