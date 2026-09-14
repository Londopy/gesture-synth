<script lang="ts">
  // Stage intro: a hand counts I to VII finger by finger while the title
  // fades in. Two and a half seconds, any key or click skips it. It plays at
  // most three times in total; after that Stage opens on the menu.
  import { onMount } from 'svelte';
  import HandDiagram from '../ui/HandDiagram.svelte';
  import { leftFingersFor } from '../learn/songs';
  import { ROMAN } from '../music';
  import { stage } from './stage.svelte';

  let degree = $state(1);
  let shown = $state(false);

  onMount(() => {
    const t0 = performance.now();
    shown = true;
    const iv = setInterval(() => {
      degree = Math.min(7, 1 + Math.floor((performance.now() - t0) / 280));
    }, 60);
    const done = setTimeout(() => stage.introDone(), 2500);
    const skip = () => stage.introDone();
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      clearInterval(iv);
      clearTimeout(done);
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  });
</script>

<div class="boot" class:shown>
  <div class="hand">
    <HandDiagram fingers={leftFingersFor(degree)} tilt={22} right={false} size={220} animate={false} />
    <div class="roman display">{ROMAN[degree - 1]}</div>
  </div>
  <div class="title display">GESTURE SYNTH</div>
  <div class="hint">any key to skip</div>
</div>

<style>
  .boot {
    position: absolute;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 18px;
    background: rgba(8, 9, 13, 0.55);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    opacity: 0;
    transition: opacity 400ms var(--ease);
  }
  .boot.shown {
    opacity: 1;
  }
  .hand {
    position: relative;
    display: grid;
    place-items: center;
  }
  .roman {
    position: absolute;
    right: -48px;
    bottom: 24px;
    font-size: 44px;
    color: var(--accent);
    text-shadow: 0 0 18px var(--accent-glow);
  }
  .title {
    font-size: clamp(28px, 5vw, 56px);
    letter-spacing: 0.22em;
    color: var(--text);
    text-shadow: 0 0 24px var(--accent-glow);
    animation: rise 1400ms var(--ease) both;
  }
  .hint {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
      letter-spacing: 0.4em;
    }
    to {
      opacity: 1;
      transform: none;
      letter-spacing: 0.22em;
    }
  }
</style>
