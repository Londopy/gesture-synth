// Layer 1: slow gradient-noise background field. Hue from key, saturation from
// volume, drift speed from BPM (spec 8).

import * as THREE from 'three';
import type { Layer, QualityLevel, SceneFrame } from './types';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uHue;
uniform float uSat;
uniform float uLight;
uniform float uAspect;
uniform float uStyle; // 0 noise 1 flat 2 grid 3 aurora
uniform float uPulse;

vec3 hsl2rgb(vec3 c) {
  vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float t = uTime;
  float n = 0.0;
  if (uStyle < 0.5) {
    n = fbm(p * 1.6 + vec2(t * 0.05, -t * 0.03));
    n = smoothstep(0.25, 0.9, n);
  } else if (uStyle < 1.5) {
    n = 0.35 - length(p) * 0.15;
  } else if (uStyle < 2.5) {
    vec2 g = abs(fract(p * 6.0 + vec2(0.0, t * 0.1)) - 0.5);
    float line = smoothstep(0.48, 0.5, max(g.x, g.y));
    n = 0.2 + line * 0.25 * (0.6 + 0.4 * sin(t + p.x * 3.0));
  } else {
    float a = fbm(vec2(p.x * 1.2 + t * 0.07, p.y * 0.35 + t * 0.02));
    float band = exp(-pow((p.y + 0.15 - (a - 0.5) * 0.8) * 3.0, 2.0));
    n = band * (0.5 + 0.5 * fbm(p * 3.0 + t * 0.1));
  }
  float vignette = 1.0 - smoothstep(0.55, 1.35, length(p));
  float hueShift = (n - 0.5) * 0.08;
  vec3 col = hsl2rgb(vec3(fract(uHue / 360.0 + hueShift), uSat * (0.55 + 0.45 * n), uLight * (0.55 + 0.9 * n) * vignette));
  col += uPulse * 0.03 * vignette;
  // near-black base #0b0d12
  col = max(col, vec3(0.043, 0.051, 0.071) * vignette * 0.9);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class BackgroundLayer implements Layer {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  private drift = 0;
  private sat = 0.3;
  private hue = 0;

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uHue: { value: 0 },
        uSat: { value: 0.3 },
        uLight: { value: 0.08 },
        uAspect: { value: 1.78 },
        uStyle: { value: 0 },
        uPulse: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);
  }

  update(f: SceneFrame): void {
    // drift speed from BPM
    this.drift += f.dt * (0.6 + f.position.bpm / 120);
    const targetSat = f.theme.palette.bgSaturation * (0.45 + 0.55 * Math.min(1, f.live.volume + f.level * 0.6));
    this.sat += (targetSat - this.sat) * Math.min(1, f.dt * 3);
    const targetHue = f.keyHue + f.theme.palette.bgHueShift;
    let dh = ((targetHue - this.hue + 540) % 360) - 180;
    this.hue += dh * Math.min(1, f.dt * 2.5);
    const u = this.mat.uniforms;
    u.uTime.value = this.drift;
    u.uHue.value = this.hue;
    u.uSat.value = this.sat;
    u.uLight.value = f.theme.palette.bgLightness;
    u.uStyle.value = ['noise', 'flat', 'grid', 'aurora'].indexOf(f.theme.background_style);
    u.uPulse.value = f.beatPulse;
  }

  resize(_w: number, _h: number, aspect: number): void {
    this.mat.uniforms.uAspect.value = aspect;
  }

  setQuality(_q: QualityLevel): void {}

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
