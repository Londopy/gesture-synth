<script lang="ts">
  // Shown while a demo plays. Lives outside the HUD so it stays visible in
  // performance view: a demo with no sign that it is a demo would look like
  // the app playing itself for no reason.
  import { demo } from '../demo/demo.svelte';
  import { DEMO_PASSES, demoById } from '../demo/songs';

  const song = $derived(demo.songId ? demoById(demo.songId) : undefined);
</script>

<div class="badge glass fade-in" role="status" aria-live="polite">
  <div class="row" style="gap:10px; justify-content:center; flex-wrap:wrap">
    <span class="pill"><span class="dot"></span>DEMO</span>
    <span class="display name">{song?.name ?? 'Demo'}</span>
    <span class="num sm dim">bar {demo.bar}/{song?.bars ?? '-'} · pass {Math.min(demo.pass + 1, DEMO_PASSES)}/{DEMO_PASSES}</span>
    <span class="row" style="gap:4px">
      <button class="ghost small" aria-label="Previous demo" onclick={() => demo.prev()}>◀</button>
      <button class="ghost small" aria-label="Next demo" onclick={() => demo.next()}>▶</button>
      <button class="ghost small" onclick={() => demo.stop('button')}>Stop <kbd>Esc</kbd></button>
    </span>
  </div>
  <div class="bar"><div class="fill" style="width:{Math.round(demo.progress * 100)}%"></div></div>
  <div class="caption">{demo.caption || ' '}</div>
</div>

<style>
  .badge {
    position: absolute;
    /* centred without transform: .fade-in animates transform and would undo a translate */
    left: calc(50% - min(300px, 46vw));
    bottom: 18px;
    width: min(600px, 92vw);
    padding: 8px 14px 10px;
    z-index: 45;
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: center;
    pointer-events: none;
  }
  .badge button {
    pointer-events: auto;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    transform: scale(calc(1 + 0.6 * var(--beat)));
    box-shadow: 0 0 calc(4px + 10px * var(--beat)) var(--accent-glow);
  }
  .name {
    font-size: 15px;
  }
  .dim {
    color: var(--text-dim);
  }
  .bar {
    height: 2px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 120ms linear;
  }
  .caption {
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.4;
    min-height: 1.4em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  kbd {
    font-size: 10px;
    margin-left: 4px;
  }
</style>
