package main

import (
	"context"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func installedPath() (string, error) {
	home, err := os.UserHomeDir()
	return filepath.Join(home, "Applications", "Keepwork.app", "Contents", "MacOS", "Keepwork"), err
}
func alreadyInstalled(source string) bool {
	return sameLocation(source, "/Applications/Keepwork.app/Contents/MacOS/Keepwork")
}
func appBundle(exe string) string { return filepath.Dir(filepath.Dir(filepath.Dir(exe))) }

const setupDialog = `ObjC.import('AppKit');
function run(argv) {
 const app=$.NSApplication.sharedApplication;app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
 const zh=ObjC.unwrap($.NSLocale.preferredLanguages.firstObject).startsWith('zh');
 const alert=$.NSAlert.alloc.init;
 alert.icon=$.NSImage.alloc.initWithContentsOfFile(argv[0]);
 alert.messageText=zh?'安装 Keepwork 桌面版':'Install Keepwork Desktop';
 alert.informativeText=zh?'Keepwork 将安装在个人“应用程序”文件夹。首次启动将下载运行时，并保留已有对话和设置。':'Keepwork will be added to your Applications folder. The first launch downloads the runtime and keeps your existing conversations and settings.';
 alert.addButtonWithTitle(zh?'安装并打开':'Install & Open');alert.addButtonWithTitle(zh?'取消':'Cancel');
 app.activateIgnoringOtherApps(true);return alert.runModal==1000?'install':'cancel';
}`

func installLauncher(source, target string, silent bool) error {
	bundle := appBundle(source)
	dest := appBundle(target)
	if !sameLocation(source, filepath.Join(bundle, "Contents/MacOS/Keepwork")) {
		return fmt.Errorf("open Keepwork.app from the downloaded ZIP")
	}
	if !silent {
		out, err := exec.Command("/usr/bin/osascript", "-l", "JavaScript", "-e", setupDialog, filepath.Join(bundle, "Contents/Resources/Keepwork.icns")).Output()
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(out)) != "install" {
			return context.Canceled
		}
	}
	parent := filepath.Dir(dest)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".keepwork-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	copy := filepath.Join(stage, "Keepwork.app")
	if b, err := exec.Command("/usr/bin/ditto", bundle, copy).CombinedOutput(); err != nil {
		return fmt.Errorf("copy Keepwork: %s: %w", b, err)
	}
	if b, err := exec.Command("/usr/bin/codesign", "--verify", "--strict", "--deep", copy).CombinedOutput(); err != nil {
		return fmt.Errorf("verify Keepwork: %s: %w", b, err)
	}
	if info, err := os.Lstat(dest); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("unexpected existing item at %s", dest)
		}
		id, e := exec.Command("/usr/libexec/PlistBuddy", "-c", "Print CFBundleIdentifier", filepath.Join(dest, "Contents/Info.plist")).Output()
		if e != nil || strings.TrimSpace(string(id)) != "com.keepwork.desktop.launcher" {
			return fmt.Errorf("another application already uses %s", dest)
		}
		// Exchange complete bundles atomically, including when installing over
		// an older launcher. The previous copy is now inside our staging dir.
		if err = unix.RenamexNp(copy, dest, unix.RENAME_SWAP); err != nil {
			return err
		}
	} else if os.IsNotExist(err) {
		if err = unix.RenamexNp(copy, dest, unix.RENAME_EXCL); err != nil {
			return err
		}
	} else {
		return err
	}
	return exec.Command("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", dest).Run()
}

func installationComplete(target string) bool {
	return exec.Command("/usr/bin/codesign", "--verify", "--strict", appBundle(target)).Run() == nil
}

func bringSetupForward() {}
