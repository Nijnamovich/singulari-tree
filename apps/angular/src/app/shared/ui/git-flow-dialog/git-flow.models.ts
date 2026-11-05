import type { GitFlowConfig } from '@contracts/gitcore';

/**
 * Wire form of the git-flow kind (ADR-027).
 *
 * The Angular `@contracts/gitcore` enum is numeric, but the Electron preload
 * decodes proto enums with `enums: String`, so the value that actually crosses
 * IPC is the enum value name. Callers always name the kind; there is no default.
 * `GIT_FLOW_KIND_UNSPECIFIED` is rejected by the core and never sent.
 */
export type GitFlowKindName = 'FEATURE' | 'RELEASE' | 'HOTFIX';

/** The ordered kinds offered by the git-flow dialog. */
export const GIT_FLOW_KINDS: readonly GitFlowKindName[] = ['FEATURE', 'RELEASE', 'HOTFIX'];

/** Which git-flow tab the dialog is showing. */
export type GitFlowMode = 'start' | 'finish' | 'config';

/** Submitted payload of the git-flow Start form. */
export interface GitFlowStartValue {
  readonly kind: GitFlowKindName;
  readonly name: string;
  /** Optional start point override; empty uses the kind's base branch. */
  readonly base: string;
}

/** Submitted payload of the git-flow Finish form. */
export interface GitFlowFinishValue {
  readonly kind: GitFlowKindName;
  readonly name: string;
  /** Delete the workflow branch after a successful finish. */
  readonly deleteBranch: boolean;
}

/**
 * Conventional git-flow defaults, mirroring the core (`domain.DefaultGitFlowConfig`).
 * Used by the dialog's "reset to defaults" affordance; the core re-normalizes
 * empty fields, so the renderer never invents workflow semantics.
 */
export const GIT_FLOW_DEFAULTS: GitFlowConfig = {
  mainBranch: 'main',
  developBranch: 'develop',
  featurePrefix: 'feature/',
  releasePrefix: 'release/',
  hotfixPrefix: 'hotfix/',
  versionTagPrefix: 'v',
};
