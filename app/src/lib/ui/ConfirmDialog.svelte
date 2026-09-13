<script lang="ts">
  import { ui } from '../state/ui.svelte';
  function key(e: KeyboardEvent) {
    if (!ui.confirm) return;
    if (e.key === 'Escape') ui.confirm.resolve(false);
    if (e.key === 'Enter') ui.confirm.resolve(true);
  }
</script>

<svelte:window onkeydown={key} />

{#if ui.confirm}
  <div class="backdrop" role="presentation" onclick={() => ui.confirm?.resolve(false)}>
    <div class="dialog glass strong fade-in" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onclick={(e) => e.stopPropagation()}>
      <h2 id="confirm-title">{ui.confirm.title}</h2>
      <p>{ui.confirm.body}</p>
      <div class="row" style="justify-content:flex-end; margin-top: 12px">
        <button onclick={() => ui.confirm?.resolve(false)}>Cancel</button>
        <button class={ui.confirm.danger ? 'danger' : 'primary'} onclick={() => ui.confirm?.resolve(true)}>{ui.confirm.okLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: grid;
    place-items: center;
    z-index: 80;
  }
  .dialog {
    width: min(420px, 90vw);
    padding: 20px 22px;
  }
  .danger {
    border-color: var(--danger);
    background: rgba(255, 77, 94, 0.18);
  }
</style>
