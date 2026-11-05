//go:build windows

package git

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// cancelProcessTree kills the entire process tree rooted at p and returns the
// result of killing p itself (so its error semantics, including os.ErrProcessDone,
// match the default exec.CommandContext Cancel).
//
// WHY this exists on Windows: exec.CommandContext's default Cancel kills only
// the direct child. For a git remote operation that child is git itself, but git
// spawns its transport (the GIT_SSH_COMMAND helper) through a shell wrapper that
// inherits git's working directory — the repository, set via `git -C <repo>`.
// Windows refuses to delete or move a directory that is the current directory of
// any live process, so an orphaned transport wrapper left holding the repo
// blocks repo deletion/relocation — and makes t.TempDir cleanup fail with "The
// process cannot access the file because it is being used by another process".
// Tearing down the whole tree on cancellation prevents that orphan.
//
// The Toolhelp snapshot is taken at cancellation time; a process could start or
// exit between the snapshot and the kill (a benign race). That is acceptable
// here because the tree is already complete: the fetch is blocked inside the
// transport when the context is cancelled, so no further children are spawned.
// Processes that vanish mid-walk are skipped (OpenProcess fails); the direct
// child is always killed last via p.Kill.
func cancelProcessTree(p *os.Process) error {
	descendants, err := processTreeDescendants(uint32(p.Pid))
	if err != nil {
		// Degrade to the default behavior: kill at least the direct child.
		return p.Kill()
	}
	// Kill descendants first (deepest/youngest first, reverse BFS order) so the
	// tree unwinds leaves-to-root, then reap the direct child.
	for i := len(descendants) - 1; i >= 0; i-- {
		killProcess(descendants[i])
	}
	return p.Kill()
}

// processTreeDescendants returns every descendant of root in BFS order
// (parents before children), using a Toolhelp process snapshot.
func processTreeDescendants(root uint32) ([]uint32, error) {
	children, err := processChildrenByParent()
	if err != nil {
		return nil, err
	}
	seen := map[uint32]bool{root: true} // never revisit the root as a descendant
	var order []uint32
	queue := []uint32{root}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		for _, child := range children[pid] {
			if seen[child] {
				continue
			}
			seen[child] = true
			order = append(order, child)
			queue = append(queue, child)
		}
	}
	return order, nil
}

// processChildrenByParent snapshots the system process table and returns a
// parent-PID → child-PIDs adjacency map.
func processChildrenByParent() (map[uint32][]uint32, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(snap) }()

	children := make(map[uint32][]uint32)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snap, &entry); err != nil {
		return nil, err
	}
	for {
		children[entry.ParentProcessID] = append(children[entry.ParentProcessID], entry.ProcessID)
		entry.Size = uint32(unsafe.Sizeof(entry))
		if err := windows.Process32Next(snap, &entry); err != nil {
			// ERROR_NO_MORE_FILES signals the end of the enumeration.
			return children, nil
		}
	}
}

// killProcess terminates pid and waits for the process to be fully torn down,
// ignoring processes that have already exited (a snapshot race is expected and
// harmless). The explicit wait matters: TerminateProcess is asynchronous, and
// the process's current-directory reference (which can block directory deletion
// on Windows) is only released once the kernel has finished tearing the process
// down — waiting on the handle makes "the tree is gone" a guarantee for the
// caller instead of a timing assumption.
func killProcess(pid uint32) {
	// Opening the handle by PID is also the liveness check; a PID recycled
	// between the snapshot and this call would be a (microseconds-wide) TOCTOU
	// window in which an unrelated process could be terminated. The window is
	// inherent to PID-based tree walks and is accepted here: at cancellation
	// time the tree is quiescent (the fetch is blocked inside the transport),
	// so nothing is spawning or exiting.
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return
	}
	defer func() { _ = windows.CloseHandle(h) }()
	if err := windows.TerminateProcess(h, 1); err != nil {
		return
	}
	// Bounded wait for full teardown (WAIT_OBJECT_0 or timeout, either is
	// acceptable: the kill is issued either way).
	_, _ = windows.WaitForSingleObject(h, 2000)
}
