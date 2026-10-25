import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { FileStatus } from '@contracts/domain';
import {
  ButtonComponent,
  IconComponent,
  SelectableRowDirective,
  TextareaComponent,
} from '@singularitree/ui-kit';

/**
 * Working-tree changes panel: staged + unstaged file sections, file-level
 * stage/unstage/discard and the commit box. Dumb and presentational — it renders
 * its inputs and emits user intent; the owning page binds those events to
 * `StatusStore`.
 *
 * Hunk/line actions live INLINE inside `st-diff-viewer` now (per-hunk buttons and
 * per-line checkboxes), so this panel no longer hosts a hunk-action block.
 */
@Component({
  selector: 'st-changes-panel',
  standalone: true,
  imports: [ButtonComponent, IconComponent, TextareaComponent, SelectableRowDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="st-changes">
      @if (statusError(); as error) {
        <p class="st-changes__error" data-testid="status-error">{{ error }}</p>
      }

      <div class="st-changes__sections">
        <section class="st-changes__section">
          <h3 class="st-changes__heading st-eyebrow" i18n>Staged changes</h3>
          @if (stagedFiles().length) {
            <ul class="st-changes__list">
              @for (file of stagedFiles(); track file.path) {
                <li
                  stSelectableRow
                  [selected]="file.path === selectedPath()"
                  (rowActivated)="fileSelect.emit(file.path)"
                  class="st-changes__row"
                  data-testid="status-file"
                  [class.st-changes__row--selected]="file.path === selectedPath()"
                >
                  <span class="st-changes__path">{{ file.path }}</span>
                  <span class="st-changes__actions">
                    <st-button
                      variant="icon"
                      size="sm"
                      data-testid="status-unstage"
                      [ariaLabel]="a11yUnstage"
                      (click)="onUnstage($event, file.path)"
                    >
                      <st-icon name="minus"></st-icon>
                    </st-button>
                  </span>
                </li>
              }
            </ul>
          } @else {
            <p class="st-changes__empty" i18n>No staged changes.</p>
          }
        </section>

        <section class="st-changes__section">
          <h3 class="st-changes__heading st-eyebrow" i18n>Unstaged changes</h3>
          @if (unstagedFiles().length) {
            <ul class="st-changes__list">
              @for (file of unstagedFiles(); track file.path) {
                <li
                  stSelectableRow
                  [selected]="file.path === selectedPath()"
                  (rowActivated)="fileSelect.emit(file.path)"
                  class="st-changes__row"
                  data-testid="status-file"
                  [class.st-changes__row--selected]="file.path === selectedPath()"
                >
                  <span class="st-changes__path">{{ file.path }}</span>
                  <span class="st-changes__actions">
                    <st-button
                      variant="icon"
                      size="sm"
                      data-testid="status-stage"
                      [ariaLabel]="a11yStage"
                      (click)="onStage($event, file.path)"
                    >
                      <st-icon name="plus"></st-icon>
                    </st-button>
                    <st-button
                      variant="icon"
                      size="sm"
                      data-testid="status-discard"
                      [ariaLabel]="a11yDiscard"
                      (click)="onDiscard($event, file.path)"
                    >
                      <st-icon name="discard"></st-icon>
                    </st-button>
                  </span>
                </li>
              }
            </ul>
          } @else {
            <p class="st-changes__empty" i18n>No unstaged changes.</p>
          }
        </section>
      </div>

      @if (!stagedFiles().length && !unstagedFiles().length) {
        <p class="st-changes__empty" data-testid="status-empty" i18n>No changes.</p>
      }

      <div class="st-changes__commit">
        @if (commitError(); as error) {
          <p class="st-changes__error" data-testid="commit-error">{{ error }}</p>
        }
        <st-textarea
          data-testid="commit-message-input"
          [value]="message()"
          [disabled]="busy()"
          [rows]="2"
          [placeholder]="commitPlaceholder"
          (valueChange)="messageChange.emit($event)"
        />
        <st-button
          variant="primary"
          size="md"
          data-testid="commit-button"
          [disabled]="!canCommit()"
          (click)="commit.emit()"
          i18n
        >
          Commit
        </st-button>
      </div>
    </section>
  `,
  styles: `
    /* The host is a bounded flex column: the file-status page hands it the full
       height of the left pane, so the panel can pin its commit box to the bottom
       while the file sections scroll in the space that remains. flex (not a
       percentage height) plus min-height: 0 lets it shrink below its content
       when the lists overflow instead of growing the pane. */
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      color: var(--st-color-text);
    }

    .st-changes {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      gap: var(--st-space-2);
      padding: var(--st-space-2) var(--st-space-3);
      font-size: var(--st-font-12);
    }

    /* The scrollable region: it takes all the slack, so a short list still
       pushes the fixed commit box to the bottom rather than leaving it mid-pane. */
    .st-changes__sections {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      gap: var(--st-space-3);
      overflow-y: auto;
      overflow-x: hidden;
    }

    .st-changes__heading {
      margin: 0 0 4px;
    }

    .st-changes__list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .st-changes__row {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      padding: var(--st-space-1);
      border-radius: var(--st-radius-2);
      cursor: pointer;
    }

    .st-changes__row--selected {
      background: var(--st-color-selected);
    }

    /* The path is the row's only flexible child: it takes the slack so a long,
       wrapping path can never push the actions around. No justify-content:
       space-between here — with three children it would centre the middle
       action instead of pinning the group to the right edge. */
    .st-changes__path {
      flex: 1 1 auto;
      min-width: 0;
      word-break: break-all;
    }

    /* One right-pinned actions group per row, identical in both sections, so the
       stage (+) and the discard (trash) buttons stay adjacent and flush right. */
    .st-changes__actions {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
    }

    /* Pinned footer: fixed (never grows or shrinks), so the sections keep the
       scrollable slack; the top hairline reads it as the commit box. */
    .st-changes__commit {
      display: flex;
      flex-direction: column;
      flex: none;
      gap: var(--st-space-2);
      border-top: var(--st-hairline) solid var(--st-color-border);
      padding-top: var(--st-space-2);
    }

    .st-changes__empty {
      margin: 0;
      color: var(--st-color-muted);
    }

    .st-changes__error {
      margin: 0;
      color: var(--st-color-danger);
    }
  `,
})
export class ChangesPanel {
  readonly commitPlaceholder = $localize`Commit message`;
  readonly a11yStage = $localize`Stage file`;
  readonly a11yUnstage = $localize`Unstage file`;
  readonly a11yDiscard = $localize`Discard changes`;

  readonly stagedFiles = input<FileStatus[]>([]);
  readonly unstagedFiles = input<FileStatus[]>([]);
  readonly message = input('');
  readonly busy = input(false);
  readonly selectedPath = input<string | null>(null);
  readonly statusError = input<string | null>(null);
  readonly commitError = input<string | null>(null);

  readonly stage = output<string[]>();
  readonly unstage = output<string[]>();
  readonly discardFile = output<string>();
  readonly messageChange = output<string>();
  readonly commit = output<void>();
  readonly fileSelect = output<string>();

  /** Enable Commit only with a staged file and a non-blank message. */
  readonly canCommit = computed(
    () => this.stagedFiles().length > 0 && this.message().trim().length > 0 && !this.busy(),
  );

  onStage(event: Event, path: string): void {
    event.stopPropagation();
    this.stage.emit([path]);
  }

  onUnstage(event: Event, path: string): void {
    event.stopPropagation();
    this.unstage.emit([path]);
  }

  /** File-level discard is destructive: confirm before emitting. */
  onDiscard(event: Event, path: string): void {
    event.stopPropagation();
    if (this.busy()) return;
    if (!confirmFileDiscard(path)) return;
    this.discardFile.emit(path);
  }
}

/** Confirm a destructive file-level discard; stubbable in tests. */
function confirmFileDiscard(path: string): boolean {
  return typeof confirm === 'function'
    ? confirm(`Discard changes to "${path}"? This cannot be undone.`)
    : true;
}
