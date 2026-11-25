import {
  BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, InstancedMesh, Matrix4,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, ShaderMaterial, SRGBColorSpace, Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import type { Mission, Obstacle } from '../content/campaign.ts';
import type { DryDock } from '../game/dry-dock.ts';
import { pose } from './physics.ts';

const steel = (color: number, metalness = 0.24, roughness = 0.62) =>
  new MeshStandardMaterial({ color, metalness, roughness, flatShading: true });

export class DockScenery {
  readonly group = new Group();
  private box = new BoxGeometry(1, 1, 1);
  private cylinder = new CylinderGeometry(1, 1, 1, 12);
  private batches = new Map<Material, Map<BufferGeometry, { matrix: Matrix4; shadow: boolean }[]>>();
  private gate = new Group();
  private gateStatus = new MeshBasicMaterial({ color: 0xffb45d });
  private water: ShaderMaterial;
  private openFraction = 0;
  private screens: Group[] = [];
  private crates: Group[] = [];
  private zonePaint = steel(0xb89155, 0.12);

  constructor(mission: Mission) {
    const structure = steel(0x28353b);
    const metal = steel(0x546371);
    const rim = steel(0x657483, 0.36);
    const painted = steel(0x926447);
    const concrete = steel(0x566067, 0.02, 0.91);
    const concreteLight = steel(0x717775, 0.03, 0.92);
    const dark = steel(0x1c2a31);
    const detail = steel(0x323e43);
    const timber = steel(0x6b5142, 0.05, 0.87);
    const white = steel(0xc4c7ba, 0.06);
    const ochre = steel(0xb98741, 0.17);
    const orange = new MeshBasicMaterial({ color: 0xffcb83 });
    const decking = [0x606d79, 0x5b6874, 0x586572, 0x64717c, 0x596776].map(c => steel(c, 0.22, 0.49));
    const { length, width, exitHalfWidth } = mission;
    const sideWidth = width / 2;

    this.place(structure, 0, -0.21, length / 2, width, 0.38, length);
    const cols = Math.round(width / 2);
    const rows = Math.round(length / 2);
    const tileWidth = width / cols;
    const tileLength = length / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = tileWidth * (col + 0.5) - sideWidth;
        const z = tileLength * (row + 0.5);
        this.place(decking[(row * 3 + col * 2) % decking.length], x, -0.020, z,
          tileWidth - 0.023, 0.04, tileLength - 0.023);
        for (const side of [-1, 1]) {
          const boltX = x + side * (tileWidth / 2 - 0.1);
          for (const end of [-1, 1]) this.place(rim, boltX, 0.0015, z + end * (tileLength / 2 - 0.1),
            0.021, 0.012, 0.021, false, this.cylinder);
        }
      }
    }

    for (const side of [-1, 1]) {
      const edge = side * (width / 2 - 0.075);
      this.place(structure, edge, 0.14, length / 2, 0.15, 0.28, length, true);
      this.place(rim, edge, 1.018, length / 2, 0.15, 0.064, length, true);
      this.place(metal, edge, 0.55, length / 2, 0.10, 0.068, length, true);
      for (let z = 0.86; z < length; z += 1.78) {
        this.place(metal, edge, 0.54, z, 0.153, 1.03, 0.14, true);
        this.place(rim, edge, 0.045, z, 0.255, 0.09, 0.32);
      }
      for (let z = 0.25; z < length; z += 0.49) {
        this.place(ochre, side * (sideWidth - 0.34), 0.004, z, 0.09, 0.008, 0.26);
      }
      this.place(structure, side * (sideWidth - 0.22), -0.72, length / 2, 0.55, 0.84, length, true);
      for (let z = 1.3; z < length; z += 3.5) {
        this.place(dark, side * (sideWidth + 0.08), -0.9, z, 0.48, 1.48, 0.7, true);
        this.place(metal, side * (sideWidth + 0.12), -0.28, z, 0.52, 0.09, 0.82);
      }
      const endWidth = width / 2 - exitHalfWidth;
      const endX = side * (width / 2 + exitHalfWidth) / 2;
      this.place(structure, endX, 0.145, length - 0.075, endWidth, 0.29, 0.15, true);
      this.place(rim, endX, 1.016, length - 0.075, endWidth, 0.068, 0.15, true);
      this.place(metal, endX, 0.55, length - 0.075, endWidth, 0.075, 0.12, true);
      for (const x of [exitHalfWidth + 0.05, (sideWidth + exitHalfWidth) / 2, sideWidth - 0.15]) this.place(rim, side * x, 0.53, length - 0.075,
        0.14, 1.04, 0.14, true);
    }
    this.place(structure, 0, 0.15, 0.075, width, 0.30, 0.15, true);
    this.place(metal, 0, 0.54, 0.075, width, 0.08, 0.12, true);
    this.place(rim, 0, 1.016, 0.075, width, 0.068, 0.15, true);
    for (const x of [-0.97, -0.66, -0.33, 0, 0.33, 0.66, 0.97].map(ratio => ratio * sideWidth)) {
      this.place(rim, x, 0.53, 0.075, 0.14, 1.04, 0.14, true);
    }

    for (let x = -sideWidth + 0.41; x < sideWidth - 0.25; x += 0.46) {
      this.place(ochre, x, 0.008, mission.combatLine, 0.26, 0.012, 0.045, false, this.box, 0.42);
    }
    const exitLight = length - 1.36;
    for (const x of [-1.19, 1.19]) {
      this.place(white, x, 0.006, length - 0.98, 0.058, 0.012, 1.9);
      this.place(structure, x, 1.65, length + 0.06, 0.26, 3.3, 0.48, true);
      this.place(metal, x, 1.65, length - 0.21, 0.10, 3.3, 0.10, true);
      this.place(dark, x, 2.71, length - 0.30, 0.24, 0.20, 0.13, true);
      this.place(this.gateStatus, x, 2.71, length - 0.377, 0.15, 0.068, 0.027);
    }
    this.place(white, 0, 0.005, exitLight, 2.38, 0.012, 0.07);
    this.place(structure, 0, 3.30, length + 0.12, 2.67, 0.33, 0.60, true);
    this.place(dark, 0, 1.12, length + 0.05, 2.38, 2.50, 0.15, true, this.box, 0, this.gate);
    for (let layer = 0; layer < 6; layer++) {
      this.place(metal, 0, 0.06 + 0.40 * layer, length - 0.046,
        2.35, 0.033, 0.05, true, this.box, 0, this.gate);
    }
    this.place(ochre, 0, 0.0, length - 0.055, 2.35, 0.10, 0.05, true, this.box, 0, this.gate);
    this.place(structure, 0, -0.33, length + 2.33, 3.32, 0.58, 4.60, true);
    this.place(metal, 0, 0.09, length + 3.65, 3.12, 0.18, 2.70, true);
    for (const side of [-1, 1]) {
      this.place(painted, side * 1.50, 1.04, length + 3.60, 0.12, 1.93, 2.73, true);
      this.place(orange, side * 1.39, 1.31, length + 2.23, 0.13, 0.18, 0.035);
      this.place(concrete, side * 3.43, 1.03, length + 2.02, 1.97, 3.93, 3.24, true);
      this.place(concreteLight, side * 3.43, 3.00, length + 1.98, 2.08, 0.19, 3.39);
    }
    this.place(dark, 0, 2.05, length + 4.90, 3.10, 0.14, 0.21, true);
    this.place(white, 0, 2.04, length + 2.18, 3.14, 0.15, 0.10, true);

    for (const side of [-1, 1]) {
      this.place(concrete, side * 10.92, -0.33, 14, 3.34, 2.20, 45, true);
      this.place(concreteLight, side * 9.51, 0.74, 15, 0.42, 0.17, 43);
      this.place(structure, side * 11, 0.82, 14.1, 2.90, 0.16, 41, true);
      for (let z = -1.8; z < 37; z += 5.5) {
        this.place(concreteLight, side * 9.55, 0.02, z, 0.55, 1.85, 0.53);
        this.place(dark, side * 10.15, 2.95, z, 0.38, 4.20, 0.38, true);
        this.place(ochre, side * 9.55, 1.65, z, 0.09, 0.06, 0.1);
        this.place(orange, side * 9.52, 1.81, z, 0.18, 0.25, 0.15);
        this.place(dark, side * 9.52, 2.00, z, 0.25, 0.075, 0.21);
        for (let i = 0; i < 3; i++) {
          this.place(white, side * 9.21, -0.30 - i * 0.29, z + 1.03, 0.02, 0.022, 0.23);
        }
      }
      for (let bay = 0; bay < 4; bay++) {
        const z = 8 + bay * 8.2;
        this.place(concrete, side * (13.15 + bay * 0.38), 2.5, z, 4.12, 5.95, 7.8, true);
        this.place(dark, side * (12.88 + bay * 0.38), 5.6, z, 4.91, 0.45, 8.04, true);
        this.place(detail, side * (10.99 + bay * 0.38), 3.6, z, 0.14, 1.65, 4.55);
        for (let pane = -2; pane < 3; pane++) {
          this.place(steelGlass, side * (10.90 + bay * 0.38), 3.58, z + pane * 0.86, 0.12, 1.40, 0.77);
        }
        this.place(metal, side * (10.84 + bay * 0.38), 4.24, z, 0.22, 0.073, 4.70);
      }
    }

    this.place(structure, -7.4, 2.45, 32.1, 0.70, 8.2, 0.70, true);
    this.place(structure, 7.4, 2.45, 32.1, 0.70, 8.2, 0.70, true);
    this.place(metal, 0, 6.48, 32.1, 15.30, 0.43, 0.72, true);
    this.place(dark, 0, 5.84, 32.1, 14.90, 0.17, 0.49);
    this.place(concrete, 0, 1.34, 38.9, 22.0, 5.3, 3.4, true);
    this.place(dark, 0, 2.3, 37.18, 8.1, 4.80, 0.28, true);
    this.place(metal, -2.9, 2.38, 36.98, 0.17, 4.85, 0.30);
    this.place(metal, 2.9, 2.38, 36.98, 0.17, 4.85, 0.30);
    this.place(ochre, 0, 4.81, 36.98, 8.1, 0.12, 0.35);

    const lampOffset = sideWidth - 0.76;
    for (const [x, z] of [[-lampOffset, 2.0], [-lampOffset, 9.8], [lampOffset, 17], [-lampOffset, 20]]) {
      this.place(dark, x, 1.18, z, 0.12, 2.36, 0.13, true);
      this.place(rim, x, 2.35, z, 0.45, 0.10, 0.20);
      this.place(orange, x, 2.27, z, 0.33, 0.067, 0.15);
    }
    for (const [x, z] of [[10, 8.2], [-10, 13.6], [10, 22.8], [-10, 26.6]]) {
      this.place(timber, x, 1.09, z, 0.73, 0.51, 0.97, true);
      this.place(painted, x, 1.40, z + 0.54, 0.26, 1.13, 0.27, true, this.cylinder);
    }

    if (mission.dummy) {
      const [dx, dz] = mission.dummy;
      this.place(dark, dx, 0.11, dz, 0.37, 0.22, 0.37, true, this.cylinder);
      this.place(metal, dx, 0.63, dz, 0.071, 1.0, 0.071, true, this.cylinder);
      this.place(painted, dx, 1.08, dz, 0.50, 0.61, 0.30, true);
      this.place(ochre, dx, 1.10, dz - 0.16, 0.33, 0.074, 0.03);
      this.place(white, dx, 1.10, dz - 0.184, 0.057, 0.27, 0.012);
      this.place(metal, dx, 1.47, dz, 0.13, 0.18, 0.13, true, this.cylinder);
    }
    for (const block of mission.obstacles ?? []) this.addObstacle(block, structure, metal, ochre);
    for (const [index, [x, z]] of (mission.crates ?? []).entries()) {
      const crate = new Group();
      crate.name = `crate.${index}`;
      crate.position.set(x, 0.27, z);
      this.place(timber, 0, 0, 0, 0.54, 0.54, 0.54, true, this.box, 0, crate);
      for (const band of [-1, 1]) {
        this.place(metal, band * 0.18, 0, 0, 0.064, 0.55, 0.55, true, this.box, 0, crate);
      }
      this.group.add(crate);
      this.crates.push(crate);
    }
    if (mission.boarding) {
      const zone = mission.boarding;
      const middle = (zone.minZ + zone.maxZ) / 2;
      for (const direction of [-1, 1]) {
        this.place(this.zonePaint, direction * zone.x, 0.012, middle, 0.09, 0.012, zone.maxZ - zone.minZ);
        for (const z of [zone.minZ + 0.18, zone.maxZ - 0.18]) {
          this.place(this.zonePaint, direction * (zone.x - 0.35), 0.017, z, 0.70, 0.016, 0.09);
        }
      }
      for (let x = -2.8; x <= 2.81; x += 0.46) {
        this.place(this.zonePaint, x, 0.017, zone.maxZ, 0.26, 0.012, 0.055, false, this.box, 0.45);
      }
      this.label('ПОСАДКА', 0, 0.018, zone.minZ + 0.51, 1.70, 0.35, true);
      for (const [x, z] of [[-1.1, 23.75], [0.06, 24.1], [1.1, 24.4]]) {
        this.place(structure, x, 0.79, z, 0.30, 1.20, 0.29, true, this.cylinder);
        this.place(white, x, 1.50, z, 0.19, 0.17, 0.18, true, this.cylinder);
      }
    }
    this.label(mission.id.slice(1), 0, 3.16, length - 0.22, 0.71, 0.32);
    this.label(mission.title.toUpperCase(), 0, 0.012, mission.combatLine - 0.51,
      mission.id === 'M01' ? 2.05 : 3.10, 0.38, true);
    this.label('ВЫХОД', 0, 0.014, length - 0.68, 1.24, 0.30, true);

    this.water = createWater();
    const surface = new Mesh(new PlaneGeometry(160, 160), this.water);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(0, -1.22, 19);
    this.group.add(surface, this.gate);
    this.flush();
  }

  reset() {
    this.openFraction = 0;
    this.gate.position.y = 0;
    this.gateStatus.color.setHex(0xffb45d);
  }

  update(run: DryDock, time: number, delta: number, reducedMotion: boolean) {
    this.water.uniforms.uTime.value = reducedMotion ? 0 : time;
    this.openFraction = Math.min(1, this.openFraction + (run.gateOpen ? delta * 1.8 : 0));
    this.gate.position.y = this.openFraction * this.openFraction * (3 - 2 * this.openFraction) * 2.64;
    this.gateStatus.color.setHex(run.gateOpen ? 0xbbe4cf : 0xffb45d);
    this.zonePaint.color.setHex(run.intrusionTicks ? 0xc76d38 : run.gateOpen ? 0x83b39e : 0xb89155);
    const folded = run.screensProgress;
    for (const screen of this.screens) screen.rotation.z = -Math.sign(screen.position.x) * folded * Math.PI / 2;
    for (const [index, crate] of this.crates.entries()) {
      const frame = pose(run.physics.crates[index].body);
      crate.position.copy(frame.position);
      crate.quaternion.copy(frame.rotation);
    }
  }

  private addObstacle(block: Obstacle, frame: Material, metal: Material, stripe: Material) {
    if (block.kind === 'container') {
      const rust = steel(0x794b3b, 0.20);
      const ridge = steel(0x995c44, 0.25);
      this.place(rust, block.x, block.height / 2, block.z, block.width - 0.08, block.height, block.depth, true);
      for (const side of [-1, 1]) {
        for (let z = -block.depth / 2 + 0.18; z < block.depth / 2; z += 0.26) {
          this.place(ridge, block.x + side * (block.width / 2 - 0.035), block.height / 2,
            block.z + z, 0.075, block.height - 0.24, 0.055, true);
        }
        for (const y of [0.10, block.height - 0.10]) {
          this.place(frame, block.x + side * (block.width / 2 - 0.04), y, block.z, 0.09, 0.17, block.depth, true);
        }
        this.place(metal, block.x + side * 0.30, block.height / 2, block.z - block.depth / 2 - 0.018,
          0.055, block.height - 0.27, 0.08, true);
      }
      return;
    }

    const screen = new Group();
    screen.position.set(block.x, 0, block.z);
    this.group.add(screen);
    this.screens.push(screen);
    this.place(frame, 0, block.height / 2, 0, block.width, block.height, block.depth, true, this.box, 0, screen);
    for (let z = -block.depth / 2 + 0.18; z < block.depth / 2; z += 0.75) {
      this.place(metal, 0, block.height * 0.54, z, block.width + 0.045, block.height * 0.80, 0.14, true,
        this.box, 0, screen);
    }
    this.place(stripe, 0, block.height - 0.07, 0, block.width + 0.025, 0.12, block.depth, true, this.box, 0, screen);
  }

  private place(material: Material, x: number, y: number, z: number, sx: number, sy: number, sz: number,
    shadow = false, geometry: BufferGeometry = this.box, yaw = 0, parent?: Group) {
    if (parent) {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.rotation.y = yaw;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return;
    }
    const matrix = new Matrix4().makeRotationY(yaw).scale(new Vector3(sx, sy, sz)).setPosition(x, y, z);
    const batch = this.batches.get(material) ?? new Map();
    const instances = batch.get(geometry) ?? [];
    instances.push({ matrix, shadow });
    batch.set(geometry, instances);
    this.batches.set(material, batch);
  }

  private label(label: string, x: number, y: number, z: number, width: number, height: number, horizontal = false) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#d4d5c0';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '800 94px sans-serif';
    context.fillText(label, 256, 62, 494);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(new PlaneGeometry(width, height),
      new MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false, roughness: 0.81 }));
    mesh.position.set(x, y, z);
    mesh.rotation.y = Math.PI;
    if (horizontal) mesh.rotation.set(-Math.PI / 2, 0, Math.PI);
    this.group.add(mesh);
  }

  private flush() {
    for (const [material, batch] of this.batches) {
      for (const [geometry, instances] of batch) {
        for (const shadow of [true, false]) {
          const subset = instances.filter(item => item.shadow === shadow);
          if (!subset.length) continue;
          const mesh = new InstancedMesh(geometry, material, subset.length);
          for (const [index, item] of subset.entries()) mesh.setMatrixAt(index, item.matrix);
          mesh.castShadow = shadow;
          mesh.receiveShadow = true;
          this.group.add(mesh);
        }
      }
    }
    this.batches.clear();
  }
}

const steelGlass = steel(0x365461, 0.38, 0.39);

function createWater() {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFog: { value: new Color(0x365160) },
    },
    vertexShader: `
      varying vec3 world;
      void main() {
        world = (modelMatrix * vec4(position, 1.)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.);
      }
    `,
    fragmentShader: `
      varying vec3 world;
      uniform float uTime;
      uniform vec3 uFog;
      void main() {
        float wave = sin(world.z * 16. + world.x * 4.5 + uTime * 1.8);
        wave += sin(world.z * 29. - world.x * 6. + uTime * 2.4) * .52;
        float trough = sin(world.z * 3. - world.x * 1.7 + uTime * 1.2);
        float sheen = pow(clamp(.27 + wave * .21 + trough * .05, 0., 1.), 2.);
        vec3 water = vec3(.018, .051, .075) + vec3(.044, .095, .113) * sheen;
        float band = abs(sin((world.z + .95) * .57 + trough * .11));
        float lamps = pow(max(0., 1. - band), 14.) * exp(-abs(abs(world.x) - 9.) * .9);
        water += vec3(.23, .103, .032) * lamps * max(0., wave * .32 + .47);
        float distanceToCamera = length(world - cameraPosition);
        gl_FragColor = vec4(mix(water, uFog, smoothstep(18., 88., distanceToCamera) * .83), 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}
