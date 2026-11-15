"""Independent bounds/timeout checks against actual Android runtime helper."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
p=Path(__file__).resolve().parents[2]/'apps/ai-pet-android/scripts/emulator_runtime.py'
spec=importlib.util.spec_from_file_location('runtime',p)
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
ui_spec=importlib.util.spec_from_file_location('runtime_ui',p.with_name('emulator_ui.py'))
ui=importlib.util.module_from_spec(ui_spec);ui_spec.loader.exec_module(ui)
class RuntimeHarnessChecks(unittest.TestCase):
    def test_failed_second_capture_cannot_read_prior_success(self):
        files={}; dumps=[]; reads=[]
        def command(args):
            if args[:3]==['shell','uiautomator','dump']:
                path=args[3];dumps.append(path)
                if len(dumps)==2:
                    # Exit-success output can still report a failed capture.
                    return b'ERROR: null root node'
                files[path]=b'<hierarchy><node text="prior"/></hierarchy>'
                return ('UI hierchary dumped to: '+path).encode()
            reads.append(args[2]);return files[args[2]]
        with tempfile.TemporaryDirectory() as folder:
            ui.fresh_hierarchy(command,Path(folder))
            with self.assertRaises(RuntimeError):ui.fresh_hierarchy(command,Path(folder))
        self.assertEqual(len(set(dumps)),2)
        self.assertEqual(reads,[dumps[0]])

    def test_confirmed_dump_with_failed_read_does_not_fall_back(self):
        reads=[]
        def command(args):
            if args[:3]==['shell','uiautomator','dump']:
                return ('UI hierchary dumped to: '+args[3]).encode()
            reads.append(args[2])
            raise subprocess.CalledProcessError(1,args)
        with tempfile.TemporaryDirectory() as folder:
            evidence=Path(folder)
            (evidence/'latest-ui.xml').write_text('<hierarchy><node text="old"/></hierarchy>')
            with self.assertRaises(subprocess.CalledProcessError):ui.fresh_hierarchy(command,evidence)
        self.assertEqual(len(reads),1)

    def test_changed_but_unrestored_toggle_is_rejected(self):
        state=[True]; clicks=[]
        def click(bounds):
            clicks.append(bounds)
            state[0]=False  # Second click is lost; first change alone must not pass.
        def snapshot():
            return ET.fromstring('<hierarchy><node resource-id="pkg:id/preview_visible" checked="'+str(state[0]).lower()+'"/></hierarchy>')
        with self.assertRaisesRegex(AssertionError,'did not restore'):
            ui.toggle_round_trip('preview_visible',lambda _: [1,2,3,4],click,snapshot)
        self.assertEqual(len(clicks),2)

    def test_visible_bar_frames_override_stale_hidden_frame(self):
        dump='''
  Window #0 Window{a StatusBar}:
    isVisible=true frame=[0,0][720,48]
  Window #1 Window{b NavigationBar0}:
    isVisible=false frame=[0,1208][720,1280]
  Window #2 Window{c NavigationBar0}:
    isVisible=true frame=[0,1180][720,1280]
'''
        self.assertEqual(runtime.safe_vertical_bounds(dump,720,1280),(48,1180))
        with self.assertRaises(RuntimeError): runtime.safe_vertical_bounds(dump.replace('isVisible=true','isVisible=false'),720,1280)
    def test_timeout_then_false_then_ready_retains_budget(self):
        clock=[0.0]; calls=[]; records=[]
        def sleep(t): clock[0]+=t
        def probe(timeout):
            calls.append(timeout)
            if len(calls)==1:
                sleep(timeout);raise subprocess.TimeoutExpired('probe',timeout)
            return len(calls)==3
        runtime.wait_for_stage('package',probe,10,records,lambda:clock[0],sleep)
        self.assertEqual([r['ready'] for r in records],[False,False,True])
        self.assertLess(clock[0],10)
if __name__=='__main__': unittest.main()
