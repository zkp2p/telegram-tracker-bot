import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
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


class RuntimeHealthTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.runtime = Path(directory.name) / 'attempt-runtime.json'
        self.config = {
            'TELEGRAM_BOT_TOKEN': 'test-bound-token',
            'SUPABASE_URL': 'https://supabase.example.test',
            'SUPABASE_ANON_KEY': 'test-bound-anon-key',
            'BASE_RPC': 'wss://rpc.example.test/test-bound-rpc-key',
        }
        self.runtime.write_text(json.dumps(self.config))
        self.mount = {
            'Type': 'bind', 'Source': str(self.runtime),
            'Destination': '/run/secrets/runtime.json', 'RW': False,
        }

    def run_health(self, *, running=True, mounts=None, inspect_error=None, inspect_returncode=0):
        def run(command, **kwargs):
            if command[:2] == ['systemctl', 'is-active']:
                return subprocess.CompletedProcess(command, 0)
            self.assertEqual(command[:3], ['docker', 'inspect', 'peer-telegram-tracker'])
            if '--format' not in command:
                return subprocess.CompletedProcess(command, 0, json.dumps([{'Image': 'sha256:test'}]))
            self.assertTrue(kwargs['capture_output'])
            self.assertGreater(kwargs['timeout'], 0)
            if inspect_error:
                raise inspect_error
            return subprocess.CompletedProcess(command, inspect_returncode, json.dumps({
                'running': running, 'mounts': [self.mount] if mounts is None else mounts,
            }))

        def response(body):
            result = io.BytesIO(json.dumps(body).encode())
            result.status = 200
            return result

        with patch.dict(aws_health.TARGET, {'roleName': 'test-role'}), \
                patch.object(aws_health, 'read_expected_image', return_value='sha256:test'), \
                patch.object(aws_health.subprocess, 'run', side_effect=run) as docker, \
                patch.object(aws_health, 'aws', side_effect=[{
                    'Account': aws_health.ACCOUNT,
                    'Arn': f'arn:aws:sts::{aws_health.ACCOUNT}:assumed-role/test-role/{aws_health.INSTANCE}',
                }, {}]) as aws, \
                patch.object(aws_health.urllib.request, 'urlopen', side_effect=[
                    response({'result': {'id': 8665567460}}), response({}),
                    response({'result': '0x2105'}),
                ]) as urlopen, \
                patch.object(aws_health.shutil, 'disk_usage', return_value=SimpleNamespace(free=50, total=100)), \
                patch('sys.stdout', new_callable=io.StringIO) as stdout, \
                patch('sys.stderr', new_callable=io.StringIO) as stderr:
            aws_health.main()

        output = stdout.getvalue()
        for value in self.config.values():
            self.assertNotIn(value, output + stderr.getvalue())
        self.assertEqual(stderr.getvalue(), '')
        checks = json.loads(output)['checks']
        metric_args = aws.call_args.args
        self.assertEqual(metric_args[:2], ('cloudwatch', 'put-metric-data'))
        metrics = json.loads(metric_args[metric_args.index('--metric-data') + 1])
        self.assertEqual(metrics[0]['Value'], int(all(checks.values())))
        self.assertEqual(metrics[1]['Value'], 50)
        self.assertTrue(any('--format' in call.args[0] for call in docker.call_args_list))
        return checks, urlopen

    def assert_credentials_unavailable(self, **kwargs):
        checks, urlopen = self.run_health(**kwargs)
        for name in ('telegramIdentity', 'supabaseRead', 'baseRpc'):
            self.assertIs(checks[name], False)
        urlopen.assert_not_called()

    def test_uses_runtime_bound_to_running_container(self):
        unrelated = dict(self.mount, Destination='/run/secrets/other.json', Source='/missing')
        checks, urlopen = self.run_health(mounts=[unrelated, self.mount])

        self.assertTrue(all(checks.values()))
        self.assertIn(self.config['TELEGRAM_BOT_TOKEN'], urlopen.call_args_list[0].args[0])
        self.assertEqual(urlopen.call_args_list[1].args[0].get_header('Apikey'), self.config['SUPABASE_ANON_KEY'])
        self.assertEqual(urlopen.call_args_list[2].args[0].full_url, self.config['BASE_RPC'].replace('wss://', 'https://'))

    def test_missing_runtime_mount_emits_failed_credential_checks(self):
        for mounts in ([], [dict(self.mount, Destination='/other')]):
            with self.subTest(mounts=mounts), patch.object(Path, 'read_text') as read:
                self.assert_credentials_unavailable(mounts=mounts)
            read.assert_not_called()

    def test_failed_docker_inspect_does_not_read_credentials(self):
        with patch.object(Path, 'read_text') as read:
            self.assert_credentials_unavailable(inspect_returncode=1)
        read.assert_not_called()

    def test_stopped_container_does_not_read_credentials(self):
        with patch.object(Path, 'read_text') as read:
            self.assert_credentials_unavailable(running=False)
        read.assert_not_called()

    def test_unreadable_runtime_emits_failed_credential_checks(self):
        with patch.object(Path, 'read_text', side_effect=PermissionError('test-bound-token')):
            self.assert_credentials_unavailable()

    def test_missing_runtime_file_emits_failed_credential_checks(self):
        self.runtime.unlink()
        self.assert_credentials_unavailable()

    def test_invalid_runtime_json_emits_failed_credential_checks(self):
        self.runtime.write_text('invalid json test-bound-token')
        self.assert_credentials_unavailable()

    def test_docker_inspect_failure_emits_failed_credential_checks(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired('docker', 15)):
            with self.subTest(error=type(error).__name__):
                self.assert_credentials_unavailable(inspect_error=error)


if __name__ == '__main__':
    unittest.main()
