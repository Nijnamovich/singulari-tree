import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { AppError } from '@core/services/ipc-bridge.service';
import { ModalComponent } from '@shared/ui/modal/modal';
import { ButtonComponent, SelectComponent } from '@singularitree/ui-kit';
import { type FetchIntent, type RemoteOpProgress, type RemoteOption } from '../../remote-models';

/**
 * Dumb Fetch dialog. Collects a {@link FetchIntent} (all remotes or one, plus
 * the prune/tags/force options) and surfaces the running/progress/error state
 * supplied by the shell. The renderer never talks to Git; the shell store maps
 * the intent onto the `FetchRequest` that crosses the IPC bridge.
 */
@Component({
  selector: 'st-fetch-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, SelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" title="Fetch" (closed)="closed.emit()">
      <div class="st-fetch" data-testid="fetch-dialog">
        @if (loading()) {
          <div class="st-fetch__banner" data-testid="fetch-loading">Loading remotes…</div>
        }

        <label class="st-fetch__option">
          <input
            type="checkbox"
            data-testid="fetch-all-remotes"
            [checked]="allRemotes()"
            (change)="onAllRemotesChange($event)"
          />
          <span class="st-fetch__label">Fetch from all remotes</span>
        </label>

        @if (!allRemotes()) {
          <label class="st-fetch__option">
            <span class="st-fetch__label">Remote</span>
            <st-select
              [testId]="'fetch-remote-select'"
              [value]="selectedRemote()"
              (valueChange)="onRemoteChange($event)"
            >
              @for (remote of remotes(); track remote.name) {
                <option [value]="remote.name" [selected]="remote.name === selectedRemote()">
                  {{ remote.name }}
                </option>
              }
            </st-select>
          </label>
        }

        <label class="st-fetch__option">
          <input
            type="checkbox"
            data-testid="fetch-prune"
            [checked]="prune()"
            (change)="onPruneChange($event)"
          />
          <span class="st-fetch__label">
            Prune tracking branches no longer present on remote(s)
          </span>
        </label>

        <label class="st-fetch__option">
          <input
            type="checkbox"
            data-testid="fetch-option-tags"
            [checked]="tags()"
            (change)="onTagsChange($event)"
          />
          <span class="st-fetch__label">Fetch all tags</span>
        </label>

        <label class="st-fetch__option">
          <input
            type="checkbox"
            data-testid="fetch-option-overwrite-tags"
            [checked]="overwriteTags()"
            (change)="onOverwriteTagsChange($event)"
          />
          <span class="st-fetch__label">Overwrite Local Tags (--force)</span>
        </label>

        @if (progress(); as p) {
          <div class="st-fetch__progress" data-testid="fetch-progress">
            {{ p.percent }}% — {{ p.message }}
          </div>
        }

        @if (error(); as err) {
          <div class="st-fetch__banner st-fetch__banner--error" data-testid="fetch-error">
            {{ err.message }}
          </div>
        }

        @if (offline()) {
          <div class="st-fetch__banner st-fetch__banner--offline" data-testid="fetch-offline">
            Git core offline — run inside the desktop app.
          </div>
        }
      </div>

      <st-button
        st-modal-footer
        variant="default"
        data-testid="fetch-cancel"
        (click)="closed.emit()"
      >
        Cancel
      </st-button>
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="fetch-submit"
        [disabled]="submitDisabled()"
        (click)="submit()"
      >
        OK
      </st-button>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-fetch {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-3);
      color: var(--st-color-text);
      font-size: var(--st-font-13);
    }

    .st-fetch__option {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      cursor: pointer;
    }

    .st-fetch__option input[type='checkbox'] {
      accent-color: var(--st-color-accent);
      margin: 0;
    }

    .st-fetch__label {
      flex: 1;
    }

    .st-fetch__progress {
      color: var(--st-color-muted);
      font-size: var(--st-font-12);
    }

    .st-fetch__banner {
      border-radius: var(--st-radius-2);
      padding: var(--st-space-2) var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-fetch__banner--error {
      background: var(--st-color-danger-soft);
      border: var(--st-hairline) solid var(--st-color-danger);
      color: var(--st-color-danger);
    }

    .st-fetch__banner--offline {
      background: var(--st-color-warn-soft);
      border: var(--st-hairline) solid var(--st-color-warn);
      color: var(--st-color-warn);
    }
  `,
})
export class FetchDialog {
  readonly open = input(false);
  readonly remotes = input<RemoteOption[]>([]);
  readonly loading = input(false);
  readonly running = input(false);
  readonly progress = input<RemoteOpProgress | null>(null);
  readonly error = input<AppError | null>(null);
  readonly offline = input(false);

  readonly closed = output<void>();
  readonly submitted = output<FetchIntent>();

  /** Fetch every remote (default) vs. a single selected one. */
  readonly allRemotes = signal(true);
  /** Name of the selected remote; falls back to `origin`, then the first. */
  readonly selectedRemote = signal('');
  /** Prune remote-tracking refs deleted upstream (`--prune`). */
  readonly prune = signal(false);
  /** Fetch all tags (`--tags`). */
  readonly tags = signal(false);
  /** Overwrite moved local tags (`--force`). */
  readonly overwriteTags = signal(false);

  readonly submitDisabled = computed(
    () => this.running() || this.offline() || (!this.allRemotes() && !this.selectedRemote()),
  );

  constructor() {
    // Re-initialise the local presentation state every time the dialog opens.
    effect(() => {
      if (!this.open()) return;
      untracked(() => this.resetLocalState());
    });
  }

  private resetLocalState(): void {
    this.allRemotes.set(true);
    this.prune.set(false);
    this.tags.set(false);
    this.overwriteTags.set(false);
    const preferred = this.remotes().find((remote) => remote.name === 'origin');
    this.selectedRemote.set(preferred?.name ?? this.remotes()[0]?.name ?? '');
  }

  onAllRemotesChange(event: Event): void {
    this.allRemotes.set((event.target as HTMLInputElement).checked);
  }

  onRemoteChange(value: string): void {
    this.selectedRemote.set(value);
  }

  onPruneChange(event: Event): void {
    this.prune.set((event.target as HTMLInputElement).checked);
  }

  onTagsChange(event: Event): void {
    this.tags.set((event.target as HTMLInputElement).checked);
  }

  onOverwriteTagsChange(event: Event): void {
    this.overwriteTags.set((event.target as HTMLInputElement).checked);
  }

  submit(): void {
    if (this.submitDisabled()) return;
    this.submitted.emit({
      allRemotes: this.allRemotes(),
      remote: this.selectedRemote(),
      prune: this.prune(),
      tags: this.tags(),
      force: this.overwriteTags(),
    });
  }
}
