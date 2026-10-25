import { Injectable, computed, signal } from '@angular/core';

/** Which rail list the lensed ref belongs to. */
export type LensKind = 'local' | 'remote';

/**
 * Root, renderer-only branch-lens state (ADR-0042).
 *
 * A lens is a **view-only ref scope**, not a checkout: it narrows `GetCommits`
 * to `HEAD ∪ <ref>` so the graph can highlight that branch's own history while
 * HEAD stays exactly where it is. Nothing in this store crosses IPC and nothing
 * here mutates the repository, the index or HEAD — it is pure renderer state
 * read by `GraphStore` (as the request's `refs`) and by the nav rail / graph
 * bar (for the active-scope affordance). Double-clicking a branch still runs
 * the ordinary checkout flow, which clears the lens.
 */
@Injectable({ providedIn: 'root' })
export class BranchLensStore {
  /** Display name of the lensed ref (`feature/x` or `origin/main`), or null. */
  readonly ref = signal<string | null>(null);
  /** Which rail list the lensed ref came from, or null when no lens is active. */
  readonly kind = signal<LensKind | null>(null);
  /** True while a ref scope is applied to the graph. */
  readonly active = computed(() => this.ref() !== null);
  /** Wire form of the scope handed to `GetCommits.refs`; empty when inactive. */
  readonly refs = computed<string[]>(() => {
    const ref = this.ref();
    return ref ? [ref] : [];
  });

  /** Apply the lens. Re-applying the same ref+kind is a no-op (no reload churn). */
  set(ref: string, kind: LensKind): void {
    if (this.ref() === ref && this.kind() === kind) return;
    this.ref.set(ref);
    this.kind.set(kind);
  }

  /** Toggle the lens: the same ref clears it, a different ref replaces it. */
  toggle(ref: string, kind: LensKind): void {
    if (this.ref() === ref) {
      this.clear();
      return;
    }
    this.set(ref, kind);
  }

  /** Drop the lens and return the graph to the plain HEAD walk. */
  clear(): void {
    this.ref.set(null);
    this.kind.set(null);
  }
}
