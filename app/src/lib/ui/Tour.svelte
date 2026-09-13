<script lang="ts">
  // 7-step guided tour (spec 9). Live "try it" check turns green when detected.
  import { ui } from '../state/ui.svelte';
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { TOUR_STEPS } from '../tour/steps';
  import HandDiagram from './HandDiagram.svelte';

  const step = $derived(TOUR_STEPS[ui.tourStep]);
  let passed = $state(false);
  let timer = 0;

  $effect(() => {
    ui.tourStep;
    passed = false;
    clearInterval(timer);
    timer = window.setInterval(() => {
      if (!step) return;
      const ok = step.check({ live: rt.live, left: rt.left, right: rt.right, pos: rt.position, cameraOk: rt.trackingStatus === 'running', tracks: rt.tracks });
      if (ok) passed = true;
    }, 120);
    return () => clearInterval(timer);
  });

  $effect(() => {
    // highlight the chrome region
    document.querySelectorAll('[data-tour]').forEach((el) => el.classList.remove('tour-hi'));
    if (step?.highlight) document.querySelector(step.highlight)?.classList.add('tour-hi');
    return () => document.querySelectorAll('[data-tour]').forEach((el) => el.classList.remove('tour-hi'));
  });

  function next() {
    if (ui.tourStep < TOUR_STEPS.length - 1) ui.tourStep++;
    else finish();
  }
  function finish() {
    ui.tour = false;
    settings.s.tourDone = true;
  }
</script>

{#if step}
  <div class="tour glass strong fade-in" role="dialog" aria-label="Guided tour">
    <div class="row" style="justify-content:space-between">
      <span class="label">Step {ui.tourStep + 1} of {TOUR_STEPS.length}</span>
      <button class="ghost small" onclick={finish}>Skip tour</button>
    </div>
    <h2>{step.title}</h2>
    <p>{step.body}</p>
    {#if step.hands.length}
      <div class="hands">
        {#each step.hands as h}
          <HandDiagram fingers={h.fingers} tilt={h.tilt} right={h.right} y={h.y ?? 0.5} to={h.to ?? null} size={110} />
        {/each}
      </div>
    {/if}
    <div class="try" class:ok={passed}>
      <span class="check">{passed ? '✓' : '○'}</span>
      <span>{step.tryIt}</span>
    </div>
    <div class="row" style="justify-content:space-between">
      <button disabled={ui.tourStep === 0} onclick={() => ui.tourStep--}>Back</button>
      <div class="dots">
        {#each TOUR_STEPS as _, i}<i class:on={i === ui.tourStep} class:done={i < ui.tourStep}></i>{/each}
      </div>
      <button class="primary" onclick={next}>{ui.tourStep === TOUR_STEPS.length - 1 ? 'Finish' : passed ? 'Next' : 'Skip step'}</button>
    </div>
  </div>
{/if}

<style>
  .tour {
    position: absolute;
    right: 14px;
    top: 90px;
    width: min(380px, 90vw);
    padding: 16px 18px;
    z-index: 55;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hands {
    display: flex;
    justify-content: center;
    gap: 14px;
  }
  .try {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    font-size: 13px;
    transition: all var(--dur) var(--ease);
  }
  .try.ok {
    border-color: var(--ok);
    background: rgba(77, 225, 154, 0.12);
    color: var(--ok);
  }
  .check {
    font-size: 16px;
  }
  .dots {
    display: flex;
    gap: 5px;
  }
  .dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--line-strong);
  }
  .dots i.on {
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
  }
  .dots i.done {
    background: var(--ok);
  }
  .small {
    font-size: 12px;
  }
  :global(.tour-hi) {
    outline: 2px solid var(--accent) !important;
    outline-offset: 3px;
    box-shadow: 0 0 24px var(--accent-glow) !important;
  }
</style>
