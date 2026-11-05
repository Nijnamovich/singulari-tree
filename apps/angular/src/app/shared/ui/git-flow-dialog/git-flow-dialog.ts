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
import type { GitFlowConfig, GitFlowResult } from '@contracts/gitcore';
import { ModalComponent } from '@shared/ui/modal/modal';
import type { AppError } from '@core/services/ipc-bridge.service';
import { ButtonComponent, InputComponent, SelectComponent } from '@singularitree/ui-kit';
import {
  GIT_FLOW_DEFAULTS,
  GIT_FLOW_KINDS,
  type GitFlowFinishValue,
  type GitFlowKindName,
  type GitFlowMode,
  type GitFlowStartValue,
} from './git-flow.models';

/**
 * Dumb git-flow dialog (ADR-027): Start, Finish and Config tabs.
 *
 * It owns no domain state and never builds a Git command sequence — the core
 * owns the workflow semantics and the renderer only names a kind and a name. The
 * parent supplies the current config, the busy flag, an optional error and the
 * last result, and reacts to the matching output. Reuses the shared `st-modal`
 * shell; Escape/backdrop map to `cancelled`.
 */
@Component({
  selector: 'st-git-flow-dialog',
  standalone: true,
  imports: [ModalComponent, ButtonComponent, InputComponent, SelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <st-modal [open]="open()" title="Git flow" i18n-title [closeOnBackdrop]="!running()" (closed)="cancel()">
      <div class="st-git-flow__tabs" role="tablist">
        @for (tab of MODES; track tab) {
          <button
            type="button"
            role="tab"
            class="st-git-flow__tab"
            [class.st-git-flow__tab--active]="mode() === tab"
            [attr.aria-selected]="mode() === tab"
            [attr.data-testid]="'git-flow-tab-' + tab"
            (click)="mode.set(tab)"
          >
            {{ tabLabel(tab) }}
          </button>
        }
      </div>

      @if (mode() === 'start') {
        <label class="st-git-flow__field">
          <span i18n>Kind</span>
          <st-select
            [testId]="'git-flow-start-kind'"
            [value]="kind()"
            (valueChange)="onKind($event)"
          >
            @for (option of KINDS; track option) {
              <option [value]="option">{{ option }}</option>
            }
          </st-select>
        </label>

        <label class="st-git-flow__field">
          <span i18n>Name</span>
          <st-input
            [testId]="'git-flow-start-name'"
            [value]="name()"
            [placeholder]="namePlaceholder"
            (valueChange)="onName($event)"
          />
        </label>

        <label class="st-git-flow__field">
          <span i18n>Base (optional)</span>
          <st-input
            [testId]="'git-flow-start-base'"
            [value]="base()"
            (valueChange)="onBase($event)"
          />
        </label>
      } @else if (mode() === 'finish') {
        <label class="st-git-flow__field">
          <span i18n>Kind</span>
          <st-select
            [testId]="'git-flow-finish-kind'"
            [value]="kind()"
            (valueChange)="onKind($event)"
          >
            @for (option of KINDS; track option) {
              <option [value]="option">{{ option }}</option>
            }
          </st-select>
        </label>

        <label class="st-git-flow__field">
          <span i18n>Name</span>
          <st-input
            [testId]="'git-flow-finish-name'"
            [value]="name()"
            [placeholder]="namePlaceholder"
            (valueChange)="onName($event)"
          />
        </label>

        <label class="st-git-flow__check">
          <input
            type="checkbox"
            data-testid="git-flow-delete-branch"
            [checked]="deleteBranch()"
            (change)="onDeleteBranch($event)"
          />
          <span i18n>Delete the workflow branch after finishing</span>
        </label>
      } @else {
        <label class="st-git-flow__field">
          <span i18n>Main branch</span>
          <st-input
            [testId]="'git-flow-config-main'"
            [value]="mainBranch()"
            (valueChange)="onMainBranch($event)"
          />
        </label>
        <label class="st-git-flow__field">
          <span i18n>Develop branch</span>
          <st-input
            [testId]="'git-flow-config-develop'"
            [value]="developBranch()"
            (valueChange)="onDevelopBranch($event)"
          />
        </label>
        <label class="st-git-flow__field">
          <span i18n>Feature prefix</span>
          <st-input
            [testId]="'git-flow-config-feature-prefix'"
            [value]="featurePrefix()"
            (valueChange)="onFeaturePrefix($event)"
          />
        </label>
        <label class="st-git-flow__field">
          <span i18n>Release prefix</span>
          <st-input
            [testId]="'git-flow-config-release-prefix'"
            [value]="releasePrefix()"
            (valueChange)="onReleasePrefix($event)"
          />
        </label>
        <label class="st-git-flow__field">
          <span i18n>Hotfix prefix</span>
          <st-input
            [testId]="'git-flow-config-hotfix-prefix'"
            [value]="hotfixPrefix()"
            (valueChange)="onHotfixPrefix($event)"
          />
        </label>
        <label class="st-git-flow__field">
          <span i18n>Version tag prefix</span>
          <st-input
            [testId]="'git-flow-config-version-prefix'"
            [value]="versionTagPrefix()"
            (valueChange)="onVersionTagPrefix($event)"
          />
        </label>

        <st-button
          variant="default"
          data-testid="git-flow-config-reset"
          [disabled]="running()"
          (click)="resetConfig()"
          i18n
          >Reset to defaults</st-button
        >
      }

      @if (result(); as res) {
        @if (res.steps.length > 0) {
          <div class="st-git-flow__steps" data-testid="git-flow-steps">
            <p class="st-git-flow__steps-title" i18n>Steps</p>
            <ol class="st-git-flow__steps-list">
              @for (step of res.steps; track step) {
                <li data-testid="git-flow-step">{{ step }}</li>
              }
            </ol>
          </div>
        }
        @if (res.hasConflict) {
          <p class="st-git-flow__conflict" data-testid="git-flow-conflict" i18n>
            The workflow produced conflicts. Resolve them in the working tree.
          </p>
        }
      }

      @if (error(); as err) {
        <p class="st-git-flow__error" data-testid="git-flow-error">{{ err.message }}</p>
      }

      <st-button
        st-modal-footer
        variant="default"
        data-testid="git-flow-cancel"
        [disabled]="running()"
        (click)="cancel()"
        i18n
        >Close</st-button
      >
      @if (mode() === 'start') {
        <st-button
          st-modal-footer
          variant="primary"
          data-testid="git-flow-start-submit"
          [disabled]="!canSubmit() || running()"
          (click)="submitStart()"
          i18n
          >Start</st-button
        >
      } @else if (mode() === 'finish') {
        <st-button
          st-modal-footer
          variant="primary"
          data-testid="git-flow-finish-submit"
          [disabled]="!canSubmit() || running()"
          (click)="submitFinish()"
          i18n
          >Finish</st-button
        >
      } @else {
        <st-button
          st-modal-footer
          variant="primary"
          data-testid="git-flow-config-submit"
          [disabled]="running()"
          (click)="submitConfig()"
          i18n
          >Save</st-button
        >
      }
    </st-modal>
  `,
  styles: `
    :host {
      display: contents;
    }

    .st-git-flow__tabs {
      display: flex;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-4);
      border-bottom: var(--st-hairline) solid var(--st-color-border);
    }

    .st-git-flow__tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--st-color-muted);
      cursor: pointer;
      font: inherit;
      font-size: var(--st-font-12);
      padding: var(--st-space-1) var(--st-space-3);
    }

    .st-git-flow__tab--active {
      color: var(--st-color-text);
      border-bottom-color: var(--st-color-accent);
    }

    .st-git-flow__field {
      display: flex;
      flex-direction: column;
      gap: var(--st-space-1);
      margin-bottom: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-git-flow__check {
      display: flex;
      align-items: center;
      gap: var(--st-space-2);
      font-size: var(--st-font-12);
      accent-color: var(--st-color-accent);
    }

    .st-git-flow__steps {
      margin-top: var(--st-space-3);
      font-size: var(--st-font-12);
    }

    .st-git-flow__steps-title {
      margin: 0 0 var(--st-space-1);
      color: var(--st-color-muted);
      font-weight: 600;
    }

    .st-git-flow__steps-list {
      margin: 0;
      padding-left: var(--st-space-4);
    }

    .st-git-flow__conflict {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-warn);
      font-size: var(--st-font-12);
    }

    .st-git-flow__error {
      margin: var(--st-space-3) 0 0;
      color: var(--st-color-danger);
      font-size: var(--st-font-12);
    }
  `,
})
export class GitFlowDialog {
  readonly open = input(false);
  /** Tab shown when the dialog opens. */
  readonly initialMode = input<GitFlowMode>('start');
  /** Current git-flow configuration, or null until the container loads it. */
  readonly config = input<GitFlowConfig | null>(null);
  /** Default start point for the Start form (the current branch). */
  readonly defaultBase = input('');
  readonly running = input(false);
  readonly error = input<AppError | null>(null);
  readonly result = input<GitFlowResult | null>(null);

  readonly startSubmitted = output<GitFlowStartValue>();
  readonly finishSubmitted = output<GitFlowFinishValue>();
  readonly configSubmitted = output<GitFlowConfig>();
  readonly cancelled = output<void>();

  readonly MODES: readonly GitFlowMode[] = ['start', 'finish', 'config'];
  readonly KINDS = GIT_FLOW_KINDS;
  /** Translated placeholder shared by the Start and Finish branch-name fields. */
  readonly namePlaceholder = $localize`login`;

  readonly mode = signal<GitFlowMode>('start');
  readonly kind = signal<GitFlowKindName>('FEATURE');
  readonly name = signal('');
  readonly base = signal('');
  readonly deleteBranch = signal(true);

  readonly mainBranch = signal(GIT_FLOW_DEFAULTS.mainBranch);
  readonly developBranch = signal(GIT_FLOW_DEFAULTS.developBranch);
  readonly featurePrefix = signal(GIT_FLOW_DEFAULTS.featurePrefix);
  readonly releasePrefix = signal(GIT_FLOW_DEFAULTS.releasePrefix);
  readonly hotfixPrefix = signal(GIT_FLOW_DEFAULTS.hotfixPrefix);
  readonly versionTagPrefix = signal(GIT_FLOW_DEFAULTS.versionTagPrefix);

  readonly canSubmit = computed(() => this.name().trim().length > 0);

  /** Tracks whether the user has edited the config form (so a late load cannot overwrite it). */
  private configEdited = false;
  /** Previous `open` value, used to detect the open transition. */
  private wasOpen = false;

  constructor() {
    // Seed every form on the open transition; afterwards, adopt an
    // asynchronously loaded config only while the user has not edited it.
    effect(() => {
      const open = this.open();
      const config = this.config();
      if (open && !this.wasOpen) {
        this.wasOpen = true;
        this.configEdited = false;
        this.mode.set(untracked(this.initialMode));
        this.kind.set('FEATURE');
        this.name.set('');
        this.base.set(untracked(this.defaultBase));
        this.deleteBranch.set(true);
        this.seedConfig(config ?? GIT_FLOW_DEFAULTS);
      } else if (!open) {
        this.wasOpen = false;
      } else if (config && !this.configEdited) {
        this.seedConfig(config);
      }
    });
  }

  tabLabel(tab: GitFlowMode): string {
    switch (tab) {
      case 'finish':
        return $localize`Finish`;
      case 'config':
        return $localize`Config`;
      default:
        return $localize`Start`;
    }
  }

  onKind(value: string): void {
    this.kind.set(value as GitFlowKindName);
  }

  onName(value: string): void {
    this.name.set(value);
  }

  onBase(value: string): void {
    this.base.set(value);
  }

  onDeleteBranch(event: Event): void {
    this.deleteBranch.set((event.target as HTMLInputElement).checked);
  }

  onMainBranch(value: string): void {
    this.configEdited = true;
    this.mainBranch.set(value);
  }

  onDevelopBranch(value: string): void {
    this.configEdited = true;
    this.developBranch.set(value);
  }

  onFeaturePrefix(value: string): void {
    this.configEdited = true;
    this.featurePrefix.set(value);
  }

  onReleasePrefix(value: string): void {
    this.configEdited = true;
    this.releasePrefix.set(value);
  }

  onHotfixPrefix(value: string): void {
    this.configEdited = true;
    this.hotfixPrefix.set(value);
  }

  onVersionTagPrefix(value: string): void {
    this.configEdited = true;
    this.versionTagPrefix.set(value);
  }

  resetConfig(): void {
    if (this.running()) return;
    this.configEdited = true;
    this.seedConfig(GIT_FLOW_DEFAULTS);
  }

  submitStart(): void {
    if (!this.canSubmit() || this.running()) return;
    this.startSubmitted.emit({
      kind: this.kind(),
      name: this.name().trim(),
      base: this.base().trim(),
    });
  }

  submitFinish(): void {
    if (!this.canSubmit() || this.running()) return;
    this.finishSubmitted.emit({
      kind: this.kind(),
      name: this.name().trim(),
      deleteBranch: this.deleteBranch(),
    });
  }

  submitConfig(): void {
    if (this.running()) return;
    this.configSubmitted.emit(this.currentConfig());
  }

  cancel(): void {
    this.cancelled.emit();
  }

  private currentConfig(): GitFlowConfig {
    return {
      mainBranch: this.mainBranch().trim(),
      developBranch: this.developBranch().trim(),
      featurePrefix: this.featurePrefix(),
      releasePrefix: this.releasePrefix(),
      hotfixPrefix: this.hotfixPrefix(),
      versionTagPrefix: this.versionTagPrefix(),
    };
  }

  private seedConfig(config: GitFlowConfig): void {
    this.mainBranch.set(config.mainBranch);
    this.developBranch.set(config.developBranch);
    this.featurePrefix.set(config.featurePrefix);
    this.releasePrefix.set(config.releasePrefix);
    this.hotfixPrefix.set(config.hotfixPrefix);
    this.versionTagPrefix.set(config.versionTagPrefix);
  }
}
