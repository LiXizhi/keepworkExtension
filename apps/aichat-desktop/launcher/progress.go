package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Only first install needs an explicit window. Update checks already have the
// Desktop update window, and a cached launch immediately opens the application.
type progress struct {
	file        string
	last        time.Time
	done, total int64
}

var firstInstall *progress
var installContext = context.Background()

func startProgress(home string) func() {
	dir, err := os.MkdirTemp(home, "progress-")
	if err != nil {
		return func() {}
	}
	p := &progress{file: filepath.Join(dir, "status")}
	p.message("正在准备 Keepwork…")
	firstInstall = p
	ctx, cancel := context.WithCancel(context.Background())
	installContext = ctx
	stop := progressWindow(p.file, cancel)
	return func() { stop(); cancel(); installContext = context.Background(); firstInstall = nil; os.RemoveAll(dir) }
}
func (p *progress) message(s string) {
	if p != nil {
		_ = os.WriteFile(p.file, []byte("-1\n"+s), 0600)
	}
}
func (p *progress) Write(b []byte) (int, error) {
	if p != nil {
		p.done += int64(len(b))
		if time.Since(p.last) > 500*time.Millisecond {
			p.last = time.Now()
			_ = os.WriteFile(p.file, []byte(fmt.Sprintf("%d\n正在下载  %.1f / %.1f MB", 100*p.done/p.total, float64(p.done)/1e6, float64(p.total)/1e6)), 0600)
		}
	}
	return len(b), nil
}
