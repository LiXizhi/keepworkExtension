import subprocess
import unittest
from emulator_runtime import wait_for_stage

class Clock:
    value = 0.0
    def now(self): return self.value
    def sleep(self, amount): self.value += amount

class ReadinessTest(unittest.TestCase):
    def test_transient_command_timeout_does_not_abort_remaining_budget(self):
        clock=Clock(); records=[]; attempts=[]
        def probe(timeout):
            attempts.append(timeout)
            if len(attempts)==1:
                clock.sleep(timeout)
                raise subprocess.TimeoutExpired(['adb','shell','getprop'], timeout)
            clock.sleep(.1)
            return True
        wait_for_stage('boot', probe, 12, records, clock.now, clock.sleep)
        self.assertEqual(len(attempts), 2)
        self.assertLess(clock.now(),12)
        self.assertEqual(records[0]['outcome'],'command-timeout')
    def test_repeated_timeouts_never_extend_total_deadline(self):
        clock=Clock(); records=[]; limits=[]
        def probe(timeout):
            limits.append(timeout);clock.sleep(timeout)
            raise subprocess.TimeoutExpired(['adb','shell','getprop'], timeout)
        with self.assertRaisesRegex(TimeoutError,'deadline exhausted'):
            wait_for_stage('boot',probe,7,records,clock.now,clock.sleep)
        self.assertEqual(clock.now(),7)
        self.assertEqual(limits,[5,1])
    def test_non_timeout_errors_are_not_silently_retried(self):
        with self.assertRaisesRegex(RuntimeError,'emulator exited'):
            wait_for_stage('boot',lambda timeout: (_ for _ in ()).throw(RuntimeError('emulator exited')),10,[])

if __name__=='__main__': unittest.main()
