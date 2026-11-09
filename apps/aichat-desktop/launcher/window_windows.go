package main

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var user = syscall.NewLazyDLL("user32.dll")

const windowTitle = "Keepwork Desktop · 启动器"

func utf(s string) uintptr         { return uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(s))) }
func send(hwnd, msg, w, l uintptr) { user.NewProc("SendMessageW").Call(hwnd, msg, w, l) }
func focusProgress() {
	hwnd, _, _ := user.NewProc("FindWindowW").Call(0, utf(windowTitle))
	if hwnd != 0 {
		user.NewProc("ShowWindow").Call(hwnd, 9)
		user.NewProc("SetForegroundWindow").Call(hwnd)
	}
}

// Keep window creation, message dispatch and destruction on the same OS thread.
func progressWindow(file string, cancel func()) func() {
	ready := make(chan struct{})
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(done)
		type controls struct{ Size, Classes uint32 }
		cc := controls{8, 32}
		syscall.NewLazyDLL("comctl32.dll").NewProc("InitCommonControlsEx").Call(uintptr(unsafe.Pointer(&cc)))
		instance, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
		create := func(kind, title string, style, x, y, w, h, parent uintptr) uintptr {
			handle, _, _ := user.NewProc("CreateWindowExW").Call(0, utf(kind), utf(title), style, x, y, w, h, parent, 0, instance, 0)
			return handle
		}
		metric := func(index uintptr) uintptr { v, _, _ := user.NewProc("GetSystemMetrics").Call(index); return v }
		width, height := uintptr(440), uintptr(156)
		hwnd := create("#32770", windowTitle, 0x00c00000|0x00800000|0x00080000, (metric(0)-width)/2, (metric(1)-height)/2, width, height, 0)
		if hwnd == 0 {
			close(ready)
			return
		}
		defer user.NewProc("DestroyWindow").Call(hwnd)
		// The launcher owns resource 1, also used by Explorer and the taskbar.
		icon, _, _ := user.NewProc("LoadIconW").Call(instance, 1)
		send(hwnd, 0x80, 0, icon)
		send(hwnd, 0x80, 1, icon)
		child := uintptr(0x50000000)
		image := create("STATIC", "", child|3, 18, 15, 32, 32, hwnd)
		send(image, 0x170, icon, 0)
		label := create("STATIC", "正在启动 Keepwork…", child, 65, 20, 340, 28, hwnd)
		font, _, _ := syscall.NewLazyDLL("gdi32.dll").NewProc("GetStockObject").Call(17)
		send(label, 0x30, font, 1)
		bar := create("msctls_progress32", "", child|8, 20, 68, 392, 18, hwnd)
		send(bar, 0x40a, 1, 40)
		user.NewProc("ShowWindow").Call(hwnd, 5)
		user.NewProc("UpdateWindow").Call(hwnd)
		close(ready)
		type msg struct {
			Window         uintptr
			Message        uint32
			Wparam, Lparam uintptr
			Time           uint32
			X, Y           int32
			Private        uint32
		}
		var m msg
		last := ""
		marquee := true
		for {
			for {
				ok, _, _ := user.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, 1)
				if ok == 0 {
					break
				}
				if m.Message == 0x10 || (m.Message == 0x112 && m.Wparam&0xfff0 == 0xf060) {
					cancel()
					return
				}
				user.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&m)))
				user.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&m)))
			}
			if visible, _, _ := user.NewProc("IsWindowVisible").Call(hwnd); visible == 0 {
				cancel()
				return
			}
			data, _ := os.ReadFile(file)
			v := string(data)
			if v != "" && v != last {
				last = v
				percent, text, ok := strings.Cut(v, "\n")
				if ok {
					n, _ := strconv.Atoi(percent)
					user.NewProc("SetWindowTextW").Call(label, utf(text))
					if (n < 0) != marquee {
						marquee = n < 0
						style := child
						if marquee {
							style |= 8
						}
						user.NewProc("SetWindowLongW").Call(bar, 0xfffffff0, style)
						if marquee {
							send(bar, 0x40a, 1, 40)
						} else {
							send(bar, 0x40a, 0, 0)
						}
					}
					if n >= 0 {
						send(bar, 0x402, uintptr(n), 0)
					}
				}
			}
			select {
			case <-stop:
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
	}()
	<-ready
	return func() { close(stop); <-done }
}
