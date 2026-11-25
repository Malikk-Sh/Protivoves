import RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, Quaternion, Vector3 } from 'three';
import {
  ACTORS, DIFFICULTIES, MASTER_LUNGE, MASTER_PHASE_HP, MASTER_SWEEP, MISSIONS, SHIELD_BASH, WEAPONS,
} from '../content/campaign.ts';
import type { DifficultyId, Mission, MissionId, Spawn, WeaponId } from '../content/campaign.ts';
import { CAMERA_AZIMUTH, M01, SUPPORT_DRILL, ticks } from '../content/dry-dock.ts';
import { angleDelta } from '../engine/input.ts';
import type { Intent } from '../engine/input.ts';
import { DockPhysics, UP, forward, interpolate, pointSpeed, pose, right, sweep } from '../engine/physics.ts';
import type { Contact, Pose, Solid, Volume } from '../engine/physics.ts';
import { CUT_MIN, parryAngle, resolveCut } from './combat-rules.ts';
import { Fighter } from './fighter.ts';
import type { FighterFrame, FootSupport, Strike } from './fighter.ts';

export type RunMode = 'duel' | 'drill' | 'preview';
export type DrillPose = 'planted' | 'transfer';
export type HitSurface = 'blade' | 'shield' | 'world' | 'torso' | 'limb';
export type HitResult = 'glance' | 'block' | 'parry' | 'hit' | 'stagger' | 'down';

export interface HitEvent {
  runId: number;
  tick: number;
  impactFraction: number;
  source: 'sweep' | 'solver';
  strikeId: string;
  weaponId: string;
  attackerId: string;
  targetId: string;
  surface: HitSurface;
  point: Vector3;
  normal: Vector3;
  bladeAxis: Vector3;
  s: number;
  hpDamage: number;
  balanceForce: number;
  footSupport: FootSupport;
  weightState: DrillPose;
  result: HitResult;
}

export type Outcome = { kind: 'won'; stars: [boolean, boolean, boolean] } |
  { kind: 'lost'; reason: 'hp' | 'edge' | 'both' | 'boarding' } |
  { kind: 'error' };

export interface RunOptions {
  mission?: MissionId;
  weapon?: WeaponId;
  difficulty?: DifficultyId;
}

type Target = { id: string; surface: HitSurface; volume: Volume; fighter?: Fighter; collider?: RAPIER.Collider };

type Candidate = Contact & {
  attacker: Fighter;
  strike: Strike | null;
  weapon: Volume;
  target: Target;
  active: boolean;
  solver: boolean;
  source: HitEvent['source'];
};

type Enemy = {
  actor: Fighter;
  spawn: Spawn;
  shown: boolean;
  active: boolean;
  nextAttack: number;
  advance: number;
  attacks: number;
  route: Vector3 | null;
};

const planarDistance = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
const directionTo = (from: Vector3, to: Vector3) => Math.atan2(to.x - from.x, to.z - from.z);
const contactPriority: Record<HitSurface, number> = { world: 0, shield: 1, blade: 2, torso: 3, limb: 4 };
const facing = forward(-CAMERA_AZIMUTH);
const lateral = right(-CAMERA_AZIMUTH);
const still = new Vector3();
let runCounter = 0;

export class DryDock {
  readonly runId = ++runCounter;
  readonly mission: Mission;
  readonly difficulty: DifficultyId;
  readonly weapon: WeaponId;
  readonly physics: DockPhysics;
  readonly player: Fighter;
  readonly watchman: Fighter;
  readonly hits: HitEvent[] = [];
  readonly mode: RunMode;
  readonly drillPose: DrillPose;
  tick = 0;
  awake = false;
  gateOpen = false;
  outcome: Outcome | null = null;
  parries = 0;
  hint = 0;
  lastTickMs = 0;
  boardingTicks = 0;
  intrusionTicks = 0;
  boardingFinish: number | null = null;
  bossPhase: 1 | 2 = 1;
  bossTransitionStart: number | null = null;
  private entered: number | null = null;
  private firstContact: number | null = null;
  private hitCount = 0;
  private shieldDown = false;
  private pushedOut = false;
  private recoveryKnees = new Set<string>();
  private shoves = new Map<string, number>();
  private hintSince = 0;
  private queuedTurn: { side: -1 | 1; expiry: number; yaw: number } | null = null;
  private contactsAt = new Map<string, number>();
  private torsoShapes = new Map<number, RAPIER.Capsule>();
  private limbShapes = new Map<number, RAPIER.Capsule>();
  private dummy?: Target;
  private enemies: Enemy[];
  private owner: Fighter | null = null;
  private permitAttackAt = 0;

  constructor(mode: RunMode = 'duel', drillPose: DrillPose = 'planted', options: RunOptions = {}) {
    this.mode = mode;
    this.drillPose = drillPose;
    this.mission = MISSIONS[mode === 'duel' ? options.mission ?? 'M01' : 'M01'];
    this.weapon = mode === 'duel' ? options.weapon ?? 'W1' : 'W1';
    this.difficulty = options.difficulty ?? 'normal';
    this.physics = new DockPhysics(this.mission);
    const player = mode === 'duel' ? this.mission.player : SUPPORT_DRILL.player;
    const spec = WEAPONS[this.weapon].fighter;
    this.player = new Fighter(spec, spec.id, this.physics, player[0], player[1], 0, true);
    this.enemies = this.mission.threats.map((spawn, index) => {
      const [x, z] = mode === 'preview' ? [-0.55, 13.30] : mode === 'drill' ? SUPPORT_DRILL.enemy : spawn.at;
      const actor = new Fighter(ACTORS[spawn.actor], spawn.id, this.physics, x, z, Math.PI, false);
      const shown = index === 0 && (mode !== 'duel' || this.mission.id === 'M01' || this.mission.id === 'M04');
      if (!shown) actor.setPresent(false);
      return { actor, spawn, shown, active: false, nextAttack: 0, advance: 0, attacks: 0, route: null };
    });
    this.watchman = this.enemies[0].actor;
    const dummy = this.mission.dummy;
    if (dummy) {
      const location = { position: new Vector3(dummy[0], 0.95, dummy[1]), rotation: new Quaternion() };
      this.dummy = {
        id: 'm01.dummy', surface: 'torso',
        volume: { shape: new RAPIER.Capsule(0.33, 0.27), before: location, after: location },
      };
    }
    if (mode === 'drill') {
      this.watchman.drillPose = drillPose;
      this.awake = true;
    }
  }

  get fighters() { return [this.player, ...this.enemies.filter(enemy => enemy.shown).map(enemy => enemy.actor)]; }
  get focusEnemy() {
    const from = this.player.frame.root.position;
    const live = this.enemies.filter(enemy => enemy.shown && enemy.actor.alive);
    return live.sort((a, b) => {
      const phaseWeight = (actor: Fighter) => actor.phase(this.tick) === 'windup' ? -1.5 : 0;
      return planarDistance(a.actor.frame.root.position, from) + phaseWeight(a.actor) -
        planarDistance(b.actor.frame.root.position, from) - phaseWeight(b.actor);
    })[0]?.actor ?? null;
  }

  get screensProgress() {
    if (this.bossTransitionStart === null) return this.bossPhase === 2 ? 1 : 0;
    return MathUtils.clamp((this.tick - this.bossTransitionStart) / ticks(1.2), 0, 1);
  }

  get encounterTicks() { return this.entered === null ? 0 : this.tick - this.entered; }

  clearInput() {
    this.queuedTurn = null;
    this.player.guardUntil = 0;
  }

  step(intent: Intent) {
    if (this.outcome || this.mode === 'preview') return;
    const start = performance.now();
    const tick = ++this.tick;
    if (this.mode === 'duel') this.advanceEncounter();
    const fighters = this.fighters;
    for (const actor of fighters) {
      const from = actor.at;
      const nearby = fighters.some(other => actor !== other && other.alive &&
        planarDistance(from, other.at) < actor.rootRadius + other.rootRadius + 0.19);
      actor.update(tick, !nearby);
    }
    if (this.mode === 'duel') {
      this.controlPlayer(intent);
      if (this.owner && (!this.owner.alive || !this.owner.canAct ||
        !['windup', 'active'].includes(this.owner.phase(tick)))) {
        this.owner = null;
        this.permitAttackAt = tick + ticks(DIFFICULTIES[this.difficulty].gap);
      }
      for (const enemy of this.enemies) if (enemy.shown) this.controlEnemy(enemy);
    } else {
      this.player.move(still);
      this.watchman.move(still);
      if (tick === ticks(SUPPORT_DRILL.strikeAt)) this.player.startStrike(tick, 1, 0);
    }

    const cratesBefore = this.physics.crates.map(crate => pose(crate.body));
    for (const fighter of fighters) fighter.driveWeapon(tick);
    this.physics.world.step();
    for (const fighter of fighters) fighter.refreshFrame(tick);
    this.contacts(fighters, cratesBefore);
    this.updateMission(intent);
    if (fighters.some(fighter => !Number.isFinite(fighter.at.lengthSq()))) this.outcome = { kind: 'error' };
    this.lastTickMs = performance.now() - start;
  }

  settle() {
    if (this.outcome?.kind !== 'lost') return;
    for (const fighter of this.fighters) {
      fighter.cancelStrike(this.tick, 0.25);
      fighter.driveWeapon(this.tick);
      fighter.move(still);
    }
    this.physics.world.step();
    for (const actor of this.fighters) actor.refreshFrame(this.tick);
  }

  dispose() {
    this.physics.world.free();
  }

  inBoardingZone(at: Vector3) {
    const zone = this.mission.boarding;
    return Boolean(zone && at.y > -0.2 && Math.abs(at.x) <= zone.x && at.z >= zone.minZ && at.z <= zone.maxZ);
  }

  private advanceEncounter() {
    const zone = this.mission.boarding;
    const player = this.player.at;
    if (this.entered === null && (zone ? this.inBoardingZone(player) : player.z >= this.mission.combatLine)) {
      this.entered = this.tick;
      this.awake = true;
    }
    if (this.entered === null) return;
    for (const enemy of this.enemies) {
      if (enemy.active) continue;
      const timing = ticks(enemy.spawn.afterSeconds);
      const ready = enemy.spawn.when === 'clearance' ? (
        this.watchman.hp <= this.watchman.spec.hp - 28 ||
        (this.firstContact !== null && this.tick - this.firstContact >= timing)
      ) : this.encounterTicks >= timing;
      if (!ready) continue;
      enemy.shown = true;
      enemy.active = true;
      enemy.nextAttack = this.tick + ticks(0.15);
      enemy.actor.setPresent(true);
    }
  }

  private controlPlayer(intent: Intent) {
    const player = this.player;
    const direction = facing.clone().multiplyScalar(intent.move.y).addScaledVector(lateral, intent.move.x);
    const opponent = this.awake ? this.focusEnemy : null;
    if (intent.turn) {
      const enemyAngle = opponent && planarDistance(player.at, opponent.at) < 3.4
        ? directionTo(player.at, opponent.at) : player.yaw;
      const assist = MathUtils.clamp(angleDelta(player.yaw, enemyAngle), -0.244, 0.244);
      this.queuedTurn = { side: intent.turn, expiry: this.tick + ticks(0.10), yaw: player.yaw + assist };
    }
    const turn = this.queuedTurn;
    if (turn) {
      if (this.tick >= turn.expiry || player.startStrike(this.tick, turn.side, turn.yaw)) this.queuedTurn = null;
    }
    if (intent.release) player.openGuard(this.tick);
    const moving = direction.lengthSq() > 0.014;
    if (moving) {
      player.guardUntil = 0;
      if (player.canAct) player.turnToward(Math.atan2(direction.x, direction.z), (player.strike ? 620 : 540) * Math.PI / 180);
    } else if (!player.strike && player.canAct && player.guardUntil <= this.tick &&
      opponent && planarDistance(player.at, opponent.at) < 3.4) {
      const delta = angleDelta(player.yaw, directionTo(player.at, opponent.at));
      if (Math.abs(delta) < 0.244) player.turnToward(player.yaw + delta, 1.2);
    }
    player.move(direction.multiplyScalar(player.spec.pace * (player.strike ? 0.86 : 1)));
  }

  private controlEnemy(enemy: Enemy) {
    const actor = enemy.actor;
    if (!actor.alive || !actor.canAct || !enemy.active || this.bossTransitionStart !== null) {
      actor.move(still);
      return;
    }

    const tick = this.tick;
    const from = actor.at;
    const player = this.player.at;
    const distance = planarDistance(from, player);
    const yaw = directionTo(from, player);
    const phase = actor.phase(tick);
    const goal = new Vector3();
    if (phase === 'idle') {
      if (enemy.route === null) actor.turnToward(yaw, 6.7);
      if (tick % 6 === 0) {
        const zone = this.mission.boarding;
        const goToBoarding = zone && distance > 2.6 && !this.gateOpen;
        const objective = goToBoarding ? new Vector3(0, 0, zone.minZ + 2.1) : player;
        const waypoint = this.physics.waypoint(from, objective, actor.rootRadius + 0.17);
        enemy.route = waypoint === objective && !goToBoarding ? null : waypoint;
        const reach = actor.spec.attack.range?.[1] ?? 1.54;
        enemy.advance = distance > reach - 0.19 ? 1 : distance < 0.83 * actor.scale ? -0.37 : 0;
        if (goToBoarding) enemy.advance = planarDistance(from, objective) > 0.55 ? 1 : 0;
        if (waypoint !== objective) enemy.advance = 1;
        if (!enemy.route && tick >= enemy.nextAttack && tick >= this.permitAttackAt &&
          !this.owner && Math.abs(angleDelta(actor.yaw, yaw)) < 0.27) {
          const attack = this.chooseAttack(enemy, distance);
          if (attack && actor.startStrike(tick, enemy.attacks % 2 ? -1 : 1, actor.yaw, attack)) {
            enemy.attacks++;
            this.owner = actor;
            enemy.nextAttack = tick + ticks(Math.max(1.62, attack.windup + attack.active + attack.recovery));
            enemy.advance = 0;
          }
        }
      }
      if (enemy.route && planarDistance(from, enemy.route) > 0.08) actor.turnToward(directionTo(from, enemy.route), 6.7);
      goal.copy(forward(actor.yaw)).multiplyScalar(actor.spec.pace * enemy.advance);
    } else if (actor.strike && !actor.strike.blocked) {
      const attack = actor.strike.spec;
      const age = tick - actor.strike.start;
      if (phase === 'windup' && age < ticks(attack.windup * 2 / 3)) {
        actor.turnToward(yaw, 3.6);
        actor.strike.yaw = actor.yaw;
      }
      if (phase === 'active' || (phase === 'windup' && age < 10 && distance > 1.26)) {
        const advance = attack.motion === 'lunge' ? 2.75 : attack.motion === 'bash' ? 1.7 : 1.14;
        goal.copy(forward(actor.strike.yaw)).multiplyScalar(phase === 'active' ? advance : 0.38);
      }
    }
    actor.move(goal);
  }

  private chooseAttack(enemy: Enemy, distance: number) {
    const base = enemy.actor.spec.attack;
    let sequence = [base];
    if (enemy.spawn.actor === 'E2') sequence = enemy.attacks % 2 ? [base, SHIELD_BASH] : [SHIELD_BASH, base];
    if (enemy.spawn.actor === 'B1') {
      sequence = enemy.attacks % 2 ? [MASTER_SWEEP, base] : [base, MASTER_SWEEP];
      if (this.bossPhase === 2 && distance >= 2.05) sequence.unshift(MASTER_LUNGE);
    }
    const chosen = sequence.find(spec => {
      const [min, max] = spec.range ?? [0.61, 1.54];
      return distance >= min && distance <= max;
    });
    if (!chosen) return null;
    const rate = DIFFICULTIES[this.difficulty].windup;
    return rate === 1 ? chosen : { ...chosen, windup: Math.max(0.32, chosen.windup * rate) };
  }

  private contacts(fighters: Fighter[], cratesBefore: Pose[]) {
    const candidates: Candidate[] = [];
    const tick = this.tick;
    const volumes = fighters.map(fighter => {
      const bash = fighter.strike?.spec.motion === 'bash' && fighter.phase(tick) === 'active';
      const collider = bash && fighter.shield ? fighter.shield.collider : fighter.bladeCollider;
      const weapon: Volume = {
        shape: collider.shape,
        before: bash && fighter.previous.shield ? fighter.previous.shield : fighter.previous.blade,
        after: bash && fighter.frame.shield ? fighter.frame.shield : fighter.frame.blade,
      };
      return { collider, weapon };
    });

    for (const [index, attacker] of fighters.entries()) {
      if (!attacker.alive || !attacker.canAct) continue;
      const { collider, weapon } = volumes[index];
      const active = attacker.phase(tick) === 'active';
      const strike = attacker.strike;
      const targets: Target[] = [];
      for (const [otherIndex, opponent] of fighters.entries()) {
        if (opponent === attacker || !opponent.alive ||
          (!active && !attacker.isPlayer && !opponent.isPlayer) ||
          planarDistance(attacker.at, opponent.at) >= 3.0 + (attacker.scale - 1) * 1.5) continue;
        if (active && opponent.canAct && (index < otherIndex || opponent.phase(tick) !== 'active')) {
          targets.push({
            id: opponent.id, surface: 'blade', volume: volumes[otherIndex].weapon,
            fighter: opponent, collider: volumes[otherIndex].collider,
          });
        }
        if (active && attacker.isPlayer && opponent.canAct && opponent.shield && opponent.frame.shield && opponent.previous.shield) {
          targets.push({
            id: opponent.id, surface: 'shield', fighter: opponent, collider: opponent.shield.collider,
            volume: { shape: opponent.shield.collider.shape, before: opponent.previous.shield, after: opponent.frame.shield },
          });
        }
        targets.push(...this.targetBody(opponent));
      }
      if (this.dummy && planarDistance(attacker.at, this.dummy.volume.after.position) < 2.4) targets.push(this.dummy);
      if (active || attacker.moving) {
        for (const solid of this.physics.solids) {
          if (this.nearSolid(solid, weapon)) targets.push({
            id: solid.id, surface: 'world', collider: solid.collider,
            volume: { shape: solid.collider.shape, before: solid.pose, after: solid.pose },
          });
        }
        for (const [index, crate] of this.physics.crates.entries()) {
          const after = pose(crate.body);
          if (planarDistance(after.position, weapon.after.position) > 1.25) continue;
          targets.push({
            id: `crate.${index}`, surface: 'world', collider: crate.collider,
            volume: { shape: crate.collider.shape, before: cratesBefore[index], after },
          });
        }
      }

      for (const target of targets) {
        const swept = sweep(weapon, target.volume);
        const solver = target.collider && active ? this.physics.solverContact(collider, target.collider) : null;
        const contact = swept ?? solver;
        if (contact) candidates.push({
          ...contact, attacker, weapon, target, active, strike, source: swept ? 'sweep' : 'solver', solver: Boolean(solver),
        });
      }
    }

    candidates.sort((a, b) => a.fraction - b.fraction || a.attacker.id.localeCompare(b.attacker.id));
    for (let start = 0; start < candidates.length;) {
      let end = start + 1;
      while (end < candidates.length && candidates[end].fraction - candidates[start].fraction <= 0.025) end++;
      const group = candidates.slice(start, end).sort((a, b) =>
        contactPriority[a.target.surface] - contactPriority[b.target.surface] || a.fraction - b.fraction);
      const impacts: (() => void)[] = [];
      for (const contact of group) this.resolve(contact, impacts);
      for (const apply of impacts) apply();
      start = end;
    }
  }

  private targetBody(fighter: Fighter): Target[] {
    const scale = fighter.scale;
    const anatomy = (frame: FighterFrame, limb?: 'left' | 'right'): Pose => {
      if (limb) {
        const foot = limb === 'left' ? frame.leftFoot : frame.rightFoot;
        return { position: foot.clone().lerp(frame.root.position, 0.44), rotation: frame.root.rotation };
      }
      const center = frame.root.position.clone()
        .add(new Vector3(0, 1.16 * scale - fighter.rootHeight - (fighter.stance === 'kneel' ? 0.37 : 0), 0)
          .applyQuaternion(frame.root.rotation));
      return { position: center, rotation: frame.root.rotation };
    };
    if (!this.torsoShapes.has(scale)) this.torsoShapes.set(scale, new RAPIER.Capsule(0.27 * scale, 0.23 * scale));
    if (!this.limbShapes.has(scale)) this.limbShapes.set(scale, new RAPIER.Capsule(0.17 * scale, 0.13 * scale));
    const torso: Target = {
      id: fighter.id, fighter, surface: 'torso',
      volume: { shape: this.torsoShapes.get(scale)!, before: anatomy(fighter.previous), after: anatomy(fighter.frame) },
    };
    if (!fighter.canAct) return [torso];
    return [torso, ...(['left', 'right'] as const).map((limb): Target => ({
      id: fighter.id, fighter, surface: 'limb',
      volume: { shape: this.limbShapes.get(scale)!, before: anatomy(fighter.previous, limb), after: anatomy(fighter.frame, limb) },
    }))];
  }

  private nearSolid(solid: Solid, blade: Volume) {
    const a = blade.before.position;
    const b = blade.after.position;
    const c = solid.pose.position;
    return Math.abs((a.x + b.x) * 0.5 - c.x) <= solid.half.x + 1.08 &&
      Math.abs((a.y + b.y) * 0.5 - c.y) <= solid.half.y + 1.08 &&
      Math.abs((a.z + b.z) * 0.5 - c.z) <= solid.half.z + 1.08;
  }

  private resolve(contact: Candidate, impacts: (() => void)[]) {
    const { attacker, target, strike, active } = contact;
    const defender = target.fighter;
    if (strike?.blocked || (defender && !defender.alive)) return;
    const bladeFrame = interpolate(contact.weapon.before, contact.weapon.after, contact.fraction);
    const axis = UP.clone().applyQuaternion(bladeFrame.rotation);
    const relative = pointSpeed(contact.weapon, contact).sub(pointSpeed(target.volume, contact));
    const transverse = relative.clone().addScaledVector(axis, -relative.dot(axis));
    const bash = strike?.spec.motion === 'bash';
    const closing = relative.dot(contact.normal);
    const approach = bash ? Math.max(0, relative.dot(forward(strike.yaw))) : 0;
    const speed = bash ? Math.min(10, 2.05 * approach) : transverse.length();
    const record = (result: HitResult, hpDamage = 0, balanceForce = 0) => {
      this.hits.push({
        runId: this.runId, tick: this.tick, impactFraction: contact.fraction, source: contact.source,
        strikeId: strike?.id ?? '', weaponId: strike?.spec.id ?? attacker.spec.attack.id,
        attackerId: attacker.id, targetId: target.id, surface: target.surface,
        point: contact.point, normal: contact.normal, bladeAxis: axis, s: speed, hpDamage, balanceForce,
        footSupport: defender?.support ?? 'none', weightState: defender?.transfer ? 'transfer' : 'planted', result,
      });
      if (this.hits.length > 128) this.hits.shift();
      if (this.firstContact === null && defender && defender.isPlayer !== attacker.isPlayer &&
        (attacker === this.watchman || defender === this.watchman)) this.firstContact = this.tick;
    };

    if (active && target.surface === 'blade' && defender && strike) {
      if (!contact.solver && closing < -0.18) return;
      const defenderAxis = UP.clone().applyQuaternion(interpolate(
        target.volume.before, target.volume.after, contact.fraction).rotation);
      const parry = !bash && defender.isPlayer && this.tick < defender.guardUntil &&
        defender.support !== 'none' && parryAngle(axis, defenderAxis, DIFFICULTIES[this.difficulty].parryDeviation);
      if (parry) {
        this.parries++;
        defender.guardUntil = 0;
      }
      attacker.cancelStrike(this.tick, parry ? (attacker.spec.id === 'B1' ? 0.86 : 0.56) : 0.29);
      if (defender.phase(this.tick) === 'active') defender.cancelStrike(this.tick, 0.24);
      if (!contact.solver) {
        attacker.recoil(contact.normal);
        defender.recoil(contact.normal.clone().negate());
      }
      record(parry ? 'parry' : 'block');
      return;
    }

    if ((target.surface === 'world' || target.surface === 'shield') && active && strike && (closing > 0.18 || contact.solver)) {
      const recovery = attacker.spec.id === 'B1' ? strike.spec.recovery : 0.22;
      attacker.cancelStrike(this.tick, recovery);
      if (!contact.solver) attacker.recoil(contact.normal);
      record('block');
      return;
    }

    if (!active || !strike || target.surface === 'world' || target.surface === 'shield' ||
      closing < 0.10 || (bash ? approach < 0.8 : speed < CUT_MIN)) {
      const key = `${attacker.id}:${target.id}:${target.surface}`;
      if (speed > 0.42 && closing > 0.12 && this.tick - (this.contactsAt.get(key) ?? -30) >= 16) {
        this.contactsAt.set(key, this.tick);
        record('glance');
      }
      return;
    }
    if (strike.hit.has(target.id) || defender?.groundedHit || defender?.stance === 'rising') return;
    strike.hit.add(target.id);
    if (!defender) {
      record('hit');
      attacker.recoil(contact.normal);
      return;
    }
    if (defender.spec.id === 'B1' && this.bossTransitionStart !== null) return;

    const damageScale = defender.isPlayer ? DIFFICULTIES[this.difficulty].damage : attacker.isPlayer ? 1 : 0.35;
    const zone = target.surface === 'limb' ? 0.72 : 1;
    const impulse = bash ? forward(strike.yaw) : transverse;
    const cut = resolveCut(speed, strike.spec, zone, defender.spec.resistance, defender.yaw, impulse,
      defender.transfer, damageScale, bash ? MathUtils.clamp((approach - 0.8) / 4.2, 0, 1) : undefined);
    const recovering = defender.strike && defender.phase(this.tick) === 'recovery' ? defender.strike : null;
    const boss = defender.spec.id === 'B1';
    const balance = cut.balance * (boss && recovering?.spec.id === 'B1A' ? 1.10 : boss && recovering?.spec.id === 'B1C' ? 1.12 : 1);
    const grounded = defender.onFloor;
    if (grounded) defender.groundedHit = true;
    const reaction = grounded || defender.stance === 'kneel' ? 'hit' :
      balance >= (boss ? 1.40 : 1.14) ? 'down' : balance >= 0.58 ? 'stagger' : 'hit';
    const hpLimit = boss && this.bossPhase === 1 ? defender.hp - MASTER_PHASE_HP : defender.hp;
    const damage = Math.max(0, Math.min(hpLimit, grounded ? Math.round(cut.damage * 0.4) : cut.damage));
    record(reaction, damage, balance);
    impacts.push(() => {
      defender.hp = Math.max(boss && this.bossPhase === 1 ? MASTER_PHASE_HP : 0, defender.hp - damage);
      if (damage > 0 && defender.isPlayer) this.hitCount++;
      if (attacker.isPlayer && damage > 0) {
        if (defender.spec.id === 'E2' && defender.transfer && reaction === 'down') this.shieldDown = true;
        if (boss && reaction === 'down' && recovering) this.recoveryKnees.add(recovering.id);
        if (this.inBoardingZone(defender.at) && balance >= 0.58) this.shoves.set(defender.id, this.tick + ticks(0.46));
      }
      defender.react(reaction, impulse, balance, this.tick);
    });
  }

  private updateMission(intent: Intent) {
    if (this.mode !== 'duel') return;
    const player = this.player;
    if (player.at.y < -2.4) {
      this.outcome = { kind: 'lost', reason: 'edge' };
      return;
    }
    const cleared = this.enemies.every(enemy => enemy.active && (!enemy.actor.alive || enemy.actor.at.y < -2.4));
    if (!player.alive) {
      this.outcome = { kind: 'lost', reason: cleared ? 'both' : 'hp' };
      return;
    }
    if (this.mission.id === 'M04' && this.bossPhase === 1 && this.watchman.hp <= MASTER_PHASE_HP) {
      if (this.bossTransitionStart === null) {
        this.bossTransitionStart = this.tick;
        this.watchman.cancelStrike(this.tick, 1.2);
      } else if (this.screensProgress === 1) {
        this.bossPhase = 2;
        this.bossTransitionStart = null;
        this.physics.foldScreens();
      }
    }
    const zone = this.mission.boarding;
    if (zone && this.awake && this.boardingFinish === null) {
      this.updateBoarding();
      if (this.intrusionTicks >= ticks(zone.intrusionSeconds)) {
        this.outcome = { kind: 'lost', reason: 'boarding' };
        return;
      }
      if (this.boardingTicks >= ticks(zone.cleanSeconds)) this.boardingFinish = this.encounterTicks;
    }
    const objective = zone ? this.boardingFinish !== null : cleared;
    if (objective && !this.gateOpen) {
      this.gateOpen = true;
      this.physics.openGate();
    }
    if (this.gateOpen && player.at.z >= this.mission.exitZ && Math.abs(player.at.x) <= this.mission.exitHalfWidth) {
      this.outcome = { kind: 'won', stars: this.awardStars() };
      return;
    }
    if (this.mission.id !== 'M01') return;
    const signaled = [
      Math.hypot(intent.move.x, intent.move.y) > 0.5,
      Boolean(player.strike),
      player.guardUntil > this.tick,
      this.hits.some(hit => hit.result === 'down' && hit.attackerId === player.id),
    ][this.hint];
    if (this.hint < 4 && (signaled || this.tick - this.hintSince >= ticks(4))) {
      this.hint++;
      this.hintSince = this.tick;
    }
  }

  private updateBoarding() {
    let blocked = false;
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const inZone = this.inBoardingZone(enemy.actor.at);
      if (enemy.actor.alive && inZone) blocked = true;
      const expires = this.shoves.get(enemy.actor.id);
      if (expires === undefined) continue;
      if (expires < this.tick) this.shoves.delete(enemy.actor.id);
      else if (!inZone) {
        this.pushedOut = true;
        this.shoves.delete(enemy.actor.id);
      }
    }
    if (blocked) this.intrusionTicks++;
    else {
      this.intrusionTicks = 0;
      this.boardingTicks++;
    }
  }

  private awardStars(): [boolean, boolean, boolean] {
    switch (this.mission.id) {
      case 'M01': return [true, this.player.hp >= M01.healthForStar, this.parries > 0];
      case 'M02': return [true, this.hitCount <= 2, this.shieldDown];
      case 'M03': return [true, (this.boardingFinish ?? Infinity) <= ticks(38), this.pushedOut];
      case 'M04': return [true, this.player.hp >= 50, this.recoveryKnees.size >= 2];
    }
  }
}
