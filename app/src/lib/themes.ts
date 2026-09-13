// Visual themes (spec 9 "Visuals" page, spec 10 theme.gsyn.json).

export interface Theme {
  name: string;
  palette: {
    /** hue offset added to the key hue for the background */
    bgHueShift: number;
    bgSaturation: number;
    bgLightness: number;
    major: string;
    minor: string;
    ring: string;
    particle: string;
    ghost: string[];
  };
  particle_density: number; // 0..1 of the 20k budget
  bloom: boolean;
  bloom_strength: number;
  haze_strength: number;
  ghost_opacity: number;
  background_style: 'noise' | 'flat' | 'grid' | 'aurora';
}

export const THEMES: Record<string, Theme> = {
  Neon: {
    name: 'Neon',
    palette: {
      bgHueShift: 0,
      bgSaturation: 0.55,
      bgLightness: 0.08,
      major: '#ffb347',
      minor: '#7b8cff',
      ring: '#9fb4ff',
      particle: '#ffffff',
      ghost: ['#ff6ec7', '#59e0ff', '#a8ff60', '#ffd166'],
    },
    particle_density: 1,
    bloom: true,
    bloom_strength: 1.1,
    haze_strength: 1,
    ghost_opacity: 0.35,
    background_style: 'noise',
  },
  Ember: {
    name: 'Ember',
    palette: {
      bgHueShift: -20,
      bgSaturation: 0.7,
      bgLightness: 0.06,
      major: '#ff8a3d',
      minor: '#c0392b',
      ring: '#ffb08a',
      particle: '#ffd9b3',
      ghost: ['#ff7a45', '#ffb347', '#ff4d5e', '#ffe08a'],
    },
    particle_density: 0.8,
    bloom: true,
    bloom_strength: 1.4,
    haze_strength: 1.2,
    ghost_opacity: 0.3,
    background_style: 'aurora',
  },
  Ice: {
    name: 'Ice',
    palette: {
      bgHueShift: 180,
      bgSaturation: 0.35,
      bgLightness: 0.1,
      major: '#dff6ff',
      minor: '#6fb7ff',
      ring: '#bfe9ff',
      particle: '#ffffff',
      ghost: ['#8fd3ff', '#c4f1ff', '#7ea0ff', '#e0fbff'],
    },
    particle_density: 0.6,
    bloom: true,
    bloom_strength: 0.8,
    haze_strength: 0.8,
    ghost_opacity: 0.4,
    background_style: 'noise',
  },
  Mono: {
    name: 'Mono',
    palette: {
      bgHueShift: 0,
      bgSaturation: 0,
      bgLightness: 0.05,
      major: '#ffffff',
      minor: '#9a9a9a',
      ring: '#bbbbbb',
      particle: '#ffffff',
      ghost: ['#ffffff', '#cccccc', '#999999', '#666666'],
    },
    particle_density: 0.4,
    bloom: false,
    bloom_strength: 0,
    haze_strength: 0.6,
    ghost_opacity: 0.3,
    background_style: 'grid',
  },
  Vapor: {
    name: 'Vapor',
    palette: {
      bgHueShift: 60,
      bgSaturation: 0.8,
      bgLightness: 0.09,
      major: '#ff71ce',
      minor: '#01cdfe',
      ring: '#b967ff',
      particle: '#fffb96',
      ghost: ['#ff71ce', '#01cdfe', '#05ffa1', '#b967ff'],
    },
    particle_density: 1,
    bloom: true,
    bloom_strength: 1.6,
    haze_strength: 1.3,
    ghost_opacity: 0.45,
    background_style: 'aurora',
  },
};

export const THEME_NAMES = Object.keys(THEMES);

export function getTheme(name: string): Theme {
  return THEMES[name] ?? THEMES.Neon;
}

/** Convert to the spec's theme.gsyn.json shape. */
export function themeToFile(t: Theme): object {
  return {
    version: 1,
    name: t.name,
    palette: { ...t.palette, ghost: t.palette.ghost.join(',') },
    particle_density: t.particle_density,
    bloom: t.bloom,
    haze_strength: t.haze_strength,
    ghost_opacity: t.ghost_opacity,
    background_style: t.background_style,
  };
}

export function themeFromFile(o: any): Theme | null {
  if (!o || typeof o.name !== 'string') return null;
  const base = getTheme('Neon');
  const p = o.palette ?? {};
  return {
    name: o.name,
    palette: {
      bgHueShift: Number(p.bgHueShift ?? 0),
      bgSaturation: Number(p.bgSaturation ?? 0.5),
      bgLightness: Number(p.bgLightness ?? 0.08),
      major: String(p.major ?? base.palette.major),
      minor: String(p.minor ?? base.palette.minor),
      ring: String(p.ring ?? base.palette.ring),
      particle: String(p.particle ?? base.palette.particle),
      ghost: typeof p.ghost === 'string' ? p.ghost.split(',') : Array.isArray(p.ghost) ? p.ghost : base.palette.ghost,
    },
    particle_density: Number(o.particle_density ?? 1),
    bloom: Boolean(o.bloom ?? true),
    bloom_strength: Number(o.bloom_strength ?? 1),
    haze_strength: Number(o.haze_strength ?? 1),
    ghost_opacity: Number(o.ghost_opacity ?? 0.35),
    background_style: (['noise', 'flat', 'grid', 'aurora'].includes(o.background_style) ? o.background_style : 'noise') as Theme['background_style'],
  };
}
