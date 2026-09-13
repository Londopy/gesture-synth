<script lang="ts">
  import { ui } from '../state/ui.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each ui.toasts as t (t.id)}
    <div class="toast glass fade-in {t.kind}">{t.text}</div>
  {/each}
</div>

<style>
  .toasts {
    position: absolute;
    left: 50%;
    bottom: 120px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
    z-index: 60;
  }
  .toast {
    padding: 9px 14px;
    font-size: 13px;
    border-radius: 12px;
  }
  .ok {
    border-color: var(--ok);
  }
  .warn {
    border-color: var(--warn);
  }
  .error {
    border-color: var(--danger);
  }
</style>
