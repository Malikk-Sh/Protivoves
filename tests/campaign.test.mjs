import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { MISSION_ORDER } from '../src/content/campaign.ts';
import { CAMERA_AZIMUTH, ticks } from '../src/content/dry-dock.ts';
import { Gesture } from '../src/engine/input.ts';
import { DryDock } from '../src/game/dry-dock.ts';
import { canPlay, finishMission, hasTessak, newProfile, nextMission, validateProfile } from '../src/save/campaign-save.ts';

const neutral = { x: 0, y: 0 };
const idle = { move: neutral, turn: 0, release: false };
const screenDirection = (angle, strength = 1) => ({
  x: -Math.sin(angle + CAMERA_AZIMUTH) * strength,
  y: Math.cos(angle + CAMERA_AZIMUTH) * strength,
});
const angleTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const planar = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

before(async () => RAPIER.init());

function playMission(id) {
  const run = new DryDock('duel', 'planted', { mission: id });
  const gesture = new Gesture();
  const attackRange = id === 'M04' ? 1.84 : 1.55;
  let prepared = false;
  let steps = 0;
  let side = -1;
  let aim = 0;
  let transitionStart = null;
  const shots = [];
  const seen = new Set();

  for (let step = 0; step < 4200 && !run.outcome; step++) {
    const player = run.player;
    const from = player.at;
    const enemy = run.focusEnemy;
    let move = neutral;
    if (!run.awake || run.gateOpen) {
      const z = run.gateOpen ? run.mission.exitZ + 0.6 : run.mission.combatLine + 0.55;
      const next = run.physics.waypoint(from, new Vector3(0, 0, z), 0.50);
      move = screenDirection(angleTo(from, next));
    } else if (enemy) {
      const to = enemy.at;
      const gap = planar(from, to);
      const waypoint = run.physics.waypoint(from, to, 0.50);
      if (waypoint !== to && !player.strike && player.canAct) {
        move = screenDirection(angleTo(from, waypoint), 0.87);
        steps = 0;
        prepared = false;
      } else if (!player.canAct || player.strike || run.tick < player.recoverUntil) {
        steps = 0;
        prepared = false;
      } else if (!prepared) {
        move = screenDirection(angleTo(from, to), gap > attackRange + 0.25 ? 0.8 : 0.62);
        prepared = gap < attackRange;
      } else if (steps++ < 10) {
        aim = angleTo(from, to);
        move = screenDirection(aim, 0.62);
      } else {
        move = screenDirection(aim + side * Math.PI * 0.49);
        steps = 0;
        side *= -1;
        prepared = false;
      }
    }
    run.step(gesture.sample(move, run.tick + 1, false));
    shots.push(...run.hits.filter(hit => hit.tick === run.tick));
    for (const actor of run.fighters) {
      if (actor.isPlayer) continue;
      seen.add(actor.spec.id);
      if (actor.strike) seen.add(actor.strike.spec.id);
    }
    if (run.bossTransitionStart !== null && transitionStart === null) {
      transitionStart = run.bossTransitionStart;
      assert.equal(run.watchman.hp, 84);
      assert.equal(run.physics.solids.filter(solid => solid.id.startsWith('screen.')).length, 2);
    }
  }
  return { run, shots, seen, transitionStart };
}

test('четыре миссии проходимы подряд с обычной сложностью и открывают тесак', () => {
  let profile = newProfile();
  for (const id of MISSION_ORDER) {
    assert.equal(nextMission(profile), id);
    assert.ok(canPlay(profile, id));
    const { run, shots, seen, transitionStart } = playMission(id);
    try {
      assert.equal(run.outcome?.kind, 'won', id);
      assert.ok(run.player.hp > 0);
      assert.ok(run.player.at.z >= run.mission.exitZ);
      if (id === 'M02') {
        assert.ok(seen.has('E2') && seen.has('E1'));
        assert.ok(seen.has('E2.bash'));
        assert.ok(shots.some(hit => hit.surface === 'shield' && hit.result === 'block' && hit.hpDamage === 0));
      } else if (id === 'M03') {
        assert.ok(seen.has('E3'));
        assert.equal(run.boardingTicks, ticks(26));
        assert.ok(run.boardingFinish >= ticks(26) - 1);
      } else if (id === 'M04') {
        assert.ok(transitionStart);
        assert.equal(run.bossPhase, 2);
        assert.equal(run.watchman.hp, 0);
        assert.equal(run.physics.solids.filter(solid => solid.id.startsWith('screen.')).length, 0);
      }
      profile = finishMission(profile, id, run.outcome.stars, run.difficulty);
      assert.deepEqual(validateProfile(profile), profile);
    } finally {
      run.dispose();
    }
  }
  assert.equal(nextMission(profile), null);
  assert.ok(hasTessak(profile));
  const replay = new DryDock('duel', 'planted', { mission: 'M01', weapon: 'W2' });
  try {
    assert.equal(replay.player.spec.attack.id, 'W2');
    assert.equal(replay.player.spec.blade.length, 0.75);
  } finally {
    replay.dispose();
  }
});

test('часы посадки приостанавливаются при вторжении и окно сбрасывается после очистки', () => {
  const run = new DryDock('duel', 'planted', { mission: 'M03' });
  const place = (actor, x, z) => actor.body.setTranslation({ x, y: actor.rootHeight, z }, true);
  try {
    place(run.player, 0, 17.0);
    run.step(idle);
    const begin = run.boardingTicks;
    assert.equal(begin, 1);
    for (let step = 0; step < ticks(2); step++) {
      place(run.watchman, -2.6, 13.2);
      run.step(idle);
    }
    assert.equal(run.boardingTicks, begin);
    assert.equal(run.intrusionTicks, ticks(2));
    place(run.watchman, -5.4, 9);
    run.step(idle);
    assert.equal(run.intrusionTicks, 0);
    assert.ok(run.boardingTicks > begin);
    for (let step = 0; step < ticks(8) && !run.outcome; step++) {
      place(run.watchman, -2.6, 13.2);
      run.step(idle);
    }
    assert.deepEqual(run.outcome, { kind: 'lost', reason: 'boarding' });
    assert.ok(run.encounterTicks > ticks(9));
    assert.ok(run.fighters.some(actor => actor.spec.id === 'E3'));
  } finally {
    run.dispose();
  }
});

test('повтор миссии объединяет звёзды и сохраняет наивысшую сложность', () => {
  const initial = newProfile();
  assert.equal(canPlay(initial, 'M02'), false);
  assert.equal(hasTessak(initial), false);
  assert.equal(validateProfile({ ...initial, weapon: 'W2' }), null);
  const master = finishMission(initial, 'M01', [true, true, false], 'master');
  const repeated = finishMission(master, 'M01', [true, false, true], 'normal');
  assert.equal(nextMission(repeated), 'M02');
  assert.deepEqual(repeated.completed.M01, { stars: [true, true, true], difficulty: 'master' });
  assert.equal(validateProfile({ ...master, completed: { M02: repeated.completed.M01 } }), null);
});
