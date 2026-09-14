<script lang="ts">
  // The Stage screens. Rendered by App instead of the Studio chrome while
  // settings.shell is 'stage' and a full-screen Stage screen is showing; when
  // the user is on a page, App shows the normal chrome plus MenuButton.
  import Boot from './Boot.svelte';
  import MainMenu from './MainMenu.svelte';
  import Sets from './Sets.svelte';
  import { stage } from './stage.svelte';
</script>

{#if stage.screen === 'boot'}
  <Boot />
{:else if stage.screen === 'menu'}
  <MainMenu />
{:else if stage.screen === 'sets'}
  <Sets />
{/if}
