<script lang="ts">
  // "Made by Londo" credit that opens the GitHub repo. In the desktop app the
  // webview must hand external links to the system browser, so it goes through
  // the opener plugin there; on the web it's a plain link in a new tab.
  import { isTauri } from '../platform';

  export const REPO_URL = 'https://github.com/Londopy/gesture-synth';
  export const AUTHOR_URL = 'https://github.com/Londopy';

  let { compact = false, href = REPO_URL, label = '' }: { compact?: boolean; href?: string; label?: string } = $props();

  async function open(e: MouseEvent) {
    if (!isTauri) return; // let the anchor do its thing
    e.preventDefault();
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(href);
    } catch {
      window.open(href, '_blank', 'noopener');
    }
  }
</script>

<a class="madeby" class:compact {href} target="_blank" rel="noopener noreferrer" onclick={open} title={label || 'Made by Londo · open the GitHub repository'}>
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
  {#if !compact}<span>{#if label}{label}{:else}Made by <b>Londo</b>{/if}</span>{/if}
</a>

<style>
  .madeby {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 11px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-dim);
    font-size: 12px;
    text-decoration: none;
    white-space: nowrap;
    transition: all var(--dur) var(--ease);
  }
  .madeby:hover {
    color: #fff;
    border-color: var(--accent);
    box-shadow: 0 0 16px var(--accent-glow);
    background: var(--accent-soft);
  }
  .madeby b {
    font-weight: 600;
    color: var(--text);
  }
  .madeby.compact {
    padding: 8px;
    border-radius: 10px;
  }
</style>
