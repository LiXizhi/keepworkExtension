package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// The store lock serializes writers. Preserve interrupted transfers between
// launches; verify the complete file before permitting extraction.
func (s Store) download(o Object) (string, error) {
	file := filepath.Join(s.Home, o.SHA256+".part")
	out, err := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer out.Close()
	start, err := out.Seek(0, io.SeekEnd)
	if err != nil {
		return "", err
	}
	if start > o.Size {
		if err = out.Truncate(0); err != nil {
			return "", err
		}
		start = 0
	}
	if start < o.Size {
		req, err := http.NewRequestWithContext(installContext, "GET", s.Base+"objects/"+o.SHA256+".zip", nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Accept-Encoding", "identity")
		if start > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
		}
		res, err := s.Client.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		switch res.StatusCode {
		case 200:
			start = 0
			if err = out.Truncate(0); err != nil {
				return "", err
			}
		case 206:
			if res.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", start, o.Size-1, o.Size) {
				return "", errors.New("invalid CDN byte range")
			}
		default:
			return "", fmt.Errorf("package HTTP %d", res.StatusCode)
		}
		if _, err = out.Seek(start, io.SeekStart); err != nil {
			return "", err
		}
		if firstInstall != nil {
			firstInstall.done = start
			firstInstall.total = o.Size
		}
		n, err := io.Copy(io.MultiWriter(out, firstInstall), io.LimitReader(res.Body, o.Size-start+1))
		if err != nil {
			return "", err
		}
		if n != o.Size-start {
			return "", errors.New("incomplete package transfer")
		}
	}
	if _, err = out.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, out); err != nil {
		return "", err
	}
	if hex.EncodeToString(hash.Sum(nil)) != o.SHA256 {
		out.Close()
		os.Remove(file)
		return "", errors.New("package integrity check failed")
	}
	return file, nil
}
func (s Store) clean(st State) {
	keep := map[string]bool{}
	for _, m := range []*Manifest{st.Active, st.Previous, st.Pending} {
		if m != nil {
			keep[s.release(*m)] = true
			for _, o := range []Object{m.App, m.Platforms[s.Target]} {
				keep[filepath.Join(s.Home, "objects", o.SHA256)] = true
			}
		}
	}
	for _, folder := range []string{"releases", "objects"} {
		dir := filepath.Join(s.Home, folder)
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			p := filepath.Join(dir, entry.Name())
			if entry.IsDir() && !keep[p] {
				_ = os.RemoveAll(p)
			}
		}
	}
}
