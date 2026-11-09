package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var setupProgram []byte // populated by build.py in release builds
func installedPath() (string, error) {
	base, err := os.UserCacheDir()
	return filepath.Join(base, "Programs", "Keepwork Desktop", "Keepwork.exe"), err
}
func alreadyInstalled(src string) bool {
	base, err := os.UserCacheDir()
	return err == nil && sameLocation(src, filepath.Join(base, "Programs", "aichat-desktop", "KeepWork 第二大脑.exe"))
}
func installLauncher(source, target string, silent bool) error {
	if len(setupProgram) == 0 {
		return errors.New("build the launcher with build.py to include Windows Setup")
	}
	dir, err := os.MkdirTemp("", "Keepwork-Setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	setup := filepath.Join(dir, "Setup.exe")
	if err = os.WriteFile(setup, setupProgram, 0700); err != nil {
		return err
	}
	args := []string{}
	if silent {
		args = append(args, "/S")
	}
	cmd := exec.Command(setup, args...)
	cmd.Env = append(os.Environ(), "KEEPWORK_SETUP_SOURCE="+source)
	// Explicitly show the installer even if the download was opened from a hidden host.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: false}
	if err = cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			return context.Canceled
		}
		return err
	}
	if !sameBinary(source, target) || !installationComplete(target) {
		return errors.New("Windows Setup did not finish installing Keepwork")
	}
	return nil
}

func installationComplete(target string) bool {
	_, err := os.Stat(filepath.Join(filepath.Dir(target), "Uninstall.exe"))
	return err == nil
}

func bringSetupForward() {
	title, _ := syscall.UTF16PtrFromString("Keepwork Desktop Setup")
	h, _, _ := user.NewProc("FindWindowW").Call(0, uintptr(unsafe.Pointer(title)))
	if h != 0 {
		user.NewProc("SetForegroundWindow").Call(h)
	}
}
