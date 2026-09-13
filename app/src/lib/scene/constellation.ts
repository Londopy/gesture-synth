// Layer 5: note constellation. Each chord note = a node; angle = pitch class
// (circle-of-fifths order), radius = octave; edges = intervals. Anchored
// between the two hands; reshuffles with a 150 ms eased tween.

import * as THREE from 'three';
import { fifthsIndex, hueOf, noteName } from '../music';
import { toScene, type Layer, type QualityLevel, type SceneFrame } from './types';

const MAX_NODES = 4;
const INTERVAL_NAMES = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7'];

function labelSprite(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
  s.scale.set(0.2, 0.05, 1);
  (s as any).__canvas = c;
  return s;
}

function drawLabel(s: THREE.Sprite, text: string, size = 30) {
  const c: HTMLCanvasElement = (s as any).__canvas;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.font = `400 ${size}px Inter, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(text, c.width / 2, c.height / 2);
  (s.material.map as THREE.CanvasTexture).needsUpdate = true;
}

function ease(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export class ConstellationLayer implements Layer {
  group = new THREE.Group();
  private nodes: THREE.Mesh[] = [];
  private nodeLabels: THREE.Sprite[] = [];
  private edges: THREE.Line;
  private edgeGeo: THREE.BufferGeometry;
  private edgePos = new Float32Array(6 * 2 * 3);
  private edgeLabels: THREE.Sprite[] = [];
  private from: THREE.Vector2[] = [];
  private to: THREE.Vector2[] = [];
  private tween = 1;
  private lastKey = '';
  private anchor = new THREE.Vector2(0, 0);
  private aspect = 1.78;
  private hover = -1;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(2, 2);
  private camera: THREE.Camera;
  private notes: number[] = [];

  constructor(scene: THREE.Object3D, camera: THREE.Camera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    for (let i = 0; i < MAX_NODES; i++) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.nodes.push(m);
      this.group.add(m);
      const l = labelSprite();
      this.nodeLabels.push(l);
      this.group.add(l);
      this.from.push(new THREE.Vector2());
      this.to.push(new THREE.Vector2());
    }
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(this.edgePos, 3));
    this.edges = new THREE.LineSegments(this.edgeGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }));
    this.edges.frustumCulled = false;
    this.group.add(this.edges);
    for (let i = 0; i < 6; i++) {
      const l = labelSprite();
      this.edgeLabels.push(l);
      this.group.add(l);
    }
    this.group.renderOrder = 5;
    scene.add(this.group);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    canvas.addEventListener('pointerleave', () => this.pointer.set(2, 2));
  }

  private layout(notes: number[], out: THREE.Vector2[]) {
    for (let i = 0; i < notes.length; i++) {
      const pc = notes[i] % 12;
      const oct = Math.floor(notes[i] / 12) - 1; // 3..6 typical
      const a = Math.PI / 2 - (fifthsIndex(pc) / 12) * Math.PI * 2;
      const r = 0.09 + 0.055 * Math.max(0, oct - 2);
      out[i].set(Math.cos(a) * r, Math.sin(a) * r);
    }
  }

  update(f: SceneFrame): void {
    const live = f.live;
    const notes = live.notes;
    // anchor between hands (or centre)
    let ax = 0;
    let ay = -0.05;
    const L = f.left.landmarks;
    const R = f.right.landmarks;
    if (L && R) {
      const [lx, ly] = toScene(L[0], L[1], this.aspect, f.mirror);
      const [rx, ry] = toScene(R[0], R[1], this.aspect, f.mirror);
      ax = (lx + rx) / 2;
      ay = (ly + ry) / 2 + 0.1;
    } else if (L || R) {
      const h = (L ?? R)!;
      const [x, y] = toScene(h[0], h[1], this.aspect, f.mirror);
      ax = x + (L ? -0.35 : 0.35) * (f.mirror ? -1 : 1);
      ay = y + 0.1;
    }
    this.anchor.x += (ax - this.anchor.x) * Math.min(1, f.dt * 5);
    this.anchor.y += (ay - this.anchor.y) * Math.min(1, f.dt * 5);
    this.group.position.set(this.anchor.x, this.anchor.y, 0);

    const key = notes.join(',');
    if (key !== this.lastKey) {
      this.lastKey = key;
      // start tween from current positions
      const t = ease(Math.min(1, this.tween));
      for (let i = 0; i < MAX_NODES; i++) this.from[i].lerpVectors(this.from[i], this.to[i], t);
      this.layout(notes, this.to);
      for (let i = notes.length; i < MAX_NODES; i++) this.to[i].set(0, 0);
      this.tween = 0;
      this.notes = notes.slice();
      for (let i = 0; i < MAX_NODES; i++) {
        if (i < notes.length) drawLabel(this.nodeLabels[i], noteName(notes[i]));
      }
    }
    this.tween = Math.min(1, this.tween + f.dt / 0.15);
    const t = ease(this.tween);
    const vis = notes.length > 0 ? 1 : 0;
    const scale = 1 + f.beatPulse * 0.04 + live.volume * 0.4;
    const pos: THREE.Vector2[] = [];
    for (let i = 0; i < MAX_NODES; i++) {
      const p = new THREE.Vector2().lerpVectors(this.from[i], this.to[i], t).multiplyScalar(scale);
      pos.push(p);
      const m = this.nodes[i];
      const mat = m.material as THREE.MeshBasicMaterial;
      const on = i < notes.length;
      mat.opacity += (((on ? 0.9 : 0) * vis) - mat.opacity) * Math.min(1, f.dt * 10);
      if (on) mat.color.setHSL(hueOf(notes[i] % 12) / 360, 0.8, 0.7);
      m.position.set(p.x, p.y, 0.03);
      m.scale.setScalar(on ? 1 + (i === 0 ? 0.3 : 0) + f.beatPulse * 0.3 : 0.01);
      const l = this.nodeLabels[i];
      l.position.set(p.x, p.y + 0.05, 0.03);
      l.material.opacity = on ? 0.55 : 0;
    }
    // edges: all pairs
    let e = 0;
    this.hover = -1;
    // raycast hover on nodes for interval labels
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.nodes.slice(0, notes.length), false);
    if (hits.length) this.hover = this.nodes.indexOf(hits[0].object as THREE.Mesh);
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        if (e >= 6) break;
        this.edgePos[e * 6] = pos[i].x;
        this.edgePos[e * 6 + 1] = pos[i].y;
        this.edgePos[e * 6 + 2] = 0.02;
        this.edgePos[e * 6 + 3] = pos[j].x;
        this.edgePos[e * 6 + 4] = pos[j].y;
        this.edgePos[e * 6 + 5] = 0.02;
        const lab = this.edgeLabels[e];
        const show = this.hover === i || this.hover === j;
        if (show) {
          const semis = ((notes[j] - notes[i]) % 12 + 12) % 12;
          drawLabel(lab, INTERVAL_NAMES[semis], 26);
          lab.position.set((pos[i].x + pos[j].x) / 2, (pos[i].y + pos[j].y) / 2 + 0.02, 0.04);
        }
        lab.material.opacity += ((show ? 0.9 : 0) - lab.material.opacity) * Math.min(1, f.dt * 12);
        e++;
      }
    }
    for (let k = e; k < 6; k++) {
      this.edgePos.fill(0, k * 6, k * 6 + 6);
      this.edgeLabels[k].material.opacity = 0;
    }
    (this.edgeGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.edgeGeo.setDrawRange(0, e * 2);
    (this.edges.material as THREE.LineBasicMaterial).opacity = 0.18 * vis + 0.25 * live.volume * vis;
    this.group.visible = !live.theremin;
  }

  resize(_w: number, _h: number, aspect: number): void {
    this.aspect = aspect;
  }

  setQuality(_q: QualityLevel): void {}

  dispose(): void {
    this.nodes.forEach((n) => {
      n.geometry.dispose();
      (n.material as THREE.Material).dispose();
    });
    [...this.nodeLabels, ...this.edgeLabels].forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
    });
    this.edgeGeo.dispose();
    (this.edges.material as THREE.Material).dispose();
  }
}
