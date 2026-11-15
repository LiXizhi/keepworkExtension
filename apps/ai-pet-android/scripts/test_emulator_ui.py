import tempfile
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
from emulator_ui import fresh_hierarchy, toggle_round_trip

class FreshDumpTests(unittest.TestCase):
    def test_failed_dump_after_success_never_reuses_old_xml(self):
        remote = {}; dumps=[]; reads=[]
        def command(args):
            if args[:3] == ['shell','uiautomator','dump']:
                dumps.append(args[3])
                if len(dumps)==2:return b'ERROR: could not get idle state'
                remote[args[3]]=b'<hierarchy><node text="old success"/></hierarchy>'
                return ('UI hierchary dumped to: '+args[3]).encode()
            reads.append(args[2]);return remote[args[2]]
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)
            fresh_hierarchy(command,target)
            with self.assertRaisesRegex(RuntimeError,'did not confirm'):
                fresh_hierarchy(command,target)
            self.assertNotEqual(dumps[0],dumps[1])
            self.assertEqual(reads,[dumps[0]])
            self.assertEqual(len(list(target.glob('ai-pet-ui-*.xml'))),1)
    def test_success_marker_for_wrong_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(RuntimeError):
                fresh_hierarchy(lambda args:b'UI hierchary dumped to: /sdcard/old.xml',Path(folder))
    def test_round_trip_requires_real_state_change(self):
        state=[True]
        snapshot=lambda:ET.fromstring('<hierarchy><node resource-id="pkg:id/preview_visible" checked="'+str(state[0]).lower()+'"/></hierarchy>')
        with self.assertRaisesRegex(AssertionError,'did not change'):
            toggle_round_trip('preview_visible',lambda name:[0,0,100,100],lambda bounds:None,snapshot)
        result=toggle_round_trip('preview_visible',lambda name:[0,0,100,100],lambda bounds:state.__setitem__(0,not state[0]),snapshot)
        self.assertEqual(result,{'control':'preview_visible','before':True,'afterClick':False,'restored':True})

if __name__=='__main__':unittest.main()
