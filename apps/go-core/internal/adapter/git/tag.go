package git

import (
	"context"
	"strings"

	"github.com/SingulariTree/go-core/internal/domain"
)

// tagOpFailed builds a typed TAG_NOT_FOUND error with a short, bounded message.
// TAG_NOT_FOUND is the only non-collision tag code the contract (ADR-028)
// defines, so a rejected tag mutation other than a name collision reuses it.
func tagOpFailed(message string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeTagNotFound,
		Message: truncateValidUTF8(strings.TrimSpace(message), maxCheckoutErrLen),
	}
}

// tagOpFailedFromGit builds the TAG_NOT_FOUND error for a failed tag git
// command: a short summary plus the bounded raw text for diagnostics.
func tagOpFailedFromGit(rawErr string) domain.AppError {
	return domain.AppError{
		Code:    domain.ErrCodeTagNotFound,
		Message: shortGitSummaryWithFallback(rawErr, "git tag failed"),
		Details: map[string]string{"raw": boundCheckoutRaw(rawErr)},
	}
}

// tagExists builds the typed TAG_EXISTS error for a name collision.
func tagExists(name string) domain.AppError {
	return domain.ErrTagExists.WithDetail("name", name)
}

// tagRefExists reports whether refs/tags/<name> exists.
func (a *Adapter) tagRefExists(ctx context.Context, fsPath, name string) bool {
	_, code, _ := runGitAllowExit(ctx, fsPath, "show-ref", "--verify", "--quiet", "refs/tags/"+name)
	return code == 0
}

// readTag reads a single tag back through the same for-each-ref path as
// TagList, so a freshly created tag carries its target, tagger and message.
// The fallback (unreadable record) yields a minimal Tag rather than an error.
func (a *Adapter) readTag(ctx context.Context, fsPath, name string) *domain.Tag {
	fallback := &domain.Tag{Name: name, RefName: domain.RefName{Raw: "refs/tags/" + name}}
	out, err := runGit(ctx, fsPath, "for-each-ref", "--format="+tagPrettyFormat, "refs/tags/"+name)
	if err != nil {
		return fallback
	}
	tags := parseTags(out)
	if len(tags) == 0 {
		return fallback
	}
	return &tags[0]
}

// TagCreate creates a tag via `git tag [-a -m <message>] [-f] <name> [<target>]`.
// An empty target means HEAD; an annotated tag carries the message (defaulting
// to the tag name so the headless core never opens an editor). An existing tag
// yields TAG_EXISTS unless force is set (which maps to -f).
func (a *Adapter) TagCreate(ctx context.Context, repoID domain.RepositoryId, name, target string, annotated bool, message string, force bool) (*domain.Tag, error) {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" || !checkSafeRef(name) {
		return nil, tagOpFailed("invalid tag name")
	}
	target = strings.TrimSpace(target)
	if target != "" && !checkSafeArg(target) {
		return nil, tagOpFailed("invalid tag target")
	}
	if a.tagRefExists(ctx, fsPath, name) && !force {
		return nil, tagExists(name)
	}

	args := []string{"tag"}
	if annotated {
		msg := strings.TrimSpace(message)
		if msg == "" {
			msg = name
		}
		args = append(args, "-a", "-m", msg)
	}
	if force {
		args = append(args, "-f")
	}
	args = append(args, name)
	if target != "" {
		args = append(args, target)
	}
	if _, err := runGit(ctx, fsPath, args...); err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return nil, tagExists(name)
		}
		return nil, tagOpFailedFromGit(err.Error())
	}
	return a.readTag(ctx, fsPath, name), nil
}

// TagDelete deletes a tag via `git tag -d <name>`. A missing tag yields
// TAG_NOT_FOUND.
func (a *Adapter) TagDelete(ctx context.Context, repoID domain.RepositoryId, ref domain.RefName) error {
	fsPath, err := a.resolvePath(ctx, repoID)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(ref.Raw)
	name = strings.TrimPrefix(name, "refs/tags/")
	if name == "" || !checkSafeRef(name) {
		return tagOpFailed("invalid tag name")
	}
	if !a.tagRefExists(ctx, fsPath, name) {
		return domain.ErrTagNotFound.WithDetail("name", name)
	}
	if _, err := runGit(ctx, fsPath, "tag", "-d", name); err != nil {
		return tagOpFailedFromGit(err.Error())
	}
	return nil
}
