package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// Exercises the exact archives used by the publisher. No user Desktop profile,
// configured workspace, live MCP listener or production CDN is accessed.
func TestPackagedRuntime(t *testing.T) {
	dir := os.Getenv("KP_LAUNCHER_TEST_PACKAGES")
	if dir == "" {
		t.Skip("supply real app and platform archives to run native package smoke")
	}
	target := "windows-x64"
	if runtime.GOOS == "darwin" {
		target = "macos-x64"
		if runtime.GOARCH == "arm64" {
			target = "macos-arm64"
		}
	}
	read := func(name string) Object {
		b, err := os.ReadFile(filepath.Join(dir, name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var o Object
		if err = json.Unmarshal(b, &o); err != nil {
			t.Fatal(err)
		}
		return o
	}
	server := httptest.NewTLSServer(http.StripPrefix("/objects/", http.FileServer(http.Dir(dir))))
	defer server.Close()
	s := Store{Home: t.TempDir(), Base: server.URL + "/", Client: server.Client(), Target: target}
	m := Manifest{Schema: 1, Sequence: 1, Version: "smoke", App: read("app"), Platforms: map[string]Object{target: read(target)}}
	if err := s.prepare(m); err != nil {
		t.Fatal(err)
	}
	root := s.release(m)
	electron := filepath.Join(root, "mcp/app/pet-companion/electron/electron.exe")
	node := "node.exe"
	if runtime.GOOS == "darwin" {
		electron = filepath.Join(root, "mcp/app/pet-companion/electron/Electron.app/Contents/MacOS/Electron")
		node = "bin/node"
	}
	// Resolve native addons against each host's ABI and exercise packaged PTY startup.
	script := `const p=require('node-pty'); const t=p.spawn(process.platform==='win32'?'cmd.exe':'/bin/sh',[]);let out='';t.onData(s=>out+=s);t.onExit(()=>{if(!out.includes('KEEPWORK_PTY_OK'))console.error(out);process.exit(out.includes('KEEPWORK_PTY_OK')?0:2)});t.write('echo KEEPWORK_PTY_OK\r');setTimeout(()=>t.write('exit\r'),400);setTimeout(()=>process.exit(3),9000).unref()`
	for _, host := range []struct{ exe, cwd string }{{electron, "desktop"}, {filepath.Join(root, "mcp", node), "mcp/app"}} {
		cmd := exec.Command(host.exe, "-e", script)
		cmd.Dir = filepath.Join(root, host.cwd)
		cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("PTY smoke for %s: %v %s", host.cwd, err, b)
		}
	}
	smoke, err := filepath.Abs("window-smoke.cjs")
	if err != nil {
		t.Fatal(err)
	}
	window := exec.Command(electron, smoke, "--user-data-dir="+t.TempDir())
	window.Env = append(os.Environ(), "KP_LAUNCHER_SMOKE_ROOT="+root)
	if b, err := window.CombinedOutput(); err != nil {
		t.Fatalf("offline Electron window: %v %s", err, b)
	}
	for _, rel := range []string{"web/AIChat.html", "desktop/dist/main.cjs", "mcp/app/cli.cjs", "model/app/dist/src/cli.js"} {
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Fatal(err)
		}
	}
}
