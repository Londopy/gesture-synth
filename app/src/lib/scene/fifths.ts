// Layer 2: circle of fifths ring behind the player. Current chord root lit,
// neighbours dim glow; I -> V visibly walks the highlight; slow beat rotation.

import * as THREE from 'three';
import { degreeRoot, FIFTHS, PITCH_NAMES, hueOf } from '../music';
import type { Layer, QualityLevel, SceneFrame } from './types';

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.font = '500 64px Inter, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.4 });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.09, 0.09, 1);
  return s;
}

export class FifthsLayer implements Layer {
  group = new THREE.Group();
  private ring: THREE.LineLoop;
  private dots: THREE.Points;
  private labels: THREE.Sprite[] = [];
  private glow: THREE.Mesh[] = [];
  private dotColors: Float32Array;
  private dotSizes: Float32Array;
  private intensity = new Float32Array(12);
  private rot = 0;
  private radius = 0.78;
  private ringMat: THREE.LineBasicMaterial;

  constructor(scene: THREE.Object3D) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * this.radius, Math.sin(a) * this.radius, 0));
    }
    this.ringMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.ringMat);
    this.group.add(this.ring);

    const dotPos = new Float32Array(12 * 3);
    this.dotColors = new Float32Array(12 * 3);
    this.dotSizes = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
      const a = Math.PI / 2 - (i / 12) * Math.PI * 2;
      dotPos[i * 3] = Math.cos(a) * this.radius;
      dotPos[i * 3 + 1] = Math.sin(a) * this.radius;
      this.dotSizes[i] = 6;
      const label = makeLabel(PITCH_NAMES[FIFTHS[i]]);
      label.position.set(Math.cos(a) * (this.radius + 0.09), Math.sin(a) * (this.radius + 0.09), 0);
      this.labels.push(label);
      this.group.add(label);
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(0.06, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      glow.position.set(dotPos[i * 3], dotPos[i * 3 + 1], -0.01);
      this.glow.push(glow);
      this.group.add(glow);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.dotColors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.dotSizes, 1));
    const dotMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; void main(){ vC=color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=size; }`,
      fragmentShader: `varying vec3 vC; void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.1,d); gl_FragColor=vec4(vC,a); }`,
    });
    this.dots = new THREE.Points(geo, dotMat);
    this.group.add(this.dots);
    this.group.renderOrder = -50;
    scene.add(this.group);
  }

  update(f: SceneFrame): void {
    const root = f.live.degree > 0 ? degreeRoot(f.live.key, f.live.minor, f.live.degree) : -1;
    const keyPos = FIFTHS.indexOf(f.live.key);
    const rootPos = root >= 0 ? FIFTHS.indexOf(root) : -1;
    // slow rotation with the beat
    this.rot += f.dt * 0.02 * (0.5 + f.beatPulse * 3);
    this.group.rotation.z = Math.sin(this.rot) * 0.15;
    const col = new THREE.Color();
    const ringC = new THREE.Color(f.theme.palette.ring);
    for (let i = 0; i < 12; i++) {
      let target = 0.12;
      if (i === rootPos) target = 1;
      else if (rootPos >= 0 && (i === (rootPos + 1) % 12 || i === (rootPos + 11) % 12)) target = 0.45;
      else if (i === keyPos) target = 0.3;
      this.intensity[i] += (target - this.intensity[i]) * Math.min(1, f.dt * 8);
      const k = this.intensity[i];
      col.setHSL(hueOf(FIFTHS[i]) / 360, 0.75, 0.35 + 0.35 * k).lerp(ringC, 0.25);
      this.dotColors[i * 3] = col.r * (0.4 + 0.6 * k);
      this.dotColors[i * 3 + 1] = col.g * (0.4 + 0.6 * k);
      this.dotColors[i * 3 + 2] = col.b * (0.4 + 0.6 * k);
      this.dotSizes[i] = 5 + 14 * k + (i === rootPos ? f.beatPulse * 8 : 0);
      (this.glow[i].material as THREE.MeshBasicMaterial).opacity = k * 0.35 * (0.8 + f.live.volume * 0.4);
      (this.glow[i].material as THREE.MeshBasicMaterial).color.copy(col);
      this.glow[i].scale.setScalar(0.6 + k * (1 + f.beatPulse * 0.6));
      (this.labels[i].material as THREE.SpriteMaterial).opacity = 0.22 + 0.6 * k;
      // keep labels upright
      this.labels[i].material.rotation = -this.group.rotation.z;
    }
    (this.dots.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.dots.geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    this.ringMat.opacity = 0.08 + 0.08 * f.live.volume + f.beatPulse * 0.05;
    const s = 1 + f.beatPulse * 0.01;
    this.group.scale.setScalar(s);
    this.group.visible = f.theme.background_style !== 'flat' || true;
  }

  resize(_w: number, _h: number, aspect: number): void {
    const r = Math.min(0.85, aspect * 0.55);
    this.group.scale.setScalar(r / this.radius);
  }

  setQuality(q: QualityLevel): void {
    this.glow.forEach((g) => (g.visible = q < 3));
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
    this.labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
    });
    this.glow.forEach((g) => {
      g.geometry.dispose();
      (g.material as THREE.Material).dispose();
    });
  }
}
