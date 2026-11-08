package main

import (
	"os"
	"os/exec"
	"syscall"
)

func lockStore(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { f.Close() }, nil
}
func showError(message string) {
	_ = exec.Command("/usr/bin/osascript", "-e", "on run argv", "-e", "display alert \"Keepwork Desktop\" message (item 1 of argv) as critical", "-e", "end run", message).Run()
}

func progressWindow(file string) func() {
	const script = `ObjC.import('AppKit');
function run(args) {
 const app=$.NSApplication.sharedApplication;
 app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
 const win=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0,0,350,72),$.NSWindowStyleMaskTitled,$.NSBackingStoreBuffered,false);
 win.title='Keepwork Desktop';
 const label=$.NSTextField.labelWithString('Preparing first launch…');label.frame=$.NSMakeRect(20,22,315,28);
 win.contentView.addSubview(label);win.center;win.orderFrontRegardless;
 while($.NSFileManager.defaultManager.fileExistsAtPath(args[0])){
 const value=$.NSString.stringWithContentsOfFileEncodingError(args[0],$.NSUTF8StringEncoding,null);
 if(value && value.length) label.stringValue=value;
 $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.35));
 }
}`
	cmd := exec.Command("/usr/bin/osascript", "-l", "JavaScript", "-e", script, file)
	if cmd.Start() != nil {
		return func() {}
	}
	return func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
}
