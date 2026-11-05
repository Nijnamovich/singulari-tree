//go:build !windows

package main

import "syscall"

// setUmask sets the process file-creation mask and returns the previous value.
func setUmask(mask int) int {
	return syscall.Umask(mask)
}
