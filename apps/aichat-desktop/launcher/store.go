package main

import (
	"archive/zip"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const feed = "https://cdn.keepwork.com/keepwork/aichat-launcher/v1/"

var publicKey string // raw Ed25519 public key, embedded at launcher build time
var digest = regexp.MustCompile("^[0-9a-f]{64}$")

type Object struct {
	SHA256 string
	Size   int64
}
type Manifest struct {
	Schema    int
	Sequence  int64
	Version   string
	App       Object
	Platforms map[string]Object
}
type Envelope struct{ Payload, Signature []byte }
type Store struct {
	Home, Base, Target string
	Key                ed25519.PublicKey
	Client             *http.Client
}

func (s Store) verify(data []byte) (m Manifest, err error) {
	var envelope Envelope
	if json.Unmarshal(data, &envelope) != nil || len(s.Key) != ed25519.PublicKeySize || !ed25519.Verify(s.Key, envelope.Payload, envelope.Signature) {
		return m, errors.New("invalid release signature")
	}
	if err = json.Unmarshal(envelope.Payload, &m); err != nil {
		return
	}
	if m.Schema != 1 || m.Sequence < 1 || m.Version == "" {
		return m, errors.New("unsupported release manifest")
	}
	for _, obj := range []Object{m.App, m.Platforms[s.Target]} {
		if !digest.MatchString(obj.SHA256) || obj.Size <= 0 || obj.Size > 4<<30 {
			return m, errors.New("invalid or missing package for " + s.Target)
		}
	}
	return
}

func (s Store) get(name string) (io.ReadCloser, error) {
	res, err := s.Client.Get(s.Base + name)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, fmt.Errorf("%s: HTTP %d", name, res.StatusCode)
	}
	return res.Body, nil
}

// Extract into an empty private directory. Create links last so archive members
// cannot write through them. macOS Electron frameworks require relative links.
func unpack(file, dir string) error {
	z, err := zip.OpenReader(file)
	if err != nil {
		return err
	}
	defer z.Close()
	if len(z.File) > 150000 {
		return errors.New("archive entry limit exceeded")
	}
	links := map[string]string{}
	var total uint64
	for _, f := range z.File {
		name := strings.TrimSuffix(f.Name, "/")
		rel := filepath.FromSlash(name)
		if !fs.ValidPath(name) || !filepath.IsLocal(rel) || strings.ContainsAny(name, "\\:") {
			return errors.New("invalid archive path")
		}
		dest := filepath.Join(dir, rel)
		mode := f.Mode()
		if mode.IsDir() {
			if err := os.MkdirAll(dest, 0755); err != nil {
				return err
			}
			continue
		}
		if f.UncompressedSize64 > 8<<30 || total+f.UncompressedSize64 > 12<<30 {
			return errors.New("archive size limit exceeded")
		}
		total += f.UncompressedSize64
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		if mode&os.ModeSymlink != 0 {
			b, err := io.ReadAll(io.LimitReader(in, 4097))
			in.Close()
			target := string(b)
			if err != nil || len(b) > 4096 || target == "" || filepath.IsAbs(target) || strings.ContainsAny(target, "\\:") || !filepath.IsLocal(filepath.Join(filepath.Dir(rel), target)) {
				return errors.New("invalid archive link")
			}
			links[dest] = target
			continue
		}
		if !mode.IsRegular() {
			in.Close()
			return errors.New("invalid archive member type")
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm()|0600)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		closeErr := out.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	for dest, target := range links {
		if err := os.Symlink(target, dest); err != nil {
			return err
		}
	}
	// Check resolved targets as well as individual link paths.
	canonicalRoot, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	for dest := range links {
		resolved, err := filepath.EvalSymlinks(dest)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(canonicalRoot, resolved)
		if err != nil || !filepath.IsLocal(rel) {
			return fmt.Errorf("archive link escapes package: %s", dest)
		}
	}
	return nil
}

// Windows virus scanners briefly hold new executables without share-delete.
// Retry the atomic promotion while keeping the verified download for a later retry.
func promote(src, dest string) error {
	deadline := time.Now().Add(15 * time.Second)
	for {
		err := os.Rename(src, dest)
		if err == nil || runtime.GOOS != "windows" || (!errors.Is(err, os.ErrPermission) && !errors.Is(err, syscall.Errno(32))) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
}
func (s Store) object(o Object) (string, error) {
	dest := filepath.Join(s.Home, "objects", o.SHA256)
	if st, err := os.Stat(dest); err == nil && st.IsDir() {
		return dest, nil
	}
	stage, err := os.MkdirTemp(s.Home, "stage-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	file, err := s.download(o)
	if err != nil {
		return "", err
	}
	tree := filepath.Join(stage, "files")
	if err = os.Mkdir(tree, 0700); err != nil {
		return "", err
	}
	firstInstall.message("正在校验并安装文件…")
	if err = unpack(file, tree); err != nil {
		return "", err
	}
	if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return "", err
	}
	if err = promote(tree, dest); err != nil {
		return "", err
	}
	_ = os.Remove(file)
	return dest, nil
}

// Merge disjoint platform and portable file trees without duplicating binaries.
func overlay(src, dest string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		out := filepath.Join(dest, rel)
		if d.IsDir() {
			if st, e := os.Lstat(out); e == nil && !st.IsDir() {
				return errors.New("package directory collision")
			}
			return os.MkdirAll(out, 0755)
		}
		if d.Type()&os.ModeSymlink != 0 {
			t, e := os.Readlink(p)
			if e != nil {
				return e
			}
			return os.Symlink(t, out)
		}
		return os.Link(p, out)
	})
}
func (s Store) release(m Manifest) string {
	return filepath.Join(s.Home, "releases", fmt.Sprintf("%d-%s", m.Sequence, m.App.SHA256))
}
func (s Store) prepare(m Manifest) error {
	dest := s.release(m)
	if _, err := os.Stat(dest); err == nil {
		return nil
	}
	tmp, err := os.MkdirTemp(s.Home, "release-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	for _, obj := range []Object{m.Platforms[s.Target], m.App} {
		src, err := s.object(obj)
		if err != nil {
			return err
		}
		if err = overlay(src, tmp); err != nil {
			return err
		}
	}
	for _, service := range []string{"mcp", "model"} {
		p := filepath.Join(tmp, service, "runtime-"+s.Target+".json")
		if err = os.Rename(p, filepath.Join(tmp, service, "runtime.json")); err != nil {
			return err
		}
	}
	if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	return promote(tmp, dest)
}
func productionStore(home, target string) (Store, error) {
	key, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(key) != 32 {
		return Store{}, errors.New("launcher missing a valid release key")
	}
	return Store{home, feed, target, key, &http.Client{Timeout: 30 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
