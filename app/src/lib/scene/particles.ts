// Layer 6: audio-reactive particles. GPU-drawn points with a CPU simulation
// (20k budget, degradation ladder 20k -> 8k -> 2k). Emitted from LEFT
// fingertips on ChordOn (burst size = volume, colour = chord root hue;
// sevenths add a smaller ring in a complementary hue). Right palm repels.
// Bass adds outward impulse, treble adds sparkle.

import * as THREE from 'three';
import { hueOf } from '../music';
import { FINGERTIPS } from '../tracking/landmarks';
import { toScene, type Layer, type QualityLevel, type SceneFrame } from './types';

const BUDGET = [20000, 8000, 2000, 800];

export class ParticlesLayer implements Layer {
  points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private max = BUDGET[0];
  private count = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array; // remaining seconds
  private maxLife: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private head = 0;
  private aspect = 1.78;
  private density = 1;
  private tmpColor = new THREE.Color();
  private ambientAcc = 0;

  constructor(scene: THREE.Object3D) {
    const n = BUDGET[0];
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 }, uSparkle: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float size; attribute vec3 color; attribute float alpha;
        varying vec3 vC; varying float vA; varying float vS;
        uniform float uScale; uniform float uSparkle; uniform float uTime;
        void main(){
          vC = color; vA = alpha;
          float flick = 1.0 + uSparkle * (0.5 + 0.5 * sin(uTime * 37.0 + position.x * 91.0 + position.y * 57.0));
          vS = flick;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * uScale * flick;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying float vA; varying float vS;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vC * (0.6 + 0.6 * vS), a * a * vA);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.geo.setDrawRange(0, 0);
    scene.add(this.points);
  }

  private emit(x: number, y: number, hue: number, speed: number, n: number, spread: number, size: number, life: number, sat = 0.85) {
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.max;
      this.count = Math.min(this.max, this.count + 1);
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 2] = 0.05;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = Math.sin(a) * sp + 0.05;
      this.vel[i * 3 + 2] = 0;
      const l = life * (0.6 + Math.random() * 0.8);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.tmpColor.setHSL(((hue + (Math.random() - 0.5) * 24) / 360 + 1) % 1, sat, 0.6 + Math.random() * 0.25);
      this.col[i * 3] = this.tmpColor.r;
      this.col[i * 3 + 1] = this.tmpColor.g;
      this.col[i * 3 + 2] = this.tmpColor.b;
      this.size[i] = size * (0.5 + Math.random());
      this.alpha[i] = 1;
    }
  }

  update(f: SceneFrame): void {
    const dt = Math.min(0.05, f.dt);
    const L = f.left.landmarks;
    const R = f.right.landmarks;
    // bursts (spec: from LEFT fingertips on ChordOn)
    for (const b of f.bursts) {
      const hue = hueOf(b.root);
      const n = Math.round((60 + 340 * b.volume) * this.density * (b.slot === 4 ? 1 : 0.5));
      if (b.slot === 4 && L) {
        for (const tip of FINGERTIPS) {
          const [x, y] = toScene(L[tip * 3], L[tip * 3 + 1], this.aspect, f.mirror);
          this.emit(x, y, hue, 0.5 + b.volume * 0.6, Math.ceil(n / 5), 0.03, 6, 1.6);
          if (b.seventh) this.emit(x, y, hue + 180, 0.25, Math.ceil(n / 12), 0.01, 4, 1.1, 0.6);
        }
      } else {
        // loop track bursts come from the ghost's left hand, or centre-ish
        const g = f.ghosts[b.slot];
        let x = -0.4 + Math.random() * 0.8;
        let y = -0.2 + Math.random() * 0.4;
        if (g?.left) [x, y] = toScene(g.left[8 * 3], g.left[8 * 3 + 1], this.aspect, f.mirror);
        this.tmpColor.set(g?.color ?? '#ffffff');
        const hsl = { h: 0, s: 0, l: 0 };
        this.tmpColor.getHSL(hsl);
        this.emit(x, y, hsl.h * 360, 0.35, n, 0.06, 5, 1.4, 0.7);
      }
    }
    // bass hits: a ring from the bottom centre
    for (let i = 0; i < f.bassHits; i++) this.emit(0, -0.7, f.keyHue, 0.9, Math.round(120 * this.density), 0.4, 7, 1.2);
    // ambient sparkle when a chord sustains
    if (f.live.degree > 0 && f.live.volume > 0.05 && L) {
      this.ambientAcc += dt * (20 + 60 * f.live.volume) * this.density;
      while (this.ambientAcc >= 1) {
        this.ambientAcc -= 1;
        const tip = FINGERTIPS[(Math.random() * 5) | 0];
        const [x, y] = toScene(L[tip * 3], L[tip * 3 + 1], this.aspect, f.mirror);
        this.emit(x, y, hueOf(f.live.notes[0] % 12), 0.12, 1, 0.02, 3.5, 1.2);
      }
    }
    // repeller = right palm
    let rx = 0;
    let ry = 0;
    let repel = false;
    if (R) {
      [rx, ry] = toScene((R[0] + R[9 * 3]) / 2, (R[1] + R[9 * 3 + 1]) / 2, this.aspect, f.mirror);
      repel = true;
    }
    const bassImpulse = f.bass * f.bass * 1.6;
    const drag = Math.exp(-dt * 1.2);
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      let vx = this.vel[i * 3];
      let vy = this.vel[i * 3 + 1];
      let px = this.pos[i * 3];
      let py = this.pos[i * 3 + 1];
      if (repel) {
        const dx = px - rx;
        const dy = py - ry;
        const d2 = dx * dx + dy * dy + 0.002;
        if (d2 < 0.16) {
          const k = (0.05 / d2) * dt;
          vx += dx * k;
          vy += dy * k;
        }
      }
      if (bassImpulse > 0.05) {
        const len = Math.hypot(px, py) + 1e-3;
        vx += (px / len) * bassImpulse * dt;
        vy += (py / len) * bassImpulse * dt;
      }
      vx *= drag;
      vy *= drag;
      vy -= 0.02 * dt;
      px += vx * dt;
      py += vy * dt;
      this.vel[i * 3] = vx;
      this.vel[i * 3 + 1] = vy;
      this.pos[i * 3] = px;
      this.pos[i * 3 + 1] = py;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2) * (0.6 + 0.4 * f.live.volume);
      alive++;
    }
    this.geo.setDrawRange(0, this.count);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    if (f.bursts.length || f.bassHits) {
      (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    }
    this.mat.uniforms.uSparkle.value = Math.min(1, f.treble * 2.5);
    this.mat.uniforms.uTime.value = f.time;
    this.points.visible = alive > 0;
    this.density = f.theme.particle_density;
  }

  setDensity(d: number) {
    this.density = d;
  }

  resize(_w: number, h: number, aspect: number): void {
    this.aspect = aspect;
    this.mat.uniforms.uScale.value = Math.max(0.6, Math.min(1.6, h / 900));
  }

  setQuality(q: QualityLevel): void {
    this.max = BUDGET[q];
    this.head %= this.max;
    this.count = Math.min(this.count, this.max);
    for (let i = this.max; i < BUDGET[0]; i++) this.life[i] = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
