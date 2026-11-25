import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { CAMERA_AZIMUTH, DANIL, M01 } from '../src/content/dry-dock.ts';
import { Gesture } from '../src/engine/input.ts';
import { sweep } from '../src/engine/physics.ts';
import { resolveCut } from '../src/game/combat-rules.ts';
import { DryDock } from '../src/game/dry-dock.ts';

const idle = { move: { x: 0, y: 0 }, turn: 0, release: false };
const screenDirection = (yaw, strength = 1) => ({
  x: -Math.sin(yaw + CAMERA_AZIMUTH) * strength,
  y: Math.cos(yaw + CAMERA_AZIMUTH) * strength,
});

before(async () => RAPIER.init());

test('довороты в разные стороны и отпускание распознаются только после шага', () => {
  for (const sign of [-1, 1]) {
    const gesture = new Gesture();
    const forward = { x: 0, y: 1 };
    assert.equal(gesture.sample(forward, 1, false).turn, 0);
    for (let tick = 2; tick <= 11; tick++) gesture.sample(forward, tick, false);
    assert.equal(gesture.sample({ x: -sign, y: 0 }, 12, false).turn, sign);
    assert.equal(gesture.sample(idle.move, 13, true).release, true);
    gesture.reset();
    assert.equal(gesture.sample(idle.move, 14, true).release, false);
  }
});

test('поперечный контакт W1 при 10 м/с даёт разные реакции опоры', () => {
  const side = new Vector3(1, 0, 0);
  const planted = resolveCut(10, DANIL.attack, 1, 1, 0, side, false);
  const transfer = resolveCut(10, DANIL.attack, 1, 1, 0, side, true);
  assert.equal(planted.damage, 20);
  assert.equal(transfer.damage, 20);
  assert.ok(Math.abs(planted.balance - 0.9348) < 0.001);
  assert.ok(Math.abs(transfer.balance - 1.6188) < 0.001);
  assert.equal(planted.reaction, 'stagger');
  assert.equal(transfer.reaction, 'down');
});

test('геометрические запросы ловят быстрые контакты вдоль пути и на дуге', () => {
  const blade = new RAPIER.Capsule(0.45, 0.043);
  const body = new RAPIER.Capsule(0.26, 0.23);
  const frame = (x, y, z, rotation = new Quaternion()) => ({ position: new Vector3(x, y, z), rotation });
  const wall = { shape: new RAPIER.Cuboid(0.05, 1.2, 1.2), before: frame(-0.5, 1, 0), after: frame(-0.5, 1, 0) };
  let crossings = 0;
  for (let index = 0; index < 100; index++) {
    const offset = (index - 50) * 0.003;
    const weapon = { shape: blade, before: frame(-0.86, 1, offset), after: frame(0.85, 1, offset) };
    const target = { shape: body, before: frame(0.15, 1, 0), after: frame(-0.06, 1, 0) };
    const hit = sweep(weapon, target);
    if (!hit) continue;
    crossings++;
    assert.ok(sweep(weapon, wall).fraction < hit.fraction);
    assert.ok(hit.normal.x > 0.5);
  }
  assert.equal(crossings, 100);

  const endRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  const turn = { shape: blade, before: frame(0, 0, 0), after: frame(0, 0, 0, endRotation) };
  const tipTarget = { shape: new RAPIER.Ball(0.037), before: frame(0.32, 0.32, 0), after: frame(0.32, 0.32, 0) };
  const hit = sweep(turn, tipTarget);
  assert.ok(hit && hit.fraction > 0.25 && hit.fraction < 0.75);
});

test('разбор опоры фиксирует реальное касание, реакцию и возвращение в стойку', () => {
  const hits = [];
  for (const stance of ['planted', 'transfer']) {
    const run = new DryDock('drill', stance);
    try {
      const reactions = new Set();
      for (let tick = 0; tick < 155; tick++) {
        run.step(idle);
        reactions.add(run.watchman.stance);
      }
      const damaging = run.hits.filter(hit => hit.hpDamage > 0);
      assert.equal(damaging.length, 1);
      const [hit] = damaging;
      assert.equal(hit.weightState, stance);
      assert.equal(hit.source, 'sweep');
      assert.equal(hit.surface, 'torso');
      assert.equal(hit.hpDamage, 20);
      assert.ok(Math.abs(hit.s - 10) < 0.05);
      assert.equal(run.watchman.hp, 34);
      assert.equal(run.watchman.stance, 'ready');
      if (stance === 'transfer') {
        for (const reaction of ['falling', 'down', 'rising']) assert.ok(reactions.has(reaction), reaction);
      } else assert.ok(reactions.has('stagger'));
      hits.push(hit);
    } finally {
      run.dispose();
    }
  }
  assert.ok(hits[0].point.distanceTo(hits[1].point) < 1e-6);
  assert.equal(hits[0].footSupport, 'both');
  assert.equal(hits[1].footSupport, 'left');
  assert.equal(hits[0].result, 'stagger');
  assert.equal(hits[1].result, 'down');
});

test('реальная встреча лезвий парирует атаку в окне и блокирует её в обычной стойке', () => {
  for (const release of [false, true]) {
    const run = new DryDock();
    try {
      let firstStrike = false;
      for (let tick = 0; tick < 250; tick++) {
        let intent = idle;
        const attack = run.watchman.strike;
        if (attack) {
          firstStrike = true;
          const age = run.tick - attack.start;
          if (age >= 23 && age < 34) intent = { ...idle, move: screenDirection(0, 0.3) };
          if (age === 34) intent = { ...idle, release };
        } else if (!firstStrike && run.player.at.z < 9.15) {
          intent = { ...idle, move: screenDirection(0) };
        }
        run.step(intent);
        if (run.hits.some(hit => hit.surface === 'blade')) break;
      }
      const contact = run.hits.find(hit => hit.surface === 'blade');
      assert.equal(contact?.result, release ? 'parry' : 'block');
      assert.equal(run.player.hp, 100);
      assert.equal(run.parries, release ? 1 : 0);
    } finally {
      run.dispose();
    }
  }
});

test('десять дуэлей от входа в док до результата с вводом жестов', context => {
  const profiles = [
    [0, 0.55], [0, 0.68], [0, 0.87], [-0.10, 0.55], [-0.10, 0.68],
    [0.18, 0.68], [-0.18, 0.87], [0.30, 0.68], [-0.30, 0.87],
  ];
  const tickCosts = [];
  for (const [offset, strength] of profiles) {
    const run = new DryDock();
    const gesture = new Gesture();
    let prime = 0;
    let prepared = false;
    let side = -1;
    let aim = 0;
    try {
      for (let tick = 0; tick < 1250 && !run.outcome; tick++) {
        const player = run.player;
        const opponent = run.watchman;
        const from = player.at;
        const to = opponent.at;
        const toward = Math.atan2(to.x - from.x, to.z - from.z);
        const distance = Math.hypot(to.x - from.x, to.z - from.z);
        let move = idle.move;
        if (!run.awake) move = screenDirection(0);
        else if (run.gateOpen) move = screenDirection(Math.atan2(-from.x, 21.64 - from.z), 0.95);
        else if (!player.canAct || player.strike || run.tick < player.recoverUntil) {
          prepared = false;
          prime = 0;
        } else if (!prepared) {
          move = screenDirection(toward + offset, distance > 1.8 ? 0.8 : strength);
          prepared = distance <= 1.65;
        } else if (prime < 10) {
          aim = toward + offset;
          move = screenDirection(aim, strength);
          prime++;
        } else {
          move = screenDirection(aim + side * Math.PI * 0.49);
          prime = 0;
          side *= -1;
          prepared = false;
        }
        run.step(gesture.sample(move, run.tick + 1, false));
        tickCosts.push(run.lastTickMs);
      }
      assert.equal(run.outcome?.kind, 'won', `доворот от ${offset}, сила ${strength}`);
      assert.equal(run.watchman.hp, 0);
      assert.ok(run.gateOpen);
      assert.ok(run.player.at.z >= M01.exitZ);
      const wounds = run.hits.filter(hit => hit.hpDamage > 0);
      const keys = wounds.map(hit => `${hit.strikeId}/${hit.targetId}`);
      assert.equal(new Set(keys).size, keys.length);
    } finally {
      run.dispose();
    }
  }

  const lost = new DryDock();
  try {
    for (let i = 0; i < 1500 && !lost.outcome; i++) {
      lost.step({ ...idle, move: screenDirection(0) });
      tickCosts.push(lost.lastTickMs);
    }
    assert.deepEqual(lost.outcome, { kind: 'lost', reason: 'hp' });
    assert.equal(lost.player.hp, 0);
    const finalTick = lost.tick;
    lost.step(idle);
    assert.equal(lost.tick, finalTick);
  } finally {
    lost.dispose();
  }

  const repeat = new DryDock();
  try {
    assert.equal(repeat.tick, 0);
    assert.equal(repeat.gateOpen, false);
    assert.equal(repeat.player.hp, 100);
    assert.notEqual(repeat.runId, lost.runId);
  } finally {
    repeat.dispose();
  }
  tickCosts.sort((a, b) => a - b);
  context.diagnostic(`9 побед, 1 поражение. p95 симуляции в Node без рендера — ${tickCosts[Math.floor(tickCosts.length * 0.95)].toFixed(2)} мс.`);
});
