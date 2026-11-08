package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func zipped(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, data := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write([]byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func obj(b []byte) Object {
	h := sha256.Sum256(b)
	return Object{hex.EncodeToString(h[:]), int64(len(b))}
}
func signed(t *testing.T, m Manifest, key ed25519.PrivateKey) []byte {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(Envelope{b, ed25519.Sign(key, b)})
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}
func TestFirstInstallAndCodeOnlyRefresh(t *testing.T) {
	for _, target := range []string{"windows-x64", "macos-x64", "macos-arm64"} {
		t.Run(target, func(t *testing.T) {
			key, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			platform := zipped(t, map[string]string{"desktop/node_modules/example/index.js": "module.exports=42"})
			files := map[string]string{"desktop/dist/main.cjs": "first menu", "mcp/runtime-" + target + ".json": "{}", "model/runtime-" + target + ".json": "{}"}
			first := zipped(t, files)
			files["desktop/dist/main.cjs"] = "new menu"
			second := zipped(t, files)
			blobs := map[string][]byte{}
			for _, b := range [][]byte{platform, first, second} {
				blobs["/objects/"+obj(b).SHA256+".zip"] = b
			}
			m := Manifest{1, 1, "1.0.0", obj(first), map[string]Object{target: obj(platform)}}
			blobs["/stable.json"] = signed(t, m, private)
			requests := map[string]int{}
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests[r.URL.Path]++
				b, ok := blobs[r.URL.Path]
				if !ok {
					http.NotFound(w, r)
					return
				}
				w.Write(b)
			}))
			defer server.Close()
			s := Store{t.TempDir(), server.URL + "/", target, key, server.Client()}
			var st State
			if err = s.refresh(&st); err != nil {
				t.Fatal(err)
			}
			st.Active = st.Pending
			st.Pending = nil
			if err = s.save(st); err != nil {
				t.Fatal(err)
			}
			m.Sequence++
			m.Version = "1.0.1"
			m.App = obj(second)
			blobs["/stable.json"] = signed(t, m, private)
			if err = s.refresh(&st); err != nil {
				t.Fatal(err)
			}
			for p, n := range requests {
				if p != "/stable.json" && n != 1 {
					t.Fatalf("duplicate download: %s x%d", p, n)
				}
			}
			if len(requests) != 4 || requests["/stable.json"] != 2 {
				t.Fatal(requests)
			}
			for _, item := range []struct {
				m    *Manifest
				want string
			}{{st.Active, "first menu"}, {st.Pending, "new menu"}} {
				b, e := os.ReadFile(filepath.Join(s.release(*item.m), "desktop/dist/main.cjs"))
				if e != nil || string(b) != item.want {
					t.Fatal(e, string(b))
				}
			}
			// A bad signature or damaged newer artifact cannot disturb the active or pending release.
			blobs["/stable.json"] = []byte("{}")
			if s.refresh(&st) == nil {
				t.Fatal("accepted unsigned manifest")
			}
			m.Sequence++
			m.App = obj([]byte("good"))
			blobs["/stable.json"] = signed(t, m, private)
			blobs["/objects/"+m.App.SHA256+".zip"] = []byte("evil")
			if s.refresh(&st) == nil {
				t.Fatal("accepted corrupt archive")
			}
			saved, e := s.state()
			if e != nil || saved.Highest != 2 || saved.Active.Sequence != 1 || saved.Pending.Sequence != 2 {
				t.Fatal(saved, e)
			}
			server.Close()
			if s.refresh(&st) == nil {
				t.Fatal("offline check should report unreachable feed")
			}
			if _, e := os.Stat(s.release(*saved.Active)); e != nil {
				t.Fatal(e)
			}
		})
	}
}
func TestUnpackRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bad.zip")
	os.WriteFile(f, zipped(t, map[string]string{"../escape": "no"}), 0600)
	if unpack(f, dir) == nil {
		t.Fatal("accepted traversal")
	}
}

func TestStartupRollback(t *testing.T) {
	s := Store{Home: t.TempDir(), Target: "windows-x64"}
	previous := Manifest{Sequence: 1}
	candidate := Manifest{Sequence: 2}
	st := State{Active: &previous, Pending: &candidate, Highest: 2}
	calls := []int64{}
	err := s.activate(st, false, func(m Manifest, bg, checking bool) error {
		calls = append(calls, m.Sequence)
		if checking {
			return errors.New("crashed")
		}
		return nil
	})
	saved, e := s.state()
	if err != nil || e != nil || len(calls) != 2 || calls[0] != 2 || calls[1] != 1 || saved.Active.Sequence != 1 || saved.Failed != 2 || saved.Pending != nil {
		t.Fatal(calls, saved, err, e)
	}
}
func TestInterruptedTransferResumes(t *testing.T) {
	body := []byte("shared archive bytes")
	o := obj(body)
	dir := t.TempDir()
	part := filepath.Join(dir, o.SHA256+".part")
	if err := os.WriteFile(part, body[:4], 0600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=4-" {
			t.Error(r.Header)
		}
		w.Header().Set("Content-Range", "bytes 4-19/20")
		w.WriteHeader(206)
		w.Write(body[4:])
	}))
	defer server.Close()
	s := Store{Home: dir, Base: server.URL + "/", Client: server.Client()}
	file, err := s.download(o)
	if err != nil || file != part {
		t.Fatal(file, err)
	}
}

func TestDuplicateLauncherDoesNotWaitForDownload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update.lock")
	release, err := lockStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	result := make(chan error, 1)
	go func() {
		unlock, e := lockStore(path)
		if unlock != nil {
			unlock()
		}
		result <- e
	}()
	select {
	case e := <-result:
		if !errors.Is(e, errBusy) {
			t.Fatalf("duplicate launcher: %v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second launcher waited on first installation")
	}
}
