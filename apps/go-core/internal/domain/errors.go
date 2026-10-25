package domain

import "fmt"

// AppError is the typed envelope shared across domain, service, and wire (errors.proto).
// Code maps to ErrorCode enum; Message is human-readable; Details carries context.
type AppError struct {
	Code    string
	Message string
	Details map[string]string
}

func (e AppError) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// WithDetail returns a copy with an added detail entry.
func (e AppError) WithDetail(k, v string) AppError {
	details := make(map[string]string, len(e.Details)+1)
	for kk, vv := range e.Details {
		details[kk] = vv
	}
	details[k] = v
	return AppError{Code: e.Code, Message: e.Message, Details: details}
}

// Common error codes (mirrors errors.proto ErrorCode, code strings used on wire)
const (
	ErrCodeRepoNotFound      = "REPO_NOT_FOUND"
	ErrCodeNotAGitRepo       = "NOT_A_GIT_REPO"
	ErrCodeCommitNotFound    = "COMMIT_NOT_FOUND"
	ErrCodeInvalidOid        = "INVALID_OID"
	ErrCodeBranchNotFound    = "BRANCH_NOT_FOUND"
	ErrCodeBranchExists      = "BRANCH_EXISTS"
	ErrCodeDetachedHead      = "DETACHED_HEAD"
	ErrCodeIpcUnavailable    = "IPC_UNAVAILABLE"
	ErrCodeGoCoreUnavailable = "GO_CORE_UNAVAILABLE"
	ErrCodeQueueFull         = "QUEUE_FULL"
	ErrCodeStageFailed       = "STAGE_FAILED"
	ErrCodeCommitFailed      = "COMMIT_FAILED"
	ErrCodeCheckoutFailed    = "CHECKOUT_FAILED"
	ErrCodeStashFailed       = "STASH_FAILED"
	ErrCodeResetFailed       = "RESET_FAILED"
	ErrCodeDiscardFailed     = "DISCARD_FAILED"
	ErrCodeMergeConflict     = "MERGE_CONFLICT"
	ErrCodeMergeFailed       = "MERGE_FAILED"
	// Cherry-pick / revert (ADR-0042).
	ErrCodeCherryPickConflict = "CHERRY_PICK_CONFLICT"
	ErrCodeCherryPickFailed   = "CHERRY_PICK_FAILED"
	ErrCodeRevertConflict     = "REVERT_CONFLICT"
	ErrCodeRevertFailed       = "REVERT_FAILED"
	ErrCodeTagExists          = "TAG_EXISTS"
	ErrCodeTagNotFound        = "TAG_NOT_FOUND"
	ErrCodeGitFlowFailed      = "GIT_FLOW_FAILED"
	ErrCodeFetchFailed        = "FETCH_FAILED"
	ErrCodePushFailed         = "PUSH_FAILED"
	ErrCodePullFailed         = "PULL_FAILED"
	ErrCodeDiffFailed         = "DIFF_FAILED"
	ErrCodeWatchFailed        = "WATCH_FAILED"
	ErrCodeUnauthenticated    = "UNAUTHENTICATED"
	// ErrCodeNotImplemented marks Git read-path operations that are scheduled for
	// later phases (Phase 1/2). Returning it explicitly is preferable to faking
	// success. See docs/context/git-client/roadmap-mvp.md.
	ErrCodeNotImplemented = "NOT_IMPLEMENTED"
	// GitHub OAuth prototype (auth.proto)
	ErrCodeGitHubAuthFailed   = "GITHUB_AUTH_FAILED"
	ErrCodeGitHubApiFailed    = "GITHUB_API_FAILED"
	ErrCodeMissingClientId    = "MISSING_CLIENT_ID"
	ErrCodeTokenNotFound      = "TOKEN_NOT_FOUND"
	ErrCodeOAuthCancelled     = "OAUTH_CANCELLED"
	ErrCodeOAuthStateMismatch = "OAUTH_STATE_MISMATCH"
	// GitHub real data via gh CLI (errors.proto 19-23).
	ErrCodeGHCLINotFound        = "GH_CLI_NOT_FOUND"
	ErrCodeGHCLIUnauthenticated = "GH_CLI_UNAUTHENTICATED"
	ErrCodeGitHubRateLimited    = "GITHUB_RATE_LIMITED"
	ErrCodeGitHubAPIError       = "GITHUB_API_ERROR"
	ErrCodeGitHubTokenInvalid   = "GITHUB_TOKEN_INVALID"
	// Additive: repository relocation (errors.proto 33-34 — a registered folder
	// that was moved/renamed). REPO_PATH_MISSING distinguishes "the recorded fs
	// path is gone" from "the path exists but is not a Git repository"
	// (NOT_A_GIT_REPO); REPO_PATH_IN_USE rejects a target already tracked by
	// another repository. Next free numbers after 32.
	ErrCodeRepoPathMissing = "REPO_PATH_MISSING"
	ErrCodeRepoPathInUse   = "REPO_PATH_IN_USE"
)

// Advanced-git mutation errors (ADR-028). These mirror the branch error style
// (branch.go): a named AppError var carrying the canonical code.
var (
	ErrMergeConflict = AppError{Code: ErrCodeMergeConflict, Message: "merge conflict"}
	ErrMergeFailed   = AppError{Code: ErrCodeMergeFailed, Message: "merge failed"}
	// A conflict still mutated the working tree, exactly like ErrMergeConflict.
	ErrCherryPickConflict = AppError{Code: ErrCodeCherryPickConflict, Message: "cherry-pick conflict"}
	ErrRevertConflict     = AppError{Code: ErrCodeRevertConflict, Message: "revert conflict"}
	ErrTagExists          = AppError{Code: ErrCodeTagExists, Message: "tag already exists"}
	ErrTagNotFound        = AppError{Code: ErrCodeTagNotFound, Message: "tag not found"}
)
