// Layer 7: filter haze. Full-screen blur + darken driven by (1 - cutoff).
// Closed filter = soft and dark; open = crisp and bright.

import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export const HazeShader = {
  name: 'GsynHaze',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAmount: { value: 0 }, // 0..1 = 1 - cutoff
    uStrength: { value: 1 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uVignette: { value: 0.35 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uStrength; uniform vec2 uResolution; uniform float uVignette;
    varying vec2 vUv;
    void main(){
      float amt = clamp(uAmount * uStrength, 0.0, 1.0);
      vec2 px = 1.0 / uResolution;
      float r = amt * 6.0;
      vec4 c = texture2D(tDiffuse, vUv) * 0.28;
      c += texture2D(tDiffuse, vUv + vec2( r,  0.0) * px) * 0.12;
      c += texture2D(tDiffuse, vUv + vec2(-r,  0.0) * px) * 0.12;
      c += texture2D(tDiffuse, vUv + vec2(0.0,  r) * px) * 0.12;
      c += texture2D(tDiffuse, vUv + vec2(0.0, -r) * px) * 0.12;
      c += texture2D(tDiffuse, vUv + vec2( r,  r) * 0.7 * px) * 0.06;
      c += texture2D(tDiffuse, vUv + vec2(-r,  r) * 0.7 * px) * 0.06;
      c += texture2D(tDiffuse, vUv + vec2( r, -r) * 0.7 * px) * 0.06;
      c += texture2D(tDiffuse, vUv + vec2(-r, -r) * 0.7 * px) * 0.06;
      vec4 sharp = texture2D(tDiffuse, vUv);
      vec4 col = mix(sharp, c, amt);
      // darken with a soft floor so it never goes black
      col.rgb *= 1.0 - amt * 0.45;
      // vignette
      float d = length(vUv - 0.5);
      col.rgb *= 1.0 - smoothstep(0.45, 0.95, d) * uVignette * (0.6 + amt * 0.8);
      gl_FragColor = col;
    }`,
};

export class HazePass extends ShaderPass {
  private amount = 0;
  constructor() {
    super(HazeShader);
  }
  update(cutoff: number, strength: number, dt: number, w: number, h: number) {
    const target = 1 - cutoff;
    this.amount += (target - this.amount) * Math.min(1, dt * 6);
    this.uniforms.uAmount.value = this.amount;
    this.uniforms.uStrength.value = strength;
    this.uniforms.uResolution.value.set(w, h);
  }
}
