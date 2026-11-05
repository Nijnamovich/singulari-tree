import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { SelectComponent, ToggleGroupComponent } from '@singularitree/ui-kit';
import type { FileStatusVariant } from '../file-status.models';

/**
 * Variant bar of the "File Status" screen (ADR-0029): the segmented variant
 * control plus the PR-only base/target ref controls.
 *
 * Dumb and presentational — it renders its inputs and emits user intent; the
 * owning page binds those events to `FileStatusStore`. The base branch is an
 * **editable** input (datalist-backed from the loaded branch names) so an
 * arbitrary ref can be typed; the target is a `st-select` of the known branch
 * names.
 */
@Component({
  selector: 'st-file-status-variant-bar',
  standalone: true,
  imports: [ToggleGroupComponent, SelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="st-file-status-variant"
      role="group"
      aria-label="File status variant"
      i18n-aria-label
    >
      <st-toggle-group
        [ariaLabel]="a11yVariant"
        [options]="variantOptions()"
        [value]="variant()"
        (valueChange)="onVariant($event)"
      />

      @if (variant() === 'pr') {
        <div class="st-file-status-variant__refs">
          <label class="st-file-status-variant__ref">
            <span class="st-file-status-variant__ref-label" i18n>Base branch</span>
            <input
              type="text"
              class="st-file-status-variant__input st-focus-ring"
              data-testid="pr-base-input"
              list="st-file-status-variant__base-options"
              [value]="baseRef()"
              (input)="onBase($event)"
            />
          </label>
          <datalist id="st-file-status-variant__base-options">
            @for (name of branches(); track name) {
              <option [value]="name"></option>
            }
          </datalist>

          <label class="st-file-status-variant__ref">
            <span class="st-file-status-variant__ref-label" i18n>Target branch</span>
            <st-select
              data-testid="pr-target-select"
              [value]="targetRef()"
              (valueChange)="targetRefChange.emit($event)"
            >
              @for (name of branches(); track name) {
                <option [value]="name">{{ name }}</option>
              }
            </st-select>
          </label>
        </div>
      }
    </div>
  `,
  styles: `
    .st-file-status-variant {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--st-space-2) var(--st-space-3);
      padding: var(--st-space-2) var(--st-space-3);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
      font-size: var(--st-font-12);
      color: var(--st-color-text);
    }

    .st-file-status-variant__refs {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--st-space-2);
      margin-left: auto;
    }

    .st-file-status-variant__ref {
      display: flex;
      align-items: center;
      gap: var(--st-space-1);
      color: var(--st-color-muted);
    }

    .st-file-status-variant__ref-label {
      white-space: nowrap;
    }

    .st-file-status-variant__input {
      box-sizing: border-box;
      max-width: 180px;
      height: var(--st-size-control-md);
      padding: 0 var(--st-space-2);
      border: var(--st-hairline) solid var(--st-color-border);
      border-radius: var(--st-radius-2);
      background: var(--st-color-surface-2);
      color: var(--st-color-text);
      font: inherit;
    }
  `,
})
export class FileStatusVariantBar {
  /** Variant currently shown; drives the active segment and the PR controls. */
  readonly variant = input<FileStatusVariant>('local');
  /**
   * Count of pending (unstaged) files, rendered as a badge on the `Local`
   * segment. Staged files are never counted; the badge hides at 0.
   *
   * Deliberate semantics: the count reuses the working tree's existing
   * staged/unstaged classification (`!isStaged`, untracked included) so the
   * badge always agrees with the file list it heads. A partially-staged
   * (`MM`) or conflicted record is classified staged by that model and is
   * therefore not counted here, even though it still carries unresolved
   * worktree changes.
   */
  readonly pendingCount = input(0);
  /** Ref names offered as the PR base/target (the `getBranches` names). */
  readonly branches = input<string[]>([]);
  /** Current PR base ref name (editable: any ref, resolved by the page). */
  readonly baseRef = input('');
  /** Current PR target ref name. */
  readonly targetRef = input('');

  readonly variantChange = output<FileStatusVariant>();
  readonly baseRefChange = output<string>();
  readonly targetRefChange = output<string>();

  /** Segments of the variant control. */
  readonly variantOptions = computed(() => [
    { value: 'local', label: $localize`Local`, count: this.pendingCount() },
    { value: 'commit', label: $localize`Commit` },
    { value: 'pr', label: $localize`Branch comparator` },
  ]);

  onBase(event: Event): void {
    this.baseRefChange.emit((event.target as HTMLInputElement).value);
  }

  /** Narrow the toggle-group's string value back to the variant union. */
  onVariant(value: string): void {
    this.variantChange.emit(value as FileStatusVariant);
  }

  readonly a11yVariant = $localize`File status variant`;
}
