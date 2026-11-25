import {
  BoxGeometry, CylinderGeometry, ExtrudeGeometry, Group, IcosahedronGeometry, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Quaternion, Shape, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { ROOT_HEIGHT, UP, interpolate } from './physics.ts';
import type { Fighter } from '../game/fighter.ts';

const material = (color: number, metalness = 0.05, roughness = 0.72) =>
  new MeshStandardMaterial({ color, metalness, roughness, flatShading: true });

const palettes = {
  cloth: material(0xe4dcc7),
  underside: material(0xb6ac97),
  stripe: material(0xbf9143),
  shirt: material(0x6c695c),
  graphite: material(0x323b45),
  boot: material(0x253032, 0.08),
  bootTop: material(0x37424a, 0.04),
  skin: material(0xc99472),
  hair: material(0x302c2b),
  armor: material(0x783f32, 0.29),
  armorLight: material(0x9b5140, 0.24),
  armorDark: material(0x593a36, 0.36),
  steel: material(0x46515b, 0.47),
  joint: material(0x242f35, 0.32),
  bolt: material(0x839096, 0.38),
  bevel: material(0xc4d0d2, 0.40, 0.32),
  edge: material(0xe0e4d9, 0.26, 0.42),
  blade: material(0x858f91, 0.51, 0.38),
  grip: material(0x3d3029, 0.18, 0.85),
};

const shieldPaint = material(0x4a515a, 0.33);
const masterPaint = material(0x64605a, 0.46, 0.57);

const cube = new BoxGeometry(1, 1, 1);
const joint = new IcosahedronGeometry(0.51, 0);
const taper = new CylinderGeometry(0.42, 0.50, 1, 7);
const swivel = new CylinderGeometry(0.50, 0.50, 1, 8);
const shoulderGeometry = bevelBlock(0.12);
const skullGeometry = bevelBlock(0.18);
const YAW = new Quaternion();

function bevelBlock(corner: number) {
  const s = new Shape();
  s.moveTo(-0.5 + corner, -0.5);
  s.lineTo(0.5 - corner, -0.5);
  s.lineTo(0.5, -0.5 + corner);
  s.lineTo(0.5, 0.5 - corner);
  s.lineTo(0.5 - corner, 0.5);
  s.lineTo(-0.5 + corner, 0.5);
  s.lineTo(-0.5, 0.5 - corner);
  s.lineTo(-0.5, -0.5 + corner);
  s.closePath();
  return new ExtrudeGeometry(s, {
    depth: 0.80, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelThickness: 0.10, bevelSize: 0.055,
  }).translate(0, 0, -0.4);
}

function bladeGeometry(length: number, width: number) {
  const bottom = -length / 2;
  const tip = length / 2;
  const s = new Shape();
  s.moveTo(-width * 0.46, bottom);
  s.lineTo(width * 0.5, bottom);
  s.lineTo(width * 0.5, tip - 0.14);
  s.lineTo(-width * 0.12, tip);
  s.lineTo(-width * 0.46, tip - 0.066);
  s.closePath();
  return new ExtrudeGeometry(s, {
    depth: 0.019, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelThickness: 0.011, bevelSize: 0.007,
  }).translate(0, 0, -0.0095);
}

function put(parent: Group, mat: Material, scale: [number, number, number],
  position: [number, number, number], geometry: BufferGeometry = cube, shadow = true) {
  const mesh = new Mesh(geometry, mat);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function limb(parent: Group, mat: Material, thickness: number, plate?: Material) {
  const bone = new Group();
  put(bone, mat, [thickness, 1, thickness], [0, 0, 0], taper);
  if (plate) put(bone, plate, [thickness * 1.06, 0.50, thickness * 0.42], [0, -0.12, thickness * 0.34], shoulderGeometry);
  parent.add(bone);
  return bone;
}

function segment(part: Group, from: Vector3, to: Vector3) {
  const offset = from.clone().sub(to);
  part.position.copy(to).addScaledVector(offset, 0.5);
  part.quaternion.setFromUnitVectors(UP, offset.clone().normalize());
  part.scale.y = offset.length();
}

export class FighterModel {
  readonly group = new Group();
  private rig = new Group();
  private top = new Group();
  private weapon = new Group();
  private legs: { thigh: Group; shin: Group; ankle: Group; boot: Group }[] = [];
  private arms: { upper: Group; forearm: Group; elbow: Group; hand: Group }[] = [];
  private visor = new MeshBasicMaterial({ color: 0xffbb52 });
  private bladeLength: number;
  private shield?: Group;
  private armor: Material;
  private trim: Material;

  constructor(private hero: boolean, bladeLength: number, private kind: string = 'E1') {
    this.bladeLength = bladeLength;
    this.armor = kind === 'E3' ? palettes.steel : kind === 'B1' ? masterPaint : kind === 'E2' ? shieldPaint : palettes.armor;
    this.trim = kind === 'E3' ? palettes.bolt : kind === 'B1' ? palettes.stripe : kind === 'E2' ? palettes.armor : palettes.armorLight;
    this.group.add(this.rig, this.weapon);
    this.rig.add(this.top);
    this.top.position.y = -0.055;
    this.buildTorso();
    const hip = hero ? palettes.graphite : palettes.joint;
    put(this.rig, hip, [0.35, 0.21, 0.25], [0, -0.006, 0], shoulderGeometry);
    for (const side of [-1, 1]) this.buildLeg(side);
    for (const side of [-1, 1]) this.buildArm(side);
    this.buildWeapon();
    if (kind === 'E2') {
      this.shield = new Group();
      put(this.shield, palettes.steel, [0.68, 0.84, 0.14], [0, 0, 0], shoulderGeometry);
      put(this.shield, shieldPaint, [0.55, 0.70, 0.072], [0, 0, 0.054], skullGeometry);
      const boss = put(this.shield, palettes.bolt, [0.20, 0.093, 0.20], [0, 0, 0.108], swivel);
      boss.rotation.x = Math.PI / 2;
      for (const sign of [-1, 1]) put(this.shield, palettes.stripe, [0.40, 0.043, 0.028], [0, sign * 0.29, 0.102]);
      this.group.add(this.shield);
    }
  }

  paint(fighter: Fighter, alpha: number) {
    const previous = fighter.previous;
    const current = fighter.frame;
    const root = interpolate(previous.root, current.root, alpha);
    const sword = interpolate(previous.blade, current.blade, alpha);
    const turn = Math.atan2(Math.sin(current.yaw - previous.yaw), Math.cos(current.yaw - previous.yaw));
    const yaw = previous.yaw + turn * alpha;
    YAW.setFromAxisAngle(UP, yaw);
    this.rig.position.copy(root.position);
    const kneeling = fighter.stance === 'kneel';
    if (kneeling) this.rig.position.y -= 0.37;
    this.rig.scale.setScalar(fighter.scale);
    this.rig.quaternion.copy(root.rotation).multiply(YAW);
    const inverse = this.rig.quaternion.clone().invert();
    this.top.rotation.x = (previous.lean + (current.lean - previous.lean) * alpha) * 0.78;
    this.visor.color.setHex(fighter.alive ? 0xffbb52 : 0x4c392b);
    this.weapon.position.copy(sword.position);
    this.weapon.quaternion.copy(sword.rotation);

    const armRotation = this.top.quaternion;
    const guard = sword.position.clone().addScaledVector(UP.clone().applyQuaternion(sword.rotation),
      -this.bladeLength * 0.5 - 0.067);
    const local = (point: Vector3) => point.sub(this.rig.position).applyQuaternion(inverse).divideScalar(fighter.scale);
    const localGuard = local(guard);
    let shieldGrip: Vector3 | null = null;
    if (this.shield && current.shield && previous.shield) {
      const shield = interpolate(previous.shield, current.shield, alpha);
      this.shield.position.copy(shield.position);
      this.shield.quaternion.copy(shield.rotation);
      this.shield.visible = fighter.canAct;
      shieldGrip = local(shield.position.add(new Vector3(0.10, 0, -0.12).applyQuaternion(shield.rotation)));
    }

    for (const [index, side] of [-1, 1].entries()) {
      const leg = this.legs[index];
      const frameFoot = side < 0 ? current.rightFoot : current.leftFoot;
      const oldFoot = side < 0 ? previous.rightFoot : previous.leftFoot;
      const foot = fighter.canAct || kneeling ? local(oldFoot.clone().lerp(frameFoot, alpha))
        : new Vector3(side * 0.26, -ROOT_HEIGHT + 0.05, index === 0 ? -0.19 : 0.27);
      const hip = new Vector3(side * 0.14, -0.015, -0.018);
      const ankle = foot.clone().add(new Vector3(0, 0.117, -0.035));
      const knee = hip.clone().lerp(ankle, 0.49).add(new Vector3(side * 0.032, 0, fighter.canAct ? 0.102 : 0.30));
      segment(leg.thigh, hip, knee);
      segment(leg.shin, knee, ankle);
      leg.ankle.position.copy(ankle);
      leg.boot.position.copy(foot);
      leg.boot.rotation.y = side * -0.09;

      const arm = this.arms[index];
      const shoulder = new Vector3(side * 0.283, 0.514, 0)
        .applyQuaternion(armRotation).add(this.top.position);
      const hand = (fighter.canAct || kneeling) && index === 0 ? localGuard
        : fighter.canAct && index === 1 && shieldGrip ? shieldGrip : new Vector3(
        side * (fighter.canAct ? 0.43 : 0.54),
        fighter.canAct ? 0.12 : 0.30,
        fighter.canAct ? 0.09 - (foot.z * 0.44) : 0.29,
      );
      const elbow = shoulder.clone().lerp(hand, 0.48)
        .add(new Vector3(side * 0.076, -0.084, -0.075));
      segment(arm.upper, shoulder, elbow);
      segment(arm.forearm, elbow, hand);
      arm.elbow.position.copy(elbow);
      arm.hand.position.copy(hand);
      if (index === 0 && (fighter.canAct || kneeling)) {
        arm.hand.quaternion.copy(inverse).multiply(sword.rotation);
      } else arm.hand.rotation.set(0.3, 0, side * 0.17);
    }
  }

  private buildTorso() {
    const top = this.top;
    if (this.hero) {
      put(top, palettes.underside, [0.397, 0.24, 0.282], [0, 0.126, -0.012], shoulderGeometry);
      put(top, palettes.cloth, [0.475, 0.40, 0.315], [0, 0.365, 0.006], shoulderGeometry);
      put(top, palettes.cloth, [0.475, 0.16, 0.32], [0, 0.522, -0.005], shoulderGeometry);
      put(top, palettes.shirt, [0.29, 0.059, 0.31], [0, 0.628, -0.01], shoulderGeometry);
      const back = put(top, palettes.stripe, [0.089, 0.510, 0.019], [0.013, 0.365, -0.164], cube, false);
      back.rotation.z = 0.57;
      const front = put(top, palettes.stripe, [0.083, 0.485, 0.016], [0.014, 0.366, 0.171], cube, false);
      front.rotation.z = 0.57;
      put(top, palettes.underside, [0.12, 0.072, 0.018], [-0.131, 0.395, 0.175], cube, false);
      put(top, palettes.underside, [0.013, 0.15, 0.016], [0.02, 0.206, 0.149], cube, false);
      put(top, palettes.skin, [0.113, 0.102, 0.110], [0, 0.659, 0.014], swivel);
      put(top, palettes.skin, [0.203, 0.235, 0.196], [0, 0.771, 0.027], skullGeometry);
      put(top, palettes.skin, [0.057, 0.066, 0.035], [0, 0.768, 0.134], shoulderGeometry);
      for (const side of [-1, 1]) {
        put(top, palettes.skin, [0.049, 0.064, 0.055], [side * 0.114, 0.768, 0.024], skullGeometry);
        put(top, palettes.hair, [0.049, 0.012, 0.010], [side * 0.052, 0.800, 0.128], cube, false);
      }
      const crop = put(top, palettes.hair, [0.213, 0.103, 0.229], [0, 0.889, 0.009], skullGeometry);
      crop.rotation.x = -0.09;
      put(top, palettes.hair, [0.200, 0.106, 0.050], [0, 0.828, -0.081], skullGeometry);
      put(top, palettes.hair, [0.023, 0.055, 0.078], [-0.104, 0.823, 0.051], shoulderGeometry);
    } else {
      put(top, palettes.steel, [0.345, 0.21, 0.235], [0, 0.146, 0.0], shoulderGeometry);
      put(top, palettes.armorDark, [0.50, 0.414, 0.318], [0, 0.391, -0.007], shoulderGeometry);
      put(top, this.armor, [0.47, 0.346, 0.081], [0, 0.421, 0.155], shoulderGeometry);
      put(top, this.trim, [0.458, 0.204, 0.067], [0, 0.459, -0.172], shoulderGeometry);
      put(top, palettes.joint, [0.32, 0.089, 0.22], [0, 0.614, -0.003], shoulderGeometry);
      put(top, palettes.bolt, [0.037, 0.037, 0.02], [0.177, 0.511, 0.197], joint, false);
      put(top, palettes.bolt, [0.037, 0.037, 0.02], [-0.177, 0.511, 0.197], joint, false);
      put(top, palettes.joint, [0.224, 0.177, 0.220], [0, 0.750, 0.033],
        this.kind === 'E2' ? swivel : skullGeometry);
      put(top, palettes.steel, [0.254, 0.090, 0.235], [0, 0.844, 0.026], skullGeometry);
      put(top, palettes.armor, [0.23, 0.070, 0.14], [0, 0.700, 0.069], skullGeometry);
      put(top, this.visor, [0.180, 0.035, 0.016], [0, 0.780, 0.153], shoulderGeometry, false);
      put(top, palettes.steel, [0.050, 0.086, 0.10], [-0.119, 0.756, 0.02], shoulderGeometry);
      put(top, palettes.steel, [0.050, 0.086, 0.10], [0.119, 0.756, 0.02], shoulderGeometry);
      if (this.kind === 'B1') {
        put(top, masterPaint, [0.575, 0.45, 0.39], [0, 0.382, -0.019], skullGeometry);
        put(top, palettes.steel, [0.34, 0.12, 0.10], [0, 0.38, 0.20], shoulderGeometry);
        for (const side of [-1, 1]) put(top, palettes.stripe, [0.061, 0.20, 0.019],
          [side * 0.206, 0.46, 0.198], shoulderGeometry);
      }
    }
  }

  private buildLeg(side: number) {
    const thigh = limb(this.rig, this.hero ? palettes.graphite : palettes.steel, this.hero ? 0.195 : 0.154,
      this.hero ? undefined : this.armor);
    const shin = limb(this.rig, this.hero ? palettes.graphite : palettes.joint, this.hero ? 0.155 : 0.128,
      this.hero ? undefined : palettes.steel);
    const ankle = new Group();
    put(ankle, this.hero ? palettes.bootTop : palettes.steel, [0.146, 0.148, 0.156], [0, 0.041, 0], shoulderGeometry);
    const boot = new Group();
    put(boot, palettes.boot, [0.159, 0.046, 0.283], [0, 0.027, 0.035], shoulderGeometry);
    const top = put(boot, this.hero ? palettes.bootTop : palettes.steel, [0.15, 0.087, 0.244],
      [0, 0.074, 0.033], shoulderGeometry);
    top.rotation.y = side * 0.04;
    this.rig.add(ankle, boot);
    this.legs.push({ thigh, shin, ankle, boot });
  }

  private buildArm(side: number) {
    const upper = limb(this.rig, this.hero ? palettes.cloth : palettes.steel, this.hero ? 0.156 : 0.146);
    put(upper, this.hero ? palettes.cloth : this.trim, [this.kind === 'B1' ? 0.22 : 0.175, 0.47, 0.180],
      [side * 0.018, 0.36, -0.004], shoulderGeometry);
    const forearm = limb(this.rig, this.hero ? palettes.underside : palettes.steel, this.hero ? 0.134 : 0.112,
      this.hero ? undefined : palettes.armorDark);
    const elbow = new Group();
    put(elbow, this.hero ? palettes.cloth : palettes.joint, [0.125, 0.122, 0.117], [0, 0, 0], joint);
    const hand = new Group();
    put(hand, this.hero ? palettes.skin : palettes.joint, [0.091, 0.108, 0.092], [0, 0.0, 0], shoulderGeometry);
    this.rig.add(elbow, hand);
    this.arms.push({ upper, forearm, elbow, hand });
  }

  private buildWeapon() {
    const length = this.bladeLength;
    const width = this.kind === 'B1' ? 0.26 : this.hero ? (this.bladeLength < 0.9 ? 0.13 : 0.157) : 0.131;
    const guard = -length * 0.5;
    const body = new Mesh(bladeGeometry(length, width), palettes.bevel);
    body.castShadow = true;
    body.receiveShadow = true;
    this.weapon.add(body);
    put(this.weapon, palettes.edge, [0.027, length * 0.86, 0.012],
      [-width * 0.36, -0.035, 0.018], cube, false);
    put(this.weapon, palettes.blade, [width * 0.33, length * 0.78, 0.012],
      [width * 0.15, -0.04, -0.018], cube, false);
    put(this.weapon, this.hero ? palettes.stripe : palettes.steel, [width * 1.65, 0.047, 0.082],
      [0, guard, 0], shoulderGeometry);
    put(this.weapon, palettes.grip, [0.057, 0.178, 0.057], [0, guard - 0.092, 0], swivel);
    put(this.weapon, palettes.steel, [0.078, 0.033, 0.065], [0, guard - 0.177, 0], shoulderGeometry);
  }
}
