//go:build windows

package main

// setUmask is a no-op on Windows, which has no umask. Unix-domain sockets are
// not used there (named pipes are), so there are no socket file-mode bits to
// restrict.
func setUmask(int) int {
	return 0
}
