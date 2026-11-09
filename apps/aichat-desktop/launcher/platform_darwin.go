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
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if err == syscall.EWOULDBLOCK {
			return nil, errBusy
		}
		return nil, err
	}
	return func() { f.Close() }, nil
}
func focusProgress() {}
func showError(message string) {
	_ = exec.Command("/usr/bin/osascript", "-e", "on run argv", "-e", "display alert \"Keepwork Desktop\" message (item 1 of argv) as critical", "-e", "end run", message).Run()
}

func progressWindow(file string, _ func()) func() {
	const script = `ObjC.import('AppKit');
function run(args) {
 const app=$.NSApplication.sharedApplication;
 app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
 const win=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0,0,370,108),$.NSWindowStyleMaskTitled,$.NSBackingStoreBuffered,false);
 win.title='Keepwork Desktop';
 const label=$.NSTextField.labelWithString('Preparing first launch…');label.frame=$.NSMakeRect(20,55,330,28);
 const bar=$.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(20,20,330,18));bar.indeterminate=true;bar.startAnimation(null);win.contentView.addSubview(bar);
 win.contentView.addSubview(label);win.center;win.orderFrontRegardless;
 while($.NSFileManager.defaultManager.fileExistsAtPath(args[0])){
 const value=$.NSString.stringWithContentsOfFileEncodingError(args[0],$.NSUTF8StringEncoding,null);
 if(value && value.length){const parts=ObjC.unwrap(value).split('\n');if(parts.length>1){const n=Number(parts[0]);label.stringValue=parts[1];bar.indeterminate=n<0;if(n<0)bar.startAnimation(null);else bar.doubleValue=n;}}
 $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.35));
 }
}`
	cmd := exec.Command("/usr/bin/osascript", "-l", "JavaScript", "-e", script, file)
	if cmd.Start() != nil {
		return func() {}
	}
	return func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
}
