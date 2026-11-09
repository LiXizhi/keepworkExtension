package main

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Exercise the real AppKit dialog and its modal return codes without requiring
// Accessibility permission to send keystrokes to a different process.
func TestMacSetupChoices(t *testing.T) {
	icon, err := filepath.Abs("../assets/keepwork-mac.png")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ index, want string }{{"0", "install"}, {"1", "cancel"}} {
		t.Run(tc.want, func(t *testing.T) {
			// Schedule a button click on the modal run loop, after the alert opens.
			click := "const button=alert.buttons.objectAtIndex(" + tc.index + ");" +
				"if(!alert.icon.valid||!ObjC.unwrap(button.title))throw Error('missing setup icon or button');" +
				"const timer=$.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.4,button,'performClick:',null,false);" +
				"$.NSRunLoop.currentRunLoop.addTimerForMode(timer,$.NSModalPanelRunLoopMode);"
			script := strings.Replace(setupDialog, "return alert.runModal", click+"return alert.runModal", 1)
			out, err := exec.Command("/usr/bin/osascript", "-l", "JavaScript", "-e", script, icon).CombinedOutput()
			if err != nil || strings.TrimSpace(string(out)) != tc.want {
				t.Fatalf("dialog returned %q, %v", out, err)
			}
		})
	}
}
