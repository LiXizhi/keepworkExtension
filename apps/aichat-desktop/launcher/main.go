package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type State struct {
	Active, Pending, Previous *Manifest
	Highest                   int64
	Failed                    int64
}

func (s Store) state() (State, error) {
	var st State
	b, err := os.ReadFile(filepath.Join(s.Home, "state.json"))
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	err = json.Unmarshal(b, &st)
	return st, err
}
func (s Store) save(st State) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.Home, "state-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(b); err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return promote(tmp.Name(), filepath.Join(s.Home, "state.json"))
}
func (s Store) refresh(st *State) error {
	body, err := s.get("stable.json")
	if err != nil {
		return err
	}
	defer body.Close()
	b, err := io.ReadAll(io.LimitReader(body, 1<<20))
	if err != nil {
		return err
	}
	m, err := s.verify(b)
	if err != nil {
		return err
	}
	if m.Sequence < st.Highest {
		return errors.New("stale stable manifest")
	}
	if m.Sequence == st.Failed {
		return errors.New("release previously failed startup")
	}
	if m.Sequence == st.Highest {
		return nil
	}
	if err = s.prepare(m); err != nil {
		return err
	}
	st.Pending = &m
	st.Highest = m.Sequence
	return s.save(*st)
}
func (s Store) launch(m Manifest, background, candidate bool) error {
	root := s.release(m)
	electron := filepath.Join(root, "mcp", "app", "pet-companion", "electron")
	exe := filepath.Join(electron, "electron.exe")
	if runtime.GOOS == "darwin" {
		exe = filepath.Join(electron, "Electron.app", "Contents", "MacOS", "Electron")
	}
	args := []string{filepath.Join(root, "desktop")}
	if background {
		args = append(args, "--background")
	}
	cmd := exec.Command(exe, args...)
	launcher, err := os.Executable()
	if err != nil {
		return err
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "ELECTRON_RUN_AS_NODE", "AICHAT_LAUNCH_READY", "AICHAT_RELEASE_ROOT", "AICHAT_LAUNCHER":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "AICHAT_LAUNCHER="+launcher, "AICHAT_RELEASE_ROOT="+root)
	var receipt string
	if candidate || !background {
		dir, err := os.MkdirTemp(s.Home, "startup-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		receipt = filepath.Join(dir, "ready")
		cmd.Env = append(cmd.Env, "AICHAT_LAUNCH_READY="+receipt)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if !candidate && background {
		return cmd.Process.Release()
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	timeout := time.NewTimer(120 * time.Second)
	defer timeout.Stop()
	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-installContext.Done():
			_ = cmd.Process.Kill()
			<-exited
			return context.Canceled
		case <-tick.C:
			if b, err := os.ReadFile(receipt); err == nil {
				if string(b) != "ready" {
					_ = cmd.Process.Kill()
					<-exited
					return errors.New("AIChat could not render its window")
				}
				return nil
			}
		case err := <-exited:
			if err == nil {
				return errAlreadyRunning
			}
			return err
		case <-timeout.C:
			_ = cmd.Process.Kill()
			<-exited
			return errors.New("desktop startup timed out")
		}
	}
}

var errBusy = errors.New("launcher is busy")
var errAlreadyRunning = errors.New("desktop already running")

func run() error {
	target := map[string]string{"darwin/arm64": "macos-arm64", "darwin/amd64": "macos-x64", "windows/amd64": "windows-x64"}[runtime.GOOS+"/"+runtime.GOARCH]
	if target == "" {
		return errors.New("unsupported platform")
	}
	parent, err := os.UserCacheDir()
	if runtime.GOOS == "darwin" {
		parent, err = os.UserConfigDir()
	}
	if err != nil {
		return err
	}
	s, err := productionStore(filepath.Join(parent, "Keepwork", "DesktopLauncher"), target)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(s.Home, 0700); err != nil {
		return err
	}
	if handled, err := handleSetup(s.Home); handled {
		return err
	}
	check := len(os.Args) > 1 && os.Args[1] == "--check"
	bg := len(os.Args) > 1 && os.Args[1] == "--background"
	unlock, err := lockStore(filepath.Join(s.Home, "update.lock"))
	if errors.Is(err, errBusy) {
		if check {
			return json.NewEncoder(os.Stdout).Encode(map[string]any{"busy": true})
		}
		if !bg {
			focusProgress()
		}
		return nil
	}
	if err != nil {
		return err
	}
	defer unlock()
	st, err := s.state()
	if err != nil {
		return err
	}

	if !check && !bg {
		closeProgress := startProgress(s.Home)
		defer closeProgress()
	}
	if check || st.Active == nil && st.Pending == nil {
		if err = s.refresh(&st); err != nil {
			return err
		}
	}
	if check {
		m := st.Pending
		if m == nil {
			m = st.Active
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"version": m.Version, "pending": st.Pending != nil})
	}

	return s.activate(st, bg, s.launch)
}
func (s Store) activate(st State, bg bool, launch func(Manifest, bool, bool) error) error {
	if st.Pending != nil {
		firstInstall.message("正在打开 Keepwork…")
		err := launch(*st.Pending, bg, true)
		if errors.Is(err, context.Canceled) {
			return err
		}
		if errors.Is(err, errAlreadyRunning) {
			return nil
		}
		if err == nil {
			st.Previous = st.Active
			st.Active = st.Pending
			st.Pending = nil
			if e := s.save(st); e != nil {
				return e
			}
			s.clean(st)
			return nil
		}
		st.Failed = st.Pending.Sequence
		st.Pending = nil
		if e := s.save(st); e != nil {
			return e
		}
		if st.Active == nil {
			return err
		}
	}
	if st.Active == nil {
		return errors.New("no working release available")
	}
	err := launch(*st.Active, bg, false)
	if errors.Is(err, errAlreadyRunning) {
		return nil
	}
	return err
}
func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, err)
		if len(os.Args) == 1 {
			showError(err.Error())
		}
		os.Exit(1)
	}
}
