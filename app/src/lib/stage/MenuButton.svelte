<script lang="ts">
  // Back to the Stage menu from any page. Sits where the Studio rail would be.
  import { sfx } from './sfx';
  import { stage } from './stage.svelte';
  import { demo } from '../demo/demo.svelte';
  import { ui } from '../state/ui.svelte';

  function toMenu() {
    sfx.back();
    if (demo.active) demo.stop('route');
    ui.grid = false;
    ui.help = false;
    ui.demoPicker = false;
    ui.recordSheet = false;
    ui.exportSheet = false;
    stage.toMenu();
  }
</script>

<button class="menubtn glass" onclick={toMenu} title="Back to the menu" aria-label="Menu">
  <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
  <span class="lbl">Menu</span>
</button>

<style>
  .menubtn {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 36;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 12px;
    border: 1px solid var(--line);
    color: var(--text);
    font-size: 12px;
  }
  .menubtn:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .bars {
    display: inline-flex;
    flex-direction: column;
    gap: 3px;
  }
  .bars i {
    display: block;
    width: 14px;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }
</style>
