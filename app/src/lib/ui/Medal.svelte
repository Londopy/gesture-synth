<script lang="ts">
  // A medal: tiered metal ring, dark enamel face, emoji, ribbon. Locked medals
  // are grey silhouettes; hidden ones show a "?". `shine` runs the unlock sweep.
  import { TIER_INFO, type Medal } from '../achievements/defs';

  let { medal, unlocked = false, size = 96, shine = false, hidden = false }: { medal: Medal; unlocked?: boolean; size?: number; shine?: boolean; hidden?: boolean } = $props();
  const tier = $derived(TIER_INFO[medal.tier]);
  const uid = Math.random().toString(36).slice(2, 8);
</script>

<svg class="medal" class:locked={!unlocked} class:shine width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="{unlocked ? medal.name : hidden ? 'Hidden medal' : 'Locked medal'} ({tier.name})">
  <defs>
    <linearGradient id="ring-{uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.95" />
      <stop offset="0.35" stop-color={tier.color} />
      <stop offset="0.7" stop-color={tier.color} stop-opacity="0.75" />
      <stop offset="1" stop-color="#3a3f4b" />
    </linearGradient>
    <radialGradient id="face-{uid}" cx="40%" cy="35%" r="70%">
      <stop offset="0" stop-color="#2a3044" />
      <stop offset="1" stop-color="#0b0d12" />
    </radialGradient>
    <linearGradient id="sweep-{uid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0" />
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.75" />
      <stop offset="1" stop-color="#fff" stop-opacity="0" />
    </linearGradient>
    <clipPath id="clip-{uid}"><circle cx="50" cy="56" r="40" /></clipPath>
  </defs>
  <!-- ribbon -->
  <path d="M34 4 L50 22 L66 4 L60 2 L50 13 L40 2 Z" fill={unlocked ? tier.color : '#3a3f4b'} opacity="0.9" />
  <!-- ring -->
  <circle cx="50" cy="56" r="42" fill={unlocked ? `url(#ring-${uid})` : '#2a2f3a'} />
  <circle cx="50" cy="56" r="36" fill={unlocked ? `url(#face-${uid})` : '#151820'} stroke={unlocked ? tier.color : '#3a3f4b'} stroke-opacity="0.6" stroke-width="1" />
  <!-- notches -->
  {#each Array(12) as _, i}
    {@const a = (i / 12) * Math.PI * 2}
    <circle cx={50 + Math.cos(a) * 39} cy={56 + Math.sin(a) * 39} r="1.4" fill="#000" fill-opacity="0.35" />
  {/each}
  <!-- icon -->
  <text x="50" y="58" text-anchor="middle" dominant-baseline="central" font-size="34" style="filter: {unlocked ? 'none' : 'grayscale(1) brightness(0.55)'}">{hidden && !unlocked ? '?' : medal.icon}</text>
  {#if !unlocked && !hidden}
    <text x="50" y="86" text-anchor="middle" font-size="9" fill="#fff" fill-opacity="0.35">🔒</text>
  {/if}
  {#if shine}
    <rect class="sweep" x="-60" y="0" width="60" height="100" fill="url(#sweep-{uid})" clip-path="url(#clip-{uid})" />
  {/if}
</svg>

<style>
  .medal {
    filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.45));
    transition: transform 200ms var(--ease);
  }
  .medal:not(.locked):hover {
    transform: translateY(-2px) scale(1.04);
  }
  .medal.locked {
    opacity: 0.55;
  }
  .sweep {
    animation: sweep 1.4s var(--ease) 0.5s 2;
  }
  @keyframes sweep {
    from {
      transform: translateX(0) skewX(-20deg);
    }
    to {
      transform: translateX(170px) skewX(-20deg);
    }
  }
</style>
