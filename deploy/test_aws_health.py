import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'aws_health', Path(__file__).with_name('aws-health.py')
)
aws_health = importlib.util.module_from_spec(spec)
with patch.object(Path, 'read_text', return_value=json.dumps({
    'region': 'us-east-1',
    'accountId': '123456789012',
    'instanceId': 'i-test',
})):
    spec.loader.exec_module(aws_health)


class ExpectedImageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.current = Path(directory.name) / 'current.json'
        self.build = Path(directory.name) / 'build.json'
        self.build.write_text(json.dumps({'app': {'id': 'sha256:migration'}}))

    def test_prefers_completed_rollout_image(self):
        self.current.write_text(json.dumps({'image': 'sha256:rollout'}))

        self.assertEqual(
            aws_health.read_expected_image(self.current, self.build),
            'sha256:rollout',
        )

    def test_falls_back_to_migration_image_before_first_rollout(self):
        self.assertEqual(
            aws_health.read_expected_image(self.current, self.build),
            'sha256:migration',
        )

    def test_invalid_rollout_metadata_does_not_use_stale_migration_image(self):
        self.current.write_text('invalid json')

        with self.assertRaises(json.JSONDecodeError):
            aws_health.read_expected_image(self.current, self.build)


if __name__ == '__main__':
    unittest.main()
