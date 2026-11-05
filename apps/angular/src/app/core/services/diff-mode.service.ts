import { Injectable, computed, signal } from '@angular/core';

/** Selectable diff layouts of the read-only diff viewer. */
export type DiffMode = 'unified' | 'side-by-side';

/** localStorage key for the persisted diff mode (matches the `st:` shell convention). */
const DIFF_MODE_STORAGE_KEY = 'st:diffMode';

/**
 * Root diff-layout preference: resolves the active {@link DiffMode} and persists
 * it to localStorage.
 *
 * This is a **renderer-local view preference** — no IPC and no core involvement:
 * the diff payload is always the same; only the viewer's presentation changes.
 * `unified` is the default (P4 behaviour flip): side-by-side stays one click
 * away, both from the diff-pane toggle and from Settings (P5, which reuses this
 * service). The initial value is read synchronously during construction so the
 * first render already honours a persisted choice.
 */
@Injectable({ providedIn: 'root' })
export class DiffModeService {
  private readonly state = signal<DiffMode>(this.readInitial());
  readonly mode = this.state.asReadonly();

  /** True while the viewer must render side-by-side. */
  readonly sideBySide = computed(() => this.state() === 'side-by-side');

  /** Apply an explicit diff mode. */
  setMode(mode: DiffMode): void {
    this.state.set(mode);
    this.persist(mode);
  }

  /** Flip between `unified` and `side-by-side`. */
  toggle(): void {
    this.setMode(this.state() === 'unified' ? 'side-by-side' : 'unified');
  }

  /** Read the persisted mode, defaulting to `unified` for missing/invalid values. */
  private readInitial(): DiffMode {
    try {
      return localStorage.getItem(DIFF_MODE_STORAGE_KEY) === 'side-by-side'
        ? 'side-by-side'
        : 'unified';
    } catch {
      return 'unified';
    }
  }

  private persist(mode: DiffMode): void {
    try {
      localStorage.setItem(DIFF_MODE_STORAGE_KEY, mode);
    } catch {
      // Private mode / storage disabled: the preference lives this session only.
    }
  }
}
