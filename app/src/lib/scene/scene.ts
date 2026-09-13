// The main canvas (spec 8): renderer, camera-feed plane, layers back-to-front,
// bloom + haze post chain, beat pulse, and the graceful degradation ladder.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BackgroundLayer } from './background';
import { FifthsLayer } from './fifths';
import { HandsLayer } from './hands';
import { ConstellationLayer } from './constellation';
import { ParticlesLayer } from './particles';
import { HazePass } from './haze';
import { ThereminLayer } from './theremin';
import type { Layer, QualityLevel, SceneFrame } from './types';

export class GestureScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  haze: HazePass;
  layers: Layer[] = [];
  background: BackgroundLayer;
  fifths: FifthsLayer;
  hands: HandsLayer;
  constellation: ConstellationLayer;
  particles: ParticlesLayer;
  theremin: ThereminLayer;
  private feed: THREE.Mesh | null = null;
  private feedTex: THREE.VideoTexture | null = null;
  private feedMat: THREE.MeshBasicMaterial | null = null;
  private world = new THREE.Group();
  width = 1;
  height = 1;
  aspect = 1.78;
  quality: QualityLevel = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  private lowFor = 0;
  private highFor = 0;
  fps = 60;
  frameMs = 0;
  bloomEnabled = true;
  hazeEnabled = true;
  private pulse = 0;
  private lastBeatSeq = -1;
  private disposed = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.camera.position.z = 10;
    this.scene.add(this.world);

    this.background = new BackgroundLayer(this.scene);
    this.fifths = new FifthsLayer(this.world);
    this.hands = new HandsLayer(this.world);
    this.constellation = new ConstellationLayer(this.world, this.camera, canvas);
    this.particles = new ParticlesLayer(this.world);
    this.theremin = new ThereminLayer(this.world);
    this.layers = [this.background, this.fifths, this.hands, this.constellation, this.particles, this.theremin];

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 1.1, 0.6, 0.55);
    this.composer.addPass(this.bloom);
    this.haze = new HazePass();
    this.composer.addPass(this.haze);
    this.composer.addPass(new OutputPass());
    this.resize();
  }

  /** Attach the camera video as a tinted plane (practice / tutorial views). */
  setVideo(video: HTMLVideoElement | null) {
    if (this.feed) {
      this.world.remove(this.feed);
      this.feed.geometry.dispose();
      this.feedMat?.dispose();
      this.feedTex?.dispose();
      this.feed = null;
    }
    if (!video) return;
    this.feedTex = new THREE.VideoTexture(video);
    this.feedTex.colorSpace = THREE.SRGBColorSpace;
    this.feedMat = new THREE.MeshBasicMaterial({ map: this.feedTex, transparent: true, opacity: 0.32, depthWrite: false, color: new THREE.Color(0.55, 0.62, 0.8) });
    this.feed = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.feedMat);
    this.feed.renderOrder = -60;
    this.feed.position.z = -0.5;
    this.world.add(this.feed);
    this.fitFeed();
  }

  private fitFeed() {
    if (!this.feed || !this.feedTex) return;
    const v = this.feedTex.image as HTMLVideoElement;
    const va = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    // cover: match the landmark mapping (frame fills the scene width)
    this.feed.scale.set(this.aspect, this.aspect / va, 1);
    if (this.aspect / va < 1) this.feed.scale.set(va, 1, 1);
  }

  setFeedVisible(on: boolean, mirror: boolean) {
    if (this.feed) {
      this.feed.visible = on;
      this.feed.scale.x = Math.abs(this.feed.scale.x) * (mirror ? -1 : 1);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.aspect = w / h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
    this.camera.left = -this.aspect;
    this.camera.right = this.aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    const pw = Math.floor(w * this.renderer.getPixelRatio());
    const ph = Math.floor(h * this.renderer.getPixelRatio());
    this.layers.forEach((l) => l.resize(pw, ph, this.aspect));
    this.fitFeed();
  }

  render(f: SceneFrame) {
    if (this.disposed) return;
    const t0 = performance.now();
    this.resize();
    // beat pulse: 1.00 -> 1.02, 1.04 on beat 1
    if (f.position.beatSeq !== this.lastBeatSeq && f.position.state !== 0) {
      this.lastBeatSeq = f.position.beatSeq;
      this.pulse = f.position.lastBeatBar ? 1 : 0.5;
    }
    this.pulse = Math.max(0, this.pulse - f.dt * 4);
    f.beatPulse = this.pulse;
    this.world.scale.setScalar(1 + this.pulse * 0.04);

    for (const l of this.layers) l.update(f);
    if (this.feedMat) {
      this.feedMat.opacity = 0.22 + 0.12 * f.live.volume;
    }
    this.bloom.enabled = this.bloomEnabled && f.theme.bloom && this.quality < 2;
    this.bloom.strength = f.theme.bloom_strength * (0.9 + f.level * 0.4 + this.pulse * 0.15);
    this.haze.enabled = this.hazeEnabled && this.quality < 3;
    this.haze.update(f.live.theremin ? f.live.cutoff : f.live.degree > 0 || f.ghosts.some((g) => g.active) ? f.live.cutoff : 0.75, f.theme.haze_strength, f.dt, this.width, this.height);
    this.composer.render();
    // degradation ladder
    const ms = performance.now() - t0;
    this.frameMs = this.frameMs * 0.9 + ms * 0.1;
    this.fpsAcc += f.dt;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
      if (this.fps < 48) {
        this.lowFor += 0.5;
        this.highFor = 0;
        if (this.lowFor >= 2 && this.quality < 3) {
          this.setQuality((this.quality + 1) as QualityLevel);
          this.lowFor = 0;
        }
      } else if (this.fps > 58) {
        this.highFor += 0.5;
        this.lowFor = 0;
        if (this.highFor >= 10 && this.quality > 0) {
          this.setQuality((this.quality - 1) as QualityLevel);
          this.highFor = 0;
        }
      } else {
        this.lowFor = 0;
      }
    }
  }

  setQuality(q: QualityLevel) {
    this.quality = q;
    this.layers.forEach((l) => l.setQuality(q));
    this.renderer.setPixelRatio(q >= 2 ? 1 : Math.min(1.5, window.devicePixelRatio || 1));
    this.width = 0; // force resize
  }

  /** Capture the current frame (PNG data URL) for share thumbnails. */
  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    this.layers.forEach((l) => l.dispose());
    this.setVideo(null);
    this.composer.dispose();
    this.renderer.dispose();
  }
}
