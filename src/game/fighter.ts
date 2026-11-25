import RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, Quaternion, Vector3 } from 'three';
import { STEP, ticks } from '../content/dry-dock.ts';
import type { AttackSpec, FighterSpec } from '../content/dry-dock.ts';
import { angleDelta } from '../engine/input.ts';
import {
  BLADE, BODY, HERO_BLADE, ROOT_HEIGHT, ROOT_RADIUS, SHIELD, UP, WORLD,
  forward, groups, pose, right, vector,
} from '../engine/physics.ts';
import type { DockPhysics, Pose } from '../engine/physics.ts';

export type FootSupport = 'both' | 'left' | 'right' | 'none';
export type Stance = 'ready' | 'stagger' | 'falling' | 'down' | 'rising' | 'kneel' | 'dead';
export type Strike = { id: string; spec: AttackSpec; start: number; yaw: number; side: -1 | 1; hit: Set<string>; blocked: boolean };
export type Phase = 'idle' | 'windup' | 'active' | 'recovery';

export interface FighterFrame {
  root: Pose;
  blade: Pose;
  shield?: Pose;
  yaw: number;
  leftFoot: Vector3;
  rightFoot: Vector3;
  lean: number;
}

const height = (value: number) => new Vector3(0, value, 0);

export class Fighter {
  readonly body: RAPIER.RigidBody;
  readonly blade: RAPIER.RigidBody;
  readonly bodyCollider: RAPIER.Collider;
  readonly bladeCollider: RAPIER.Collider;
  readonly shield?: { body: RAPIER.RigidBody; collider: RAPIER.Collider };
  readonly scale: number;
  readonly rootHeight: number;
  readonly rootRadius: number;
  hp: number;
  yaw: number;
  stance: Stance = 'ready';
  support: FootSupport = 'both';
  transfer = false;
  strike: Strike | null = null;
  guardUntil = 0;
  nextGuard = 0;
  recoverUntil = 0;
  groundedHit = false;
  moving = false;
  drillPose: 'planted' | 'transfer' | null = null;
  private stanceTick = 0;
  private gait = 0;
  private transferTicks = 0;
  private plantedTicks = 0;
  private riseFrom: Pose | null = null;
  frame: FighterFrame;
  previous: FighterFrame;

  readonly spec: FighterSpec;
  readonly id: string;
  readonly isPlayer: boolean;
  private dock: DockPhysics;

  constructor(spec: FighterSpec, id: string, dock: DockPhysics, x: number, z: number, yaw: number, isPlayer: boolean) {
    this.spec = spec;
    this.id = id;
    this.dock = dock;
    this.isPlayer = isPlayer;
    this.hp = spec.hp;
    this.yaw = yaw;
    this.scale = spec.scale ?? 1;
    this.rootHeight = ROOT_HEIGHT * this.scale;
    this.rootRadius = ROOT_RADIUS * this.scale;
    this.body = dock.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, this.rootHeight, z).lockRotations().setCanSleep(false).setCcdEnabled(true));
    this.bodyCollider = dock.world.createCollider(RAPIER.ColliderDesc.capsule(this.rootHeight - this.rootRadius, this.rootRadius)
      .setMass(spec.mass).setFriction(0.05).setCollisionGroups(groups(BODY, WORLD | BODY)), this.body);
    const held = this.weaponTarget(0);
    this.blade = dock.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(held.position.x, held.position.y, held.position.z)
      .setRotation(held.rotation).setGravityScale(0).setCanSleep(false).setCcdEnabled(true)
      .setSoftCcdPrediction(0.28));
    this.bladeCollider = dock.world.createCollider(RAPIER.ColliderDesc.capsule(
      spec.blade.length * 0.5 - spec.blade.radius, spec.blade.radius)
      .setMass(spec.blade.mass).setRestitution(0.14).setFriction(0.06)
      .setCollisionGroups(this.weaponGroups()), this.blade);
    if (spec.shield) {
      const shield = this.shieldTarget(0);
      const body = dock.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(shield.position.x, shield.position.y, shield.position.z).setRotation(shield.rotation));
      const collider = dock.world.createCollider(RAPIER.ColliderDesc.cuboid(0.38, 0.47, 0.075)
        .setRestitution(0.19).setCollisionGroups(groups(SHIELD, HERO_BLADE)), body);
      this.shield = { body, collider };
    }
    this.frame = this.makeFrame();
    this.previous = this.frame;
  }

  get at() { return vector(this.body.translation()); }
  get canAct() { return this.stance === 'ready' || this.stance === 'stagger'; }
  get onFloor() { return this.stance === 'falling' || this.stance === 'down'; }
  get alive() { return this.hp > 0 && this.stance !== 'dead'; }

  phase(tick: number): Phase {
    if (!this.strike) return 'idle';
    if (this.strike.blocked) return 'recovery';
    const age = tick - this.strike.start;
    const windup = ticks(this.strike.spec.windup);
    const active = ticks(this.strike.spec.active);
    if (age < windup) return 'windup';
    if (age < windup + active) return 'active';
    return 'recovery';
  }

  startStrike(tick: number, side: -1 | 1, heading = this.yaw, spec = this.spec.attack) {
    if (!this.canAct || this.strike || tick < this.recoverUntil) return false;
    this.guardUntil = 0;
    this.strike = { id: `${this.id}.${tick}`, start: tick, spec, yaw: heading, side, hit: new Set(), blocked: false };
    return true;
  }

  openGuard(tick: number) {
    if (this.stance !== 'ready' || this.strike || tick < this.nextGuard || tick < this.recoverUntil) return false;
    this.guardUntil = tick + ticks(0.16);
    this.nextGuard = tick + ticks(0.38);
    return true;
  }

  cancelStrike(tick: number, seconds: number) {
    if (this.strike) this.strike.blocked = true;
    this.recoverUntil = Math.max(this.recoverUntil, tick + ticks(seconds));
    if (this.strike) this.strike.start = tick - this.strikeDuration();
  }

  turnToward(yaw: number, rate: number) {
    const delta = MathUtils.clamp(angleDelta(this.yaw, yaw), -rate * STEP, rate * STEP);
    this.yaw = angleDelta(0, this.yaw + delta);
  }

  update(tick: number, clearToRise: boolean) {
    if (this.strike && tick >= this.strike.start + this.strikeDuration() && tick >= this.recoverUntil) this.strike = null;
    if (this.stance === 'kneel' && tick >= this.stanceTick + ticks(0.72)) {
      this.body.setLinearDamping(0);
      this.setStance('ready', tick);
    }
    if (this.stance === 'stagger' && tick >= this.stanceTick + ticks(0.34)) this.stance = 'ready';
    if (this.stance === 'falling' && tick >= this.stanceTick + ticks(0.24) && this.at.y < 0.55 * this.scale) {
      this.setStance('down', tick);
    }
    if (this.stance === 'down' && clearToRise && tick >= this.stanceTick + ticks(0.22)) {
      this.riseFrom = pose(this.body);
      this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.setStance('rising', tick);
    }
    if (this.stance === 'rising' && this.riseFrom) {
      const fraction = Math.min(1, (tick - this.stanceTick) / ticks(0.5));
      const blend = fraction * fraction * (3 - 2 * fraction);
      const floor = this.dock.floorAt(this.riseFrom.position.x, this.riseFrom.position.z) ?? 0;
      if (fraction < 1) {
        this.body.setNextKinematicTranslation(this.riseFrom.position.clone().lerp(
          new Vector3(this.riseFrom.position.x, floor + this.rootHeight, this.riseFrom.position.z), blend));
        this.body.setNextKinematicRotation(this.riseFrom.rotation.clone().slerp(new Quaternion(), blend));
      } else {
        this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        this.body.setRotation(new Quaternion(), true);
        this.body.setTranslation({ x: this.at.x, y: floor + this.rootHeight, z: this.at.z }, true);
        this.body.setLinvel(new Vector3(), true);
        this.body.setAngvel(new Vector3(), true);
        this.body.lockRotations(true, true);
        this.body.setLinearDamping(0);
        this.riseFrom = null;
        this.setStance('ready', tick);
      }
    }
  }

  move(goal: Vector3) {
    this.moving = this.canAct && goal.lengthSq() > 0.03;
    if (!this.canAct) return;
    const resistance = this.stance === 'stagger' ? 0.65 : 1;
    const velocity = vector(this.body.linvel());
    const acceleration = this.moving ? 18 : 19;
    const braking = this.stance === 'stagger' ? 0.48 : 1;
    const change = goal.clone().multiplyScalar(resistance).sub(new Vector3(velocity.x, 0, velocity.z))
      .clampLength(0, acceleration * braking * STEP);
    this.body.applyImpulse(change.multiplyScalar(this.spec.mass), true);
  }

  driveWeapon(tick: number) {
    if (!this.alive || this.onFloor || this.stance === 'rising') return;
    const target = this.weaponTarget(tick);
    if (this.shield) {
      const shield = this.shieldTarget(tick);
      this.shield.body.setNextKinematicTranslation(shield.position);
      this.shield.body.setNextKinematicRotation(shield.rotation);
    }
    const current = pose(this.blade);
    const active = this.phase(tick) === 'active';
    const velocity = target.position.sub(current.position).multiplyScalar(active ? 52 : 33)
      .clampLength(0, active ? 15 : 10);
    const angular = target.rotation.multiply(current.rotation.invert());
    const sign = angular.w < 0 ? -1 : 1;
    const angVelocity = new Vector3(angular.x, angular.y, angular.z);
    if (angVelocity.lengthSq() > 1e-10) {
      const theta = 2 * Math.atan2(angVelocity.length(), Math.abs(angular.w));
      angVelocity.normalize().multiplyScalar(sign * Math.min(54, theta * (active ? 48 : 32)));
    }
    this.blade.setLinvel(velocity, true);
    this.blade.setAngvel(angVelocity, true);
  }

  refreshFrame(tick: number) {
    this.previous = this.frame;
    const velocity = this.body.linvel();
    this.gait += Math.min(this.spec.pace, Math.hypot(velocity.x, velocity.z)) * STEP * 7.4;
    this.frame = this.makeFrame(tick);
    const supported = (foot: Vector3) => {
      const floor = this.dock.floorAt(foot.x, foot.z);
      return floor !== null && foot.y - floor < 0.038 && foot.y - floor > -0.08;
    };
    const left = this.canAct && supported(this.frame.leftFoot);
    const right = this.canAct && supported(this.frame.rightFoot);
    this.support = left ? (right ? 'both' : 'left') : right ? 'right' : 'none';
    const projection = this.frame.root.position.clone().addScaledVector(forward(this.yaw), this.frame.lean * 0.24);
    projection.y = 0;
    const segment = this.frame.rightFoot.clone().sub(this.frame.leftFoot);
    segment.y = 0;
    const base = this.frame.leftFoot.clone();
    base.y = 0;
    const along = MathUtils.clamp(projection.clone().sub(base).dot(segment) / Math.max(segment.lengthSq(), 0.001), 0, 1);
    const explicitLunge = !this.isPlayer && this.phase(tick) === 'active';
    const weightOut = this.support !== 'both' ||
      projection.distanceTo(base.addScaledVector(segment, along)) > 0.18 || explicitLunge;
    this.transferTicks = weightOut ? this.transferTicks + 1 : 0;
    this.plantedTicks = weightOut ? 0 : this.plantedTicks + 1;
    if (this.transferTicks >= 3) this.transfer = true;
    if (this.plantedTicks >= 3) this.transfer = false;
  }

  react(result: 'hit' | 'stagger' | 'down', impulse: Vector3, balance: number, tick: number) {
    this.guardUntil = 0;
    const limit = this.isPlayer ? 2.6 : 2.1;
    const push = impulse.clone();
    push.y = 0;
    push.normalize();
    this.body.applyImpulse(push.clone().multiplyScalar(this.spec.mass * Math.min(limit, balance * 1.5)), true);
    if (this.hp <= 0) {
      this.fall(push, tick, true);
    } else if (this.canAct && result === 'down') {
      if (this.spec.id === 'B1') {
        this.cancelStrike(tick, 0.72);
        this.body.setLinearDamping(2.7);
        this.setStance('kneel', tick);
      } else this.fall(push, tick, false);
    } else if (this.canAct && result === 'stagger') {
      if (this.spec.id !== 'B1') this.cancelStrike(tick, 0.34);
      this.setStance('stagger', tick);
    }
  }

  recoil(normal: Vector3) {
    this.blade.applyImpulse(normal.clone().multiplyScalar(-this.spec.blade.mass * 1.15), true);
  }

  private fall(direction: Vector3, tick: number, fatal: boolean) {
    this.setStance(fatal ? 'dead' : 'falling', tick);
    this.cancelStrike(tick, 0.64);
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.lockRotations(false, true);
    this.body.setLinearDamping(1.4);
    this.body.setAngularDamping(2.4);
    const axis = UP.clone().cross(direction.lengthSq() ? direction : forward(this.yaw).negate());
    this.body.setAngvel(axis.multiplyScalar(6.8), true);
    this.blade.setGravityScale(1, true);
    this.bladeCollider.setCollisionGroups(groups(BLADE, WORLD));
    this.shield?.body.setEnabled(false);
    if (fatal) this.bodyCollider.setCollisionGroups(groups(BODY, WORLD));
  }

  private setStance(next: Stance, tick: number) {
    this.stance = next;
    this.stanceTick = tick;
    if (next === 'ready') {
      this.groundedHit = false;
      this.blade.setGravityScale(0, true);
      this.bladeCollider.setCollisionGroups(this.weaponGroups());
      this.shield?.body.setEnabled(true);
    }
  }

  private strikeDuration() {
    const spec = this.strike?.spec ?? this.spec.attack;
    return ticks(spec.windup) + ticks(spec.active) + ticks(spec.recovery);
  }

  setPresent(present: boolean) {
    this.body.setEnabled(present);
    this.blade.setEnabled(present);
    this.shield?.body.setEnabled(present);
  }

  private weaponGroups() {
    return this.isPlayer ? groups(BLADE | HERO_BLADE, WORLD | BLADE | SHIELD) : groups(BLADE, WORLD | BLADE);
  }

  private shieldTarget(tick: number): Pose {
    const strike = this.strike;
    const phase = this.phase(tick);
    const bash = strike?.spec.motion === 'bash' && !strike.blocked;
    const age = strike ? (tick - strike.start - ticks(strike.spec.windup)) / ticks(strike.spec.active) : 0;
    const extension = bash ? (phase === 'active' ? Math.sin(Math.PI * age * 0.52) * 0.53 : 0) : 0;
    const turn = this.phase(tick) === 'recovery' && !bash ? -0.62 : -0.09;
    const position = this.at.add(height(0.24)).addScaledVector(forward(this.yaw), 0.45 + extension)
      .addScaledVector(right(this.yaw), -0.22);
    return { position, rotation: new Quaternion().setFromAxisAngle(UP, this.yaw + turn) };
  }

  private weaponTarget(tick: number): Pose {
    const feet = this.at.add(height(-this.rootHeight));
    const high = (value: number) => height(value * this.scale);
    const f = forward(this.yaw);
    const r = right(this.yaw);
    const phase = this.phase(tick);
    const strike = this.strike;
    let hand = feet.clone().addScaledVector(f, 0.30).addScaledVector(r, 0.36).add(high(1.04));
    let axis = f.clone().addScaledVector(r, 0.43).add(high(0.02));
    if (this.isPlayer && !this.moving) {
      hand = feet.clone().addScaledVector(f, 0.59).addScaledVector(r, 0.40).add(high(1.31));
      axis = r.clone().multiplyScalar(-1).addScaledVector(f, 0.27).add(high(0.38));
    } else if (!this.isPlayer) {
      hand = feet.clone().addScaledVector(f, 0.27).addScaledVector(r, 0.43).add(high(1.08));
      axis = f.clone().multiplyScalar(0.62).addScaledVector(r, 0.48).add(high(0.8));
    }

    if (this.drillPose) {
      hand = feet.clone().addScaledVector(r, 0.53).addScaledVector(f, -0.12).add(high(0.96));
      axis = r.clone().add(high(0.38));
    } else if (strike && !strike.blocked) {
      const windup = ticks(strike.spec.windup);
      const active = ticks(strike.spec.active);
      const age = tick - strike.start;
      const sweep = MathUtils.clamp((age - windup + 0.6) / active, 0, 1);
      const prepare = MathUtils.clamp((age + 1) / windup, 0, 1);
      const home = phase === 'recovery' ? MathUtils.clamp((age - windup - active) / 10, 0, 1) : 0;
      const look = forward(strike.yaw);
      const side = right(strike.yaw);
      if (this.isPlayer || strike.spec.motion === 'swing') {
        const swingYaw = strike.yaw + strike.side * MathUtils.lerp(-1.00, 1.00, sweep);
        const line = forward(swingYaw);
        const aimHand = feet.clone().addScaledVector(look, 0.21 * this.scale).addScaledVector(line, 0.32 * this.scale)
          .addScaledVector(side, 0.10).add(high(1.19));
        const aimAxis = line.clone().add(high(MathUtils.lerp(0.12, -0.18, sweep)));
        const weight = prepare * (1 - home);
        hand.lerp(aimHand, weight);
        axis.lerp(aimAxis, weight).normalize();
      } else if (strike.spec.motion === 'bash') {
        hand.addScaledVector(f, -0.20);
        axis = r.clone().add(high(0.28)).normalize();
      } else {
        const pitch = phase === 'windup' ? MathUtils.lerp(1.85, 0.63, Math.max(0, (prepare - 0.68) / 0.32))
          : MathUtils.lerp(0.63, -1.24, sweep);
        const fall = phase === 'windup' ? Math.max(0, (prepare - 0.68) / 0.32) * 0.24 : 0.24 + sweep * 0.65;
        const longStep = strike.spec.motion === 'lunge' ? sweep * 0.54 : 0;
        const aimHand = feet.clone().addScaledVector(look, (0.19 + fall * 0.66) * this.scale + longStep)
          .addScaledVector(side, 0.19 - 0.19 * fall).add(high(1.64 - fall * 0.54));
        const aimAxis = look.clone().multiplyScalar(Math.cos(pitch)).add(high(Math.sin(pitch)));
        const weight = Math.min(1, prepare * 3.4) * (1 - home);
        hand.lerp(aimHand, weight);
        axis.lerp(aimAxis, weight).normalize();
      }
    }

    if (this.stance === 'kneel') hand.y -= 0.46;
    axis.normalize();
    return {
      position: hand.addScaledVector(axis, this.spec.blade.length * 0.5),
      rotation: new Quaternion().setFromUnitVectors(UP, axis),
    };
  }

  private makeFrame(tick = 0): FighterFrame {
    const root = pose(this.body);
    const f = forward(this.yaw);
    const r = right(this.yaw);
    const v = this.body.linvel();
    const drive = this.canAct ? Math.min(1, Math.hypot(v.x, v.z) / 2.1) : 0;
    const leftStep = Math.sin(this.gait);
    const stride = Math.cos(this.gait) * 0.30 * drive;
    const lunge = !this.isPlayer && this.phase(tick) === 'active';
    const forwardLean = this.drillPose === 'transfer' ? 0.38 : Math.min(0.5, drive * 0.24 + (lunge ? 0.32 : 0));
    const feet = new Vector3(root.position.x, root.position.y - this.rootHeight, root.position.z);
    const leftFoot = feet.clone().addScaledVector(r, -0.26 * this.scale).addScaledVector(f, stride + 0.13 + (lunge ? 0.12 : 0));
    const rightFoot = feet.clone().addScaledVector(r, 0.26 * this.scale).addScaledVector(f, -stride - 0.14);
    leftFoot.y += Math.max(0, leftStep) * 0.19 * drive;
    rightFoot.y += Math.max(0, -leftStep) * 0.19 * drive + (lunge ? 0.09 : 0);
    if (this.drillPose === 'transfer') {
      rightFoot.y += 0.18;
      rightFoot.addScaledVector(f, -0.14);
    }
    return { root, blade: pose(this.blade), shield: this.shield && pose(this.shield.body), yaw: this.yaw, leftFoot, rightFoot, lean: forwardLean };
  }
}
