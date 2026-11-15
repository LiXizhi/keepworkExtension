import unittest
from owned_emulator import renderer_info

class RendererGateTests(unittest.TestCase):
    def test_same_swangle_path_is_rejected_even_with_host_request(self):
        actual=renderer_info('emuglConfig_init: vulkan_mode_selected:swiftshader gles_mode_selected:swangle\nGraphics Adapter ANGLE SwiftShader Device\n')
        self.assertFalse(actual['distinctHostGles'])
    def test_positive_host_gpu_and_incomplete_log(self):
        self.assertIsNone(renderer_info('emuglConfig_init: gles_mode_selected:host\n'))
        actual=renderer_info('emuglConfig_init: vulkan_mode_selected:host gles_mode_selected:host\nGraphics Adapter Apple GPU\nGraphics API Version OpenGL ES 3.1\n')
        self.assertTrue(actual['distinctHostGles'])
        self.assertEqual(len(actual['graphicsApi']),1)

if __name__=='__main__':unittest.main()
