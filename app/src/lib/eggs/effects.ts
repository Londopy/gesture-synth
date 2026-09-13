// What happens when an easter egg fires: particles in the scene, an emoji pop
// in the HUD, sometimes a sound, and the "secrets found" record in settings.

import type { GestureScene } from '../scene/scene';
import { toScene } from '../scene/types';
import { EGG_INFO, heartPoints, ringPoints, type EggEvent } from './detect';
import { ui } from '../state/ui.svelte';
import { settings } from '../state/settings.svelte';
import { THEMES } from '../themes';

const FIRE_COLUMN = (() => {
  const n = 70;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = (Math.random() - 0.5) * 0.35;
    out[i * 2 + 1] = Math.random() * 0.1;
  }
  return out;
})();

export function unlockArcadeTheme() {
  if (!THEMES.Arcade) {
    THEMES.Arcade = {
      name: 'Arcade',
      palette: { bgHueShift: 250, bgSaturation: 0.9, bgLightness: 0.06, major: '#ffe600', minor: '#00e5ff', ring: '#ff2bd6', particle: '#ffffff', ghost: ['#ff2bd6', '#00e5ff', '#39ff14', '#ffe600'] },
      particle_density: 1,
      bloom: true,
      bloom_strength: 1.9,
      haze_strength: 0.4,
      ghost_opacity: 0.5,
      background_style: 'grid',
    };
  }
}

function record(id: string) {
  if (!settings.s.eggsFound.includes(id)) {
    settings.s.eggsFound = [...settings.s.eggsFound, id];
    const n = settings.s.eggsFound.length;
    setTimeout(() => ui.toast(`Secret found (${n}/${Object.keys(EGG_INFO).length}). See Help › Secrets.`, 'ok', 3500), 900);
  }
}

export function fireEgg(e: EggEvent, scene: GestureScene, mirror: boolean) {
  const info = EGG_INFO[e.id];
  const [sx, sy] = toScene(e.x, e.y, scene.aspect, mirror);
  const P = scene.particles;
  if (!e.sustain) {
    ui.showEgg(e.id, info.emoji, info.name);
    record(e.id);
  }
  switch (e.id) {
    case 'heart': {
      // a big pink heart between the hands, then little hearts floating up
      P.emitShape(sx, sy, heartPoints(420, 0.42), 345, { size: 7, life: 2.2, sat: 0.95, radial: 0.05, vy: 0.12, perPoint: 2, hueSpread: 25 });
      for (let k = 0; k < 5; k++) {
        P.emitShape(sx + (Math.random() - 0.5) * 0.6, sy - 0.1 + Math.random() * 0.2, heartPoints(60, 0.06 + Math.random() * 0.06), 340 + Math.random() * 30, { size: 4, life: 2.8, vy: 0.35 + Math.random() * 0.2, sat: 0.9 });
      }
      break;
    }
    case 'thumbs':
      P.emitShape(sx, sy, ringPoints(200, 0.05), 140, { size: 8, life: 1.6, radial: 1.2, vy: 0.2, perPoint: 3, hueSpread: 30 });
      break;
    case 'wave':
      for (let r = 0; r < 4; r++) P.emitShape(sx, sy, ringPoints(160, 0.06 + r * 0.05), 200 + r * 12, { size: 5, life: 1.3 + r * 0.2, radial: 0.55 + r * 0.15, vy: 0 });
      break;
    case 'clap':
      P.emitShape(sx, sy, ringPoints(300, 0.03), 45, { size: 7, life: 1.1, radial: 1.8, vy: 0.05, perPoint: 2, hueSpread: 40 });
      break;
    case 'fire':
      // continuous while held: columns of flame from both fists, drifting up
      P.emitShape(sx - 0.45, sy - 0.05, FIRE_COLUMN, 22, { size: 7, life: 1.4, vy: 0.9, sat: 1, hueSpread: 30, jitter: 0.05 });
      P.emitShape(sx + 0.45, sy - 0.05, FIRE_COLUMN, 22, { size: 7, life: 1.4, vy: 0.9, sat: 1, hueSpread: 30, jitter: 0.05 });
      if (!e.sustain) P.emitShape(sx, sy + 0.1, ringPoints(240, 0.1), 30, { size: 6, life: 1.6, radial: 1.4, vy: 0.3, hueSpread: 30 });
      break;
    case 'ok':
      P.emitShape(sx, sy, ringPoints(180, 0.12), 50, { size: 5, life: 1.8, radial: 0.12, vy: 0.25, sat: 0.7, perPoint: 2 });
      break;
    case 'prayer':
      // slow golden halo
      for (let r = 0; r < 3; r++) P.emitShape(sx, sy - 0.15, ringPoints(220, 0.18 + r * 0.08), 46, { size: 4, life: 3.5, radial: 0.06, vy: 0.04, sat: 0.75, hueSpread: 10 });
      break;
    case 'highfive':
      P.emitShape(sx, sy, ringPoints(260, 0.04), 190, { size: 9, life: 1.0, radial: 2.4, vy: 0, perPoint: 2, hueSpread: 60 });
      break;
    case 'flip':
      scene.flipUntil = performance.now() / 1000 + 3.2;
      break;
    case 'konami':
      unlockArcadeTheme();
      settings.s.theme = 'Arcade';
      P.emitShape(0, 0, ringPoints(400, 0.05), 300, { size: 8, life: 2.5, radial: 1.6, vy: 0.1, perPoint: 3, hueSpread: 360 });
      break;
  }
}
