// Layer 4: wireframe hands. 21 glowing landmark points + fat emissive bones.
// Left colour = quality (warm major / cool minor). Right brightness = cutoff,
// thickness = volume. Extended fingers glow brighter. Also renders up to four
// translucent ghost pairs (loop tracks) and the Learn target outline.

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { HAND_BONES, LANDMARK_FINGER } from '../tracking/landmarks';
import { toScene, type Layer, type QualityLevel, type SceneFrame } from './types';

class HandMesh {
  group = new THREE.Group();
  lines: LineSegments2;
  lineGeo: LineSegmentsGeometry;
  lineMat: LineMaterial;
  points: THREE.Points;
  pointGeo: THREE.BufferGeometry;
  pointMat: THREE.ShaderMaterial;
  private pos = new Float32Array(HAND_BONES.length * 6);
  private cols = new Float32Array(HAND_BONES.length * 6);
  private ppos = new Float32Array(21 * 3);
  private pcol = new Float32Array(21 * 3);
  private psize = new Float32Array(21);
  private smooth = new Float32Array(63);
  private hasSmooth = false;
  private fade = 0;

  constructor(parent: THREE.Object3D, private resolution: THREE.Vector2) {
    this.lineGeo = new LineSegmentsGeometry();
    this.lineGeo.setPositions(this.pos);
    this.lineGeo.setColors(this.cols);
    this.lineMat = new LineMaterial({ vertexColors: true, linewidth: 3, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    this.lineMat.resolution = resolution;
    this.lines = new LineSegments2(this.lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    this.pointGeo = new THREE.BufferGeometry();
    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(this.ppos, 3));
    this.pointGeo.setAttribute('color', new THREE.BufferAttribute(this.pcol, 3));
    this.pointGeo.setAttribute('size', new THREE.BufferAttribute(this.psize, 1));
    this.pointMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 1 }, uScale: { value: 1 } },
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uScale; void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=size*uScale; }`,
      fragmentShader: `varying vec3 vC; uniform float uOpacity; void main(){ float d=length(gl_PointCoord-0.5); float core=smoothstep(0.5,0.05,d); float halo=smoothstep(0.5,0.0,d)*0.35; gl_FragColor=vec4(vC*(core+halo), (core+halo)*uOpacity); }`,
    });
    this.points = new THREE.Points(this.pointGeo, this.pointMat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    parent.add(this.group);
  }

  /**
   * @param lm 63 floats image coords, or null to fade out
   * @param color base colour
   * @param brightness 0..1 multiplier
   * @param width line width px
   * @param opacity 0..1
   * @param fingers extended flags (brighter) or null
   * @param smoothing 0 = none, else one-pole factor per frame
   */
  update(
    lm: Float32Array | null,
    color: THREE.Color,
    brightness: number,
    width: number,
    opacity: number,
    fingers: readonly boolean[] | null,
    aspect: number,
    mirror: boolean,
    dt: number,
    smoothing = 0.55,
  ) {
    if (!lm) {
      this.fade = Math.max(0, this.fade - dt * 4);
      this.hasSmooth = this.fade > 0;
      if (this.fade <= 0) {
        this.group.visible = false;
        return;
      }
    } else {
      this.fade = Math.min(1, this.fade + dt * 6);
      if (!this.hasSmooth) {
        this.smooth.set(lm);
        this.hasSmooth = true;
      } else {
        const k = smoothing;
        for (let i = 0; i < 63; i++) this.smooth[i] += (lm[i] - this.smooth[i]) * k;
      }
    }
    this.group.visible = true;
    const s = this.smooth;
    const a = opacity * this.fade;
    for (let i = 0; i < 21; i++) {
      const [x, y] = toScene(s[i * 3], s[i * 3 + 1], aspect, mirror);
      this.ppos[i * 3] = x;
      this.ppos[i * 3 + 1] = y;
      this.ppos[i * 3 + 2] = 0.02;
      const f = LANDMARK_FINGER[i];
      const ext = fingers && f >= 0 ? (fingers[f] ? 1 : 0.35) : 0.75;
      const b = brightness * (0.5 + 0.5 * ext);
      this.pcol[i * 3] = color.r * b;
      this.pcol[i * 3 + 1] = color.g * b;
      this.pcol[i * 3 + 2] = color.b * b;
      const tip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
      this.psize[i] = (tip ? 9 : i === 0 ? 8 : 5.5) * (0.7 + 0.5 * ext) * (0.8 + width * 0.08);
    }
    for (let b = 0; b < HAND_BONES.length; b++) {
      const [i, j] = HAND_BONES[b];
      this.pos[b * 6] = this.ppos[i * 3];
      this.pos[b * 6 + 1] = this.ppos[i * 3 + 1];
      this.pos[b * 6 + 2] = 0.01;
      this.pos[b * 6 + 3] = this.ppos[j * 3];
      this.pos[b * 6 + 4] = this.ppos[j * 3 + 1];
      this.pos[b * 6 + 5] = 0.01;
      const f = LANDMARK_FINGER[j];
      const ext = fingers && f >= 0 ? (fingers[f] ? 1 : 0.4) : 0.8;
      const bb = brightness * (0.45 + 0.55 * ext);
      for (let k = 0; k < 2; k++) {
        this.cols[b * 6 + k * 3] = color.r * bb;
        this.cols[b * 6 + k * 3 + 1] = color.g * bb;
        this.cols[b * 6 + k * 3 + 2] = color.b * bb;
      }
    }
    this.lineGeo.setPositions(this.pos);
    this.lineGeo.setColors(this.cols);
    this.lineMat.linewidth = width;
    this.lineMat.opacity = a;
    this.lineMat.resolution = this.resolution;
    (this.pointGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    this.pointMat.uniforms.uOpacity.value = a;
  }

  setPointScale(s: number) {
    this.pointMat.uniforms.uScale.value = s;
  }

  dispose() {
    this.lineGeo.dispose();
    this.lineMat.dispose();
    this.pointGeo.dispose();
    this.pointMat.dispose();
  }
}

export class HandsLayer implements Layer {
  group = new THREE.Group();
  private left: HandMesh;
  private right: HandMesh;
  private ghosts: [HandMesh, HandMesh][] = [];
  private targetL: HandMesh;
  private targetR: HandMesh;
  private aspect = 1.78;
  private resolution = new THREE.Vector2(1920, 1080);
  private ghostSkip = 1;
  private frame = 0;
  private tmp = new THREE.Color();
  private leftColor = new THREE.Color('#ffb347');

  constructor(scene: THREE.Object3D) {
    this.left = new HandMesh(this.group, this.resolution);
    this.right = new HandMesh(this.group, this.resolution);
    for (let i = 0; i < 4; i++) this.ghosts.push([new HandMesh(this.group, this.resolution), new HandMesh(this.group, this.resolution)]);
    this.targetL = new HandMesh(this.group, this.resolution);
    this.targetR = new HandMesh(this.group, this.resolution);
    this.group.renderOrder = 10;
    scene.add(this.group);
  }

  update(f: SceneFrame): void {
    this.frame++;
    const live = f.live;
    // left: quality colour
    const major = new THREE.Color(f.theme.palette.major);
    const minor = new THREE.Color(f.theme.palette.minor);
    const target = live.quality === 1 ? minor : live.quality === 2 ? minor.clone().lerp(major, 0.3) : major;
    this.leftColor.lerp(target, Math.min(1, f.dt * 6));
    const leftBright = live.degree > 0 ? 1 : 0.55;
    this.left.update(f.left.present ? f.left.landmarks : null, this.leftColor, leftBright * (0.85 + f.beatPulse * 0.3), 2.5 + live.volume * 2, 1, f.left.fingers, this.aspect, f.mirror, f.dt);
    // right: brightness = cutoff, thickness = volume
    this.tmp.set('#ffffff').lerp(new THREE.Color(f.theme.palette.ring), 0.35);
    const rb = 0.35 + 0.65 * live.cutoff;
    this.right.update(f.right.present ? f.right.landmarks : null, this.tmp, rb, 1.5 + live.volume * 5, 1, f.right.fingers, this.aspect, f.mirror, f.dt);
    // ghosts
    const doGhost = this.frame % this.ghostSkip === 0;
    for (let i = 0; i < 4; i++) {
      const g = f.ghosts[i];
      const [gl, gr] = this.ghosts[i];
      const col = new THREE.Color(g?.color ?? f.theme.palette.ghost[i]);
      const op = f.theme.ghost_opacity * (g?.state.degree ? 1 : 0.6);
      if (!g || !g.active) {
        gl.update(null, col, 1, 1, op, null, this.aspect, f.mirror, f.dt);
        gr.update(null, col, 1, 1, op, null, this.aspect, f.mirror, f.dt);
        continue;
      }
      if (doGhost) {
        gl.update(g.left, col, 0.9, 2, op, null, this.aspect, f.mirror, f.dt, 0.4);
        gr.update(g.right, col, 0.7 + 0.3 * g.state.cutoff, 1.5 + g.state.volume * 3, op, null, this.aspect, f.mirror, f.dt, 0.4);
      }
    }
    // learn target outline
    if (f.learn) {
      const okC = new THREE.Color('#4de19a');
      const outline = new THREE.Color('#ffffff');
      this.targetL.update(f.learn.left, f.learn.matchLeft ? okC : outline, 0.9, 2, 0.5 + 0.3 * f.learn.countdown, null, this.aspect, f.mirror, f.dt, 0.3);
      this.targetR.update(f.learn.right, f.learn.matchRight ? okC : outline, 0.9, 2, 0.5 + 0.3 * f.learn.countdown, null, this.aspect, f.mirror, f.dt, 0.3);
    } else {
      this.targetL.update(null, this.tmp, 1, 1, 0, null, this.aspect, f.mirror, f.dt);
      this.targetR.update(null, this.tmp, 1, 1, 0, null, this.aspect, f.mirror, f.dt);
    }
  }

  resize(w: number, h: number, aspect: number): void {
    this.aspect = aspect;
    this.resolution.set(w, h);
    const ps = Math.max(0.7, Math.min(1.6, h / 900));
    [this.left, this.right, this.targetL, this.targetR, ...this.ghosts.flat()].forEach((m) => m.setPointScale(ps));
  }

  setQuality(q: QualityLevel): void {
    this.ghostSkip = q >= 3 ? 3 : q >= 2 ? 2 : 1;
  }

  dispose(): void {
    [this.left, this.right, this.targetL, this.targetR, ...this.ghosts.flat()].forEach((m) => m.dispose());
  }
}
