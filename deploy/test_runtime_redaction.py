import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


WRAPPER = Path(__file__).with_name('runtime.cjs')
CONFIG_PATH = "'/run/secrets/runtime.json'"


class RuntimeRedactionTests(unittest.TestCase):
    def run_child(self, config, script):
        """Run the wrapper against a temporary config; only the config path differs."""
        node = shutil.which('node')
        self.assertIsNotNone(node, 'node is required to test the runtime wrapper')
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        runtime = Path(directory.name) / 'runtime.json'
        runtime.write_text(json.dumps(config))
        source = WRAPPER.read_text()
        self.assertEqual(source.count(CONFIG_PATH), 1)
        wrapper = Path(directory.name) / 'runtime.cjs'
        wrapper.write_text(source.replace(CONFIG_PATH, json.dumps(str(runtime))))
        return subprocess.run(
            [node, str(wrapper), '-e', script],
            capture_output=True, text=True, timeout=30, check=False,
        )

    def test_redacts_the_https_form_of_a_websocket_endpoint(self):
        config = {
            'BASE_RPC': 'wss://rpc.example.test/v2/rpc-key-marker',
            'SHORT': 'short-value',
        }
        result = self.run_child(config, '''
            console.log('ws ' + process.env.BASE_RPC);
            console.error('http https://rpc.example.test/v2/rpc-key-marker failed');
            console.log('kept ' + process.env.SHORT);
        ''')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('rpc-key-marker', result.stdout + result.stderr)
        self.assertEqual(result.stdout, 'ws [REDACTED]\nkept short-value\n')
        self.assertEqual(result.stderr, 'http https://[REDACTED] failed\n')

    def test_redacts_an_endpoint_configured_with_surrounding_whitespace(self):
        config = {'BASE_RPC': ' wss://rpc.example.test/v2/rpc-key-marker\n'}
        result = self.run_child(config, '''
            console.log('trimmed wss://rpc.example.test/v2/rpc-key-marker');
            console.error('http https://rpc.example.test/v2/rpc-key-marker failed');
        ''')
        self.assertEqual(result.returncode, 0)
        self.assertNotIn('rpc-key-marker', result.stdout + result.stderr)
        self.assertEqual(result.stdout, 'trimmed [REDACTED]\n')
        self.assertEqual(result.stderr, 'http https://[REDACTED] failed\n')

    def test_still_redacts_plain_credentials(self):
        config = {'TELEGRAM_BOT_TOKEN': '123456:token-marker-value'}
        result = self.run_child(config, "console.log('t=' + process.env.TELEGRAM_BOT_TOKEN)")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, 't=[REDACTED]\n')


if __name__ == '__main__':
    unittest.main()
