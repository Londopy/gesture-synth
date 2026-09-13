// Transient UI state: overlays, performance view, toasts, confirm dialogs.

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
  until: number;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  okLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

class UiStore {
  performance = $state(false); // F: hide all chrome
  help = $state(false);
  tour = $state(false);
  tourStep = $state(0);
  grid = $state(false);
  exportSheet = $state(false);
  recordSheet = $state(false);
  shareSheet = $state(false);
  railOpen = $state(false);
  toasts = $state<Toast[]>([]);
  confirm = $state<ConfirmRequest | null>(null);
  chordPopover = $state<{ track: number; step: number; x: number; y: number } | null>(null);
  hudVisible = $state(true);
  private hudTimer = 0;
  private toastId = 1;

  toggleFullscreen() {
    this.performance = !this.performance;
    if (this.performance) {
      this.grid = false;
      this.help = false;
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  toggleHelp() {
    this.help = !this.help;
  }

  toggleGrid() {
    this.grid = !this.grid;
  }

  toast(text: string, kind: Toast['kind'] = 'info', ms = 3200) {
    const id = this.toastId++;
    this.toasts = [...this.toasts, { id, text, kind, until: performance.now() + ms }];
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), ms);
  }

  ask(title: string, body: string, okLabel = 'OK', danger = false): Promise<boolean> {
    return new Promise((resolve) => {
      this.confirm = { title, body, okLabel, danger, resolve: (ok) => (this.confirm = null, resolve(ok)) };
    });
  }

  /** HUD fades out after 2 s of no change in performance view. */
  pokeHud() {
    this.hudVisible = true;
    clearTimeout(this.hudTimer);
    this.hudTimer = window.setTimeout(() => (this.hudVisible = false), 2000);
  }

  startTour() {
    this.tourStep = 0;
    this.tour = true;
    this.help = false;
  }
}

export const ui = new UiStore();
