// Built-in demo ids. Kept free of imports so achievement definitions can
// reference the set without pulling Svelte or the song data into their tests.

export const DEMO_IDS = ['lantern-waltz', 'brass-tacks', 'slow-orbit', 'circuit-breaker'] as const;
export type DemoId = (typeof DEMO_IDS)[number];
