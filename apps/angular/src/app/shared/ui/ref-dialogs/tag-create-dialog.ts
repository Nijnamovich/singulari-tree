import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { ButtonComponent, InputComponent, TextareaComponent } from '@singularitree/ui-kit';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';
import type { TagCreateValue } from './ref-dialog.models';

/**
 * Dumb create-tag dialog (ADR-028).
 *
 * The parent supplies the default target (HEAD, or the clicked commit oid from
 * the graph menu), the busy flag and an optional error, and reacts to
 * `submitted`. An annotated tag requires a message; the submit button stays
 * disabled until one is present. Reuses the shared `st-modal` shell.
 */
@Component({
  selector: 'st-tag-create-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent, TextareaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" title="New tag" [closeOnBackdrop]="!running()" (closed)="cancel()">
      <label class="st-ref-dialog__field">
        <span i18n>Name</span>
        <st-input
          [testId]="'tag-create-name'"
          [value]="name()"
          placeholder="v1.0.0"
          i18n-placeholder
          (valueChange)="name.set($event)"
        />
      </label>

      <label class="st-ref-dialog__field">
        <span i18n>Target</span>
        <st-input
          [testId]="'tag-create-target'"
          [value]="targetValue()"
          (valueChange)="targetValue.set($event)"
        />
      </label>

      <label class="st-ref-dialog__check">
        <input
          type="checkbox"
          data-testid="tag-create-annotated"
          [checked]="annotated()"
          (change)="onAnnotated($event)"
        />
        <span i18n>Annotated</span>
      </label>

      @if (annotated()) {
        <label class="st-ref-dialog__field">
          <span i18n>Message</span>
          <st-textarea
            [testId]="'tag-create-message'"
            [rows]="3"
            [value]="message()"
            (valueChange)="message.set($event)"
          />
        </label>
      }

      <label class="st-ref-dialog__check">
        <input
          type="checkbox"
          data-testid="tag-create-force"
          [checked]="force()"
          (change)="onForce($event)"
        />
        <span i18n>Force (move an existing tag)</span>
      </label>

      @if (error(); as err) {
        <p class="st-ref-dialog__error" data-testid="tag-create-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="tag-create-cancel"
        [disabled]="running()"
        (click)="cancel()"
      >
        Cancel
      </st-button>
      <st-button
        st-modal-footer
        variant="primary"
        data-testid="tag-create-submit"
        [disabled]="!canSubmit() || running()"
        (click)="submit()"
      >
        Create tag
      </st-button>
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-ref-dialog__field {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__check {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      margin-bottom: var(--st-space-2);
      font-size: var(--st-font-12);
    }

    .st-ref-dialog__check input {
      accent-color: var(--st-color-accent);
    }

    .st-ref-dialog__error {
      margin: var(--st-space-2) 0 0;
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class TagCreateDialog {
  readonly open = input(false);
  /** Default target supplied by the container (HEAD or a clicked oid). */
  readonly defaultTarget = input('HEAD');
  readonly running = input(false);
  readonly error = input<AppError | null>(null);

  readonly submitted = output<TagCreateValue>();
  readonly cancelled = output<void>();

  readonly name = signal('');
  readonly targetValue = signal('HEAD');
  readonly annotated = signal(false);
  readonly message = signal('');
  readonly force = signal(false);

  readonly canSubmit = () => {
    if (this.name().trim().length === 0 || !this.targetValue().trim()) return false;
    return !this.annotated() || this.message().trim().length > 0;
  };

  constructor() {
    // Seed the form from the caller's default on every open.
    effect(() => {
      if (this.open()) {
        const target = this.defaultTarget();
        this.name.set('');
        this.targetValue.set(target.trim() || 'HEAD');
        this.annotated.set(false);
        this.message.set('');
        this.force.set(false);
      }
    });
  }

  onAnnotated(event: Event): void {
    this.annotated.set((event.target as HTMLInputElement).checked);
  }

  onForce(event: Event): void {
    this.force.set((event.target as HTMLInputElement).checked);
  }

  submit(): void {
    if (!this.canSubmit() || this.running()) return;
    this.submitted.emit({
      name: this.name().trim(),
      target: this.targetValue().trim(),
      annotated: this.annotated(),
      message: this.message().trim(),
      force: this.force(),
    });
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
