// Theremin additions (spec 8): a vertical pitch ruler beside the right hand
// with scale notes ticked, and a glowing ribbon trailing 2 s of pitch history.

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { MAJOR_SCALE, MINOR_SCALE, PITCH_NAMES } from '../music';
import { toScene, type Layer, type QualityLevel, type SceneFrame } from './types';

const HISTORY_S = 2;
const HISTORY_N = 120;

export class ThereminLayer implements Layer {
  group = new THREE.Group();
  private ruler: THREE.LineSegments;
  private rulerGeo: THREE.BufferGeometry;
  private rulerPos = new Float32Array(2 * 3 + 30 * 2 * 3);
  private labels: THREE.Sprite[] = [];
  private ribbon: Line2;
  private ribbonGeo: LineGeometry;
  private ribbonMat: LineMaterial;
  private hist = new Float32Array(HISTORY_N * 3);
  private histT = new Float32Array(HISTORY_N);
  private histLen = 0;
  private acc = 0;
  private aspect = 1.78;
  private resolution = new THREE.Vector2(1920, 1080);
  private baseMidi = 48;
  private range = 24;
  private cal = { top: 0.15, bottom: 0.85 };

  constructor(scene: THREE.Object3D) {
    this.rulerGeo = new THREE.BufferGeometry();
    this.rulerGeo.setAttribute('position', new THREE.BufferAttribute(this.rulerPos, 3));
    this.ruler = new THREE.LineSegments(this.rulerGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ruler.frustumCulled = false;
    this.group.add(this.ruler);
    for (let i = 0; i < 30; i++) {
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 48;
      const tex = new THREE.CanvasTexture(c);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.scale.set(0.08, 0.04, 1);
      (s as any).__canvas = c;
      this.labels.push(s);
      this.group.add(s);
    }
    this.ribbonGeo = new LineGeometry();
    this.ribbonGeo.setPositions(new Float32Array(HISTORY_N * 3));
    this.ribbonMat = new LineMaterial({ color: 0xffffff, linewidth: 4, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true });
    this.ribbonMat.resolution = this.resolution;
    this.ribbon = new Line2(this.ribbonGeo, this.ribbonMat);
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);
    this.group.visible = false;
    this.group.renderOrder = 6;
    scene.add(this.group);
  }

  configure(baseMidi: number, range: number, top: number, bottom: number) {
    this.baseMidi = baseMidi;
    this.range = range;
    this.cal = { top, bottom };
  }

  private drawLabel(s: THREE.Sprite, text: string) {
    const c: HTMLCanvasElement = (s as any).__canvas;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.font = '400 26px Inter, system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(text, 4, 24);
    (s.material.map as THREE.CanvasTexture).needsUpdate = true;
  }

  update(f: SceneFrame): void {
    const live = f.live;
    this.group.visible = live.theremin;
    if (!live.theremin) {
      this.histLen = 0;
      return;
    }
    // ruler x: beside the right hand (outside), fallback right of centre
    let rx = 0.5 * this.aspect;
    if (f.right.landmarks) {
      const [x] = toScene(f.right.landmarks[0], f.right.landmarks[1], this.aspect, f.mirror);
      rx = x + (f.mirror ? 0.28 : -0.28);
    }
    const span = Math.max(0.05, this.cal.bottom - this.cal.top);
    const yFor = (midi: number) => {
      const h = (midi - this.baseMidi) / this.range; // 0..1
      const imgY = this.cal.bottom - h * span;
      return (0.5 - imgY) * 2;
    };
    // main line
    let k = 0;
    this.rulerPos[k++] = rx;
    this.rulerPos[k++] = yFor(this.baseMidi);
    this.rulerPos[k++] = 0.02;
    this.rulerPos[k++] = rx;
    this.rulerPos[k++] = yFor(this.baseMidi + this.range);
    this.rulerPos[k++] = 0.02;
    // ticks at scale notes
    const scale = live.minor ? MINOR_SCALE : MAJOR_SCALE;
    let li = 0;
    for (let m = Math.ceil(this.baseMidi); m <= this.baseMidi + this.range && li < 30; m++) {
      const rel = ((m - live.key) % 12 + 12) % 12;
      if (!scale.includes(rel)) continue;
      const isRoot = rel === 0;
      const y = yFor(m);
      const len = isRoot ? 0.06 : 0.03;
      this.rulerPos[k++] = rx - len;
      this.rulerPos[k++] = y;
      this.rulerPos[k++] = 0.02;
      this.rulerPos[k++] = rx + len;
      this.rulerPos[k++] = y;
      this.rulerPos[k++] = 0.02;
      const lab = this.labels[li++];
      const near = Math.abs(69 + 12 * Math.log2(Math.max(1, live.thereminHz) / 440) - m) < 0.5;
      this.drawLabel(lab, isRoot ? `${PITCH_NAMES[m % 12]}${Math.floor(m / 12) - 1}` : PITCH_NAMES[m % 12]);
      lab.position.set(rx + 0.09, y, 0.03);
      lab.material.opacity = near ? 1 : isRoot ? 0.55 : 0.25;
    }
    for (; li < 30; li++) this.labels[li].material.opacity = 0;
    this.rulerGeo.setDrawRange(0, k / 3);
    (this.rulerGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // ribbon history
    this.acc += f.dt;
    const step = HISTORY_S / HISTORY_N;
    const midi = 69 + 12 * Math.log2(Math.max(1, live.thereminHz) / 440);
    while (this.acc >= step) {
      this.acc -= step;
      // shift
      this.hist.copyWithin(3, 0, (HISTORY_N - 1) * 3);
      this.histT.copyWithin(1, 0, HISTORY_N - 1);
      this.hist[0] = rx - 0.12;
      this.hist[1] = yFor(midi);
      this.hist[2] = 0.03;
      this.histT[0] = live.thereminVol;
      this.histLen = Math.min(HISTORY_N, this.histLen + 1);
    }
    const pos = new Float32Array(HISTORY_N * 3);
    const cols = new Float32Array(HISTORY_N * 3);
    const c = new THREE.Color(f.theme.palette.ring);
    for (let i = 0; i < HISTORY_N; i++) {
      const j = Math.min(i, Math.max(0, this.histLen - 1));
      pos[i * 3] = this.hist[j * 3] - i * (0.9 / HISTORY_N) * (f.mirror ? -1 : 1) * -1;
      pos[i * 3 + 1] = this.hist[j * 3 + 1];
      pos[i * 3 + 2] = 0.03;
      const fade = 1 - i / HISTORY_N;
      cols[i * 3] = c.r * fade * (0.4 + this.histT[j]);
      cols[i * 3 + 1] = c.g * fade * (0.4 + this.histT[j]);
      cols[i * 3 + 2] = c.b * fade * (0.4 + this.histT[j]);
    }
    this.ribbonGeo.setPositions(pos);
    this.ribbonGeo.setColors(cols);
    this.ribbonMat.linewidth = 2 + live.thereminVol * 6;
    this.ribbonMat.opacity = this.histLen > 2 ? 0.85 : 0;
    this.ribbonMat.resolution = this.resolution;
  }

  resize(w: number, h: number, aspect: number): void {
    this.aspect = aspect;
    this.resolution.set(w, h);
  }

  setQuality(_q: QualityLevel): void {}

  dispose(): void {
    this.rulerGeo.dispose();
    (this.ruler.material as THREE.Material).dispose();
    this.ribbonGeo.dispose();
    this.ribbonMat.dispose();
    this.labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
    });
  }
}
