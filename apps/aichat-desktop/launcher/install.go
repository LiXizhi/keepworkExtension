package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

// The installed executable must be the one handed to Electron for future
// restarts and login items. A download remains removable after setup.
func setupAndOpen(source, target string, unattended bool) error {
	if !sameBinary(source, target) || !installationComplete(target) {
		if err := installLauncher(source, target, unattended); err != nil {
			return err
		}
	}
	if unattended {
		return nil
	}
	cmd := exec.Command(target)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open installed Keepwork: %w", err)
	}
	return cmd.Process.Release()
}

func sameBinary(a, b string) bool {
	hash := func(name string) ([]byte, error) {
		f, e := os.Open(name)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		h := sha256.New()
		_, e = io.Copy(h, f)
		return h.Sum(nil), e
	}
	left, e := hash(a)
	if e != nil {
		return false
	}
	right, e := hash(b)
	return e == nil && bytes.Equal(left, right)
}

func sameLocation(a, b string) bool {
	first, e := os.Stat(a)
	second, f := os.Stat(b)
	return e == nil && f == nil && os.SameFile(first, second)
}

func handleSetup(home string) (bool, error) {
	source, err := os.Executable()
	if err != nil {
		return true, err
	}
	target, err := installedPath()
	if err != nil {
		return true, err
	}
	unattended := len(os.Args) == 2 && os.Args[1] == "--install-only"
	if len(os.Args) > 1 && !unattended {
		return false, nil
	}
	if sameLocation(source, target) || alreadyInstalled(source) {
		return unattended, nil
	}
	unlock, err := lockStore(filepath.Join(home, "setup.lock"))
	if errors.Is(err, errBusy) {
		if unattended {
			return true, err
		}
		bringSetupForward()
		return true, nil
	}
	if err != nil {
		return true, err
	}
	defer unlock()
	return true, setupAndOpen(source, target, unattended)
}
