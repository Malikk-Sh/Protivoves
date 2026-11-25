import {
  ACESFilmicToneMapping, BufferAttribute, BufferGeometry, Color, DirectionalLight, Fog, Group,
  HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, PCFShadowMap,
  MathUtils, PerspectiveCamera, PlaneGeometry, PointLight, RingGeometry, Scene, Vector3, WebGLRenderer,
} from 'three';
import type { MissionId } from '../content/campaign.ts';
import { CAMERA_AZIMUTH, CAMERA_TILT, ticks } from '../content/dry-dock.ts';
import type { DryDock, HitEvent } from '../game/dry-dock.ts';
import { DockScenery } from './dock-scenery.ts';
import { FighterModel } from './fighter-model.ts';
import { forward, interpolate, right } from './physics.ts';

const upwind = new Vector3(0, 0, 1);
const lightOffset = new Vector3(-4.8, 9, -5.6);

type Spark = { position: Vector3; direction: Vector3; life: number };

export class DockView {
  readonly renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(46, 1, 0.12, 102);
  private scenery: DockScenery | null = null;
  private arenas = new Map<MissionId, DockScenery>();
  private models = new Map<string, FighterModel>();
  private light = new DirectionalLight(0xffdeb7, 2.25);
  private target = new Vector3();
  private telegraph = new Group();
  private line = new Group();
  private arc = new Group();
  private warning = new MeshBasicMaterial({
    color: 0xffae51, transparent: true, opacity: 0.48, depthWrite: false, toneMapped: false,
  });
  private warningFill = new MeshBasicMaterial({
    color: 0xe99a36, transparent: true, opacity: 0.13, depthWrite: false, toneMapped: false,
  });
  private footMarkers: Mesh[] = [];
  private support = new MeshBasicMaterial({ color: 0x9de0c6, transparent: true, opacity: 0.75, depthWrite: false });
  private raised = new MeshBasicMaterial({ color: 0xffbd67, transparent: true, opacity: 0.58, depthWrite: false });
  private sparkPositions = new Float32Array(36 * 6);
  private sparkGeometry = new BufferGeometry();
  private sparks: Spark[] = [];
  private lastRun = -1;
  private cameraKick = 0;
  private reduced = false;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!context) throw new Error('WebGL 2 недоступен');
    this.renderer = new WebGLRenderer({ canvas, context, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.17;
    this.scene.background = new Color(0x385463);
    this.scene.fog = new Fog(0x385463, 14.5, 64);

    this.light.castShadow = true;
    this.light.shadow.mapSize.set(1024, 1024);
    this.light.shadow.camera.left = this.light.shadow.camera.bottom = -9.5;
    this.light.shadow.camera.right = this.light.shadow.camera.top = 9.5;
    this.light.shadow.camera.far = 27;
    this.light.shadow.normalBias = 0.024;
    this.light.shadow.bias = -0.00035;

    const sky = new HemisphereLight(0xb4d5ea, 0x5b5047, 2.15);
    const rim = new DirectionalLight(0x8dd3ea, 0.90);
    rim.position.set(9, 6, 10);
    const warmDock = new PointLight(0xffb667, 36, 11);
    warmDock.position.set(-4.2, 2.30, 9.7);
    const warmGate = new PointLight(0xffbb76, 42, 10);
    warmGate.position.set(4.1, 2.33, 17);

    this.buildTelegraph();
    const sole = new RingGeometry(0.095, 0.124, 20).rotateX(-Math.PI / 2);
    for (let index = 0; index < 2; index++) {
      const marker = new Mesh(sole, this.support);
      marker.scale.set(1, 1, 1.32);
      marker.visible = false;
      this.footMarkers.push(marker);
      this.scene.add(marker);
    }
    this.sparkGeometry.setAttribute('position', new BufferAttribute(this.sparkPositions, 3));
    this.sparkGeometry.setDrawRange(0, 0);
    const sparkCloud = new LineSegments(this.sparkGeometry, new LineBasicMaterial({
      color: 0xffd284, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false,
    }));
    sparkCloud.frustumCulled = false;
    this.scene.add(this.telegraph, sparkCloud,
      sky, rim, warmDock, warmGate, this.light, this.light.target);
    this.resize();
  }

  resize() {
    const canvas = this.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.50));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  impact(hit: HitEvent) {
    const light = hit.result === 'glance';
    if (!this.reduced && !light) this.cameraKick = Math.max(this.cameraKick, hit.result === 'parry' ? 0.052 : 0.034);
    if (this.reduced) return;
    const count = hit.result === 'parry' ? 15 : light ? 3 : 10;
    const side = new Vector3(-hit.normal.z, 0, hit.normal.x).normalize();
    for (let index = 0; index < count && this.sparks.length < 36; index++) {
      const factor = index / count;
      const direction = hit.normal.clone().negate().multiplyScalar(0.65 + factor)
        .addScaledVector(side, Math.sin(index * 2.399) * (0.9 + factor))
        .add(new Vector3(0, 0.47 + Math.cos(index * 3.91) * 1.28, 0)).multiplyScalar(light ? 0.6 : 1.7);
      const duration = 0.12 + (index % 5) * 0.026;
      this.sparks.push({ position: hit.point.clone(), direction, life: duration });
    }
  }

  paint(run: DryDock, alpha: number, delta: number, time: number, reducedMotion: boolean) {
    this.reduced = reducedMotion;
    const changed = this.lastRun !== run.runId;
    if (changed) {
      this.lastRun = run.runId;
      let arena = this.arenas.get(run.mission.id);
      if (!arena) {
        arena = new DockScenery(run.mission);
        this.arenas.set(run.mission.id, arena);
      }
      this.scenery?.group.removeFromParent();
      this.scene.add(arena.group);
      this.scenery = arena;
      arena.reset();
      for (const model of this.models.values()) model.group.visible = false;
      this.cameraKick = 0;
      this.sparks.length = 0;
    }
    for (const actor of run.fighters) {
      const key = `${actor.id}/${actor.spec.attack.id}`;
      let model = this.models.get(key);
      if (!model) {
        model = new FighterModel(actor.isPlayer, actor.spec.blade.length, actor.spec.id);
        this.models.set(key, model);
        this.scene.add(model.group);
      }
      model.group.visible = true;
      model.paint(actor, alpha);
    }
    const player = interpolate(run.player.previous.root, run.player.frame.root, alpha).position;
    const threat = run.focusEnemy;
    const opponent = threat && interpolate(threat.previous.root, threat.frame.root, alpha).position;
    const distance = opponent?.distanceTo(player) ?? Infinity;
    const desired = player.clone();
    const preview = run.mode === 'preview';
    const boss = run.mission.id === 'M04';
    const portrait = this.camera.aspect < 0.90;
    if (preview) {
      desired.set(portrait ? 0.37 : 1.87, portrait ? 0.66 : 1.07, portrait ? 11.32 : 11.59);
    } else {
      if (run.awake && opponent && distance < (boss ? 8.0 : 5.8)) {
        desired.lerp(opponent, boss ? 0.40 : 0.30);
      }
      desired.addScaledVector(upwind, run.mode === 'drill' ? 0.51 : 1.05);
      if (run.mode === 'drill' && portrait) desired.x += 0.12;
      desired.y = boss ? 0.72 : 0.51;
    }

    if (changed) this.target.copy(desired);
    else this.target.lerp(desired, 1 - Math.exp(-delta / 0.18));
    const azimuth = preview ? 0.37 : CAMERA_AZIMUTH;
    const elevation = preview ? (portrait ? 0.28 : 0.23) : CAMERA_TILT;
    const spread = opponent && distance < 8.0
      ? Math.abs(opponent.clone().sub(player).dot(right(-azimuth))) : 0;
    const bossPadding = boss && portrait ? MathUtils.clamp((spread - 1.50) * 0.58, 0, 1.60) : 0;
    const dolly = preview ? (portrait ? 5.2 : 5.65)
      : run.mode === 'drill' ? (portrait ? 7.12 : 6.86)
      : boss ? (portrait ? 9.1 + bossPadding : 8.3)
      : portrait ? (this.camera.aspect < 0.50 ? 8.4 : 7.8) : 7.60;
    const horizontal = Math.cos(elevation) * dolly;
    this.camera.position.set(this.target.x + Math.sin(azimuth) * horizontal,
      this.target.y + Math.sin(elevation) * dolly, this.target.z - Math.cos(azimuth) * horizontal);
    if (this.cameraKick > 0.001 && !reducedMotion) {
      this.camera.position.x += Math.sin(time * 152) * this.cameraKick;
      this.camera.position.y += Math.cos(time * 108) * this.cameraKick * 0.43;
      this.cameraKick *= Math.exp(-delta / 0.039);
    }
    this.camera.lookAt(this.target);
    this.light.target.position.set(0, 0, Math.round(this.target.z * 2) / 2 + 1.1);
    this.light.position.copy(this.light.target.position).add(lightOffset);
    this.scenery?.update(run, time, delta, reducedMotion);
    this.drawThreat(run);
    this.drawSupport(run, alpha);
    this.updateSparks(delta);
    this.renderer.render(this.scene, this.camera);
  }

  private buildTelegraph() {
    const rectangle = (width: number, length: number, x: number, z: number, fill = false) => {
      const tile = new Mesh(new PlaneGeometry(width, length).rotateX(-Math.PI / 2),
        fill ? this.warningFill : this.warning);
      tile.position.set(x, fill ? 0 : 0.002, z);
      this.line.add(tile);
    };
    rectangle(0.72, 1.58, 0, 1.12, true);
    for (const side of [-1, 1]) rectangle(0.032, 1.58, side * 0.35, 1.12);
    rectangle(0.72, 0.048, 0, 1.90);
    for (const z of [1.70, 1.74, 1.78]) rectangle(0.29, 0.018, 0, z);
    const angle = -Math.PI / 2 - 0.93;
    const fill = new Mesh(new RingGeometry(0.40, 1.84, 38, 1, angle, 1.86).rotateX(-Math.PI / 2), this.warningFill);
    const edge = new Mesh(new RingGeometry(1.79, 1.84, 38, 1, angle, 1.86).rotateX(-Math.PI / 2), this.warning);
    edge.position.y = 0.003;
    this.arc.add(fill, edge);
    this.telegraph.add(this.line, this.arc);
    this.telegraph.position.y = 0.024;
    this.telegraph.visible = false;
  }

  private drawThreat(run: DryDock) {
    const actor = run.fighters.find(fighter => !fighter.isPlayer && fighter.alive &&
      (fighter.phase(run.tick) === 'windup' || fighter.phase(run.tick) === 'active'));
    const strike = actor?.strike;
    this.telegraph.visible = run.mode === 'duel' && Boolean(strike);
    if (!actor || !strike || !this.telegraph.visible) return;
    const at = actor.frame.root.position;
    this.telegraph.position.set(at.x, 0.024, at.z);
    this.telegraph.rotation.y = strike.yaw;
    const motion = strike.spec.motion;
    this.arc.visible = motion === 'swing';
    this.line.visible = !this.arc.visible;
    this.telegraph.scale.set(actor.scale * (motion === 'bash' ? 1.22 : 1), 1,
      actor.scale * (motion === 'lunge' ? 1.23 : 1));
    const charge = Math.min(1, (run.tick - strike.start) / ticks(strike.spec.windup));
    this.warning.opacity = 0.45 + charge * 0.40;
    this.warningFill.opacity = 0.10 + charge * 0.16;
  }

  private drawSupport(run: DryDock, alpha: number) {
    const guard = run.watchman;
    for (const [index, marker] of this.footMarkers.entries()) {
      marker.visible = run.mode === 'drill' && guard.canAct;
      if (!marker.visible) continue;
      const isLeft = index === 0;
      const prior = isLeft ? guard.previous.leftFoot : guard.previous.rightFoot;
      const next = isLeft ? guard.frame.leftFoot : guard.frame.rightFoot;
      marker.position.copy(prior).lerp(next, alpha).addScaledVector(forward(guard.yaw), 0.024);
      marker.position.y = 0.025;
      marker.rotation.y = guard.yaw;
      marker.material = guard.support === 'both' || guard.support === (isLeft ? 'left' : 'right')
        ? this.support : this.raised;
    }
  }

  private updateSparks(delta: number) {
    this.sparks = this.sparks.filter(spark => spark.life > delta);
    for (const [index, spark] of this.sparks.entries()) {
      spark.life -= delta;
      spark.direction.y -= delta * 5.5;
      spark.position.addScaledVector(spark.direction, delta);
      spark.position.toArray(this.sparkPositions, index * 6);
      spark.position.clone().addScaledVector(spark.direction, Math.min(0.025, spark.life * 0.38))
        .toArray(this.sparkPositions, index * 6 + 3);
    }
    this.sparkGeometry.attributes.position.needsUpdate = true;
    this.sparkGeometry.setDrawRange(0, this.sparks.length * 2);
  }
}
