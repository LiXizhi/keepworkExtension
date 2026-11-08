package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

func lockStore(path string) (func(), error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	for {
		h, err := syscall.CreateFile(p, syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			return func() { syscall.CloseHandle(h) }, nil
		}
		if err != syscall.Errno(32) {
			return nil, &os.PathError{Op: "lock", Path: path, Err: err}
		}
		time.Sleep(200 * time.Millisecond)
	}
}
func showError(message string) {
	body, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("Keepwork Desktop")
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 16)
}

func progressWindow(file string) func() {
	// The script is constant. The status path travels through the environment.
	const script = `Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = "Keepwork Desktop"; $form.Width = 370; $form.Height = 120
$form.StartPosition = "CenterScreen"; $form.ControlBox = $false
$label = New-Object Windows.Forms.Label; $label.Dock = "Fill"; $label.TextAlign = "MiddleCenter"; $form.Controls.Add($label)
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 400
$timer.Add_Tick({ if (![IO.File]::Exists($env:KEEPWORK_PROGRESS_FILE)) { $form.Close(); return }; try { $value = [IO.File]::ReadAllText($env:KEEPWORK_PROGRESS_FILE); if ($value) { $label.Text = $value } } catch {} })
$timer.Start(); [void]$form.ShowDialog()`
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	cmd.Env = append(os.Environ(), "KEEPWORK_PROGRESS_FILE="+file)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if cmd.Start() != nil {
		return func() {}
	}
	return func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
}
