//go:build !windows

package git

import "os"

// cancelProcessTree kills only the direct child, identical to today's default
// Cancel behavior. On POSIX an orphaned transport grandchild does not block
// directory removal, so tearing down the process group is a deliberate
// out-of-scope follow-up.
func cancelProcessTree(p *os.Process) error { return p.Kill() }
