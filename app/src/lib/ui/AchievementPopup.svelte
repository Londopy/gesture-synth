<script lang="ts">
  // osu!-style unlock toast: slides up from the bottom, medal spins in with a
  // shine sweep, tier-coloured glow, click to dismiss early.
  import { achievements } from '../achievements/store.svelte';
  import { TIER_INFO } from '../achievements/defs';
  import Medal from './Medal.svelte';
  import { router } from '../router/router.svelte';

  const m = $derived(achievements.showing);
</script>

{#if m}
  {#key m.id}
    <button class="unlock glass strong" style:--tier={TIER_INFO[m.tier].color} style:--tierglow={TIER_INFO[m.tier].glow} onclick={() => (router.go('achievements'), achievements.dismiss())} aria-live="assertive" title="Open medals">
      <div class="spin"><Medal medal={m} unlocked size={92} shine /></div>
      <div class="text">
        <span class="label">Medal unlocked · {TIER_INFO[m.tier].name} · +{TIER_INFO[m.tier].points}</span>
        <span class="name display">{m.name}</span>
        <span class="desc">{m.description}</span>
      </div>
    </button>
  {/key}
{/if}

<style>
  .unlock {
    position: absolute;
    left: 50%;
    bottom: 96px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 22px 12px 12px;
    border-radius: 999px;
    border: 1px solid var(--tier);
    box-shadow: 0 0 40px var(--tierglow), 0 20px 60px rgba(0, 0, 0, 0.5);
    z-index: 65;
    text-align: left;
    animation: rise 5.2s var(--ease) both;
    cursor: pointer;
  }
  .spin {
    animation: spinin 0.9s var(--ease) both;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 380px;
  }
  .label {
    color: var(--tier);
  }
  .name {
    font-size: 30px;
    color: #fff;
    letter-spacing: 0.05em;
    line-height: 1;
  }
  .desc {
    font-size: 13px;
    color: var(--text-dim);
  }
  @keyframes rise {
    0% {
      opacity: 0;
      transform: translate(-50%, 40px) scale(0.92);
    }
    8% {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }
    88% {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }
    100% {
      opacity: 0;
      transform: translate(-50%, -10px) scale(0.98);
    }
  }
  @keyframes spinin {
    0% {
      transform: rotateY(180deg) scale(0.5);
      opacity: 0;
    }
    100% {
      transform: rotateY(0) scale(1);
      opacity: 1;
    }
  }
</style>
