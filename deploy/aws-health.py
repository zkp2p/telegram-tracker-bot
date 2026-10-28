#!/usr/bin/env python3
"""Emit bounded proxy health metrics using only the EC2 instance role."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

TARGET = json.loads(Path('/etc/peer-telegram-tracker/health-target.json').read_text())
REGION = TARGET['region']
ACCOUNT = TARGET['accountId']
INSTANCE = TARGET['instanceId']
AWS_ENV = {
    'PATH': '/usr/local/bin:/usr/bin:/bin',
    'AWS_REGION': REGION,
    'AWS_CONFIG_FILE': '/dev/null',
    'AWS_SHARED_CREDENTIALS_FILE': '/dev/null',
    'BOTO_CONFIG': '/dev/null',
    'AWS_EC2_METADATA_DISABLED': 'false',
    'AWS_METADATA_SERVICE_TIMEOUT': '2',
    'AWS_METADATA_SERVICE_NUM_ATTEMPTS': '1',
    'AWS_MAX_ATTEMPTS': '2',
    'AWS_PAGER': '',
}


def aws(*args):
    result = subprocess.run(
        ['aws', *args, '--region', REGION, '--output', 'json'],
        env=AWS_ENV, capture_output=True, timeout=45,
    )
    if result.returncode:
        raise RuntimeError('AWS metric operation failed; output suppressed')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def read_expected_image(
    current=Path('/var/lib/peer-rollouts/telegram-tracker-prod/current.json'),
    build=Path('/var/lib/peer-telegram-tracker-migration/build.json'),
):
    try:
        return json.loads(current.read_text())['image']
    except FileNotFoundError:
        return json.loads(build.read_text())["app"]["id"]


def main():
    identity = aws('sts', 'get-caller-identity')
    expected = f"arn:aws:sts::{ACCOUNT}:assumed-role/{TARGET['roleName']}/{INSTANCE}"
    assert identity['Account'] == ACCOUNT and identity['Arn'] == expected
    checks = {}
    for unit in ['peer-telegram-tracker']:
        checks[unit] = subprocess.run(
            ['systemctl', 'is-active', '--quiet', unit], capture_output=True,
        ).returncode == 0
    checks['image'] = False
    try:
        expected_image = read_expected_image()
        result = subprocess.run(
            ['docker', 'inspect', 'peer-telegram-tracker'], capture_output=True,
            timeout=15,
        )
        checks['image'] = result.returncode == 0 and json.loads(result.stdout)[0]['Image'] == expected_image
    except Exception:
        pass
    # Functional dependency checks are separate from first real alert delivery.
    v=json.loads(Path('/etc/peer-telegram-tracker/runtime.json').read_text())
    try:
        with urllib.request.urlopen('https://api.telegram.org/bot'+v['TELEGRAM_BOT_TOKEN']+'/getMe',timeout=10)as r:
            checks['telegramIdentity']=r.status==200 and json.load(r)['result']['id']==8665567460
    except Exception:checks['telegramIdentity']=False
    try:
        req=urllib.request.Request(v['SUPABASE_URL']+'/rest/v1/users?select=chat_id',method='HEAD',headers={'apikey':v['SUPABASE_ANON_KEY'],'Authorization':'Bearer '+v['SUPABASE_ANON_KEY'],'Range':'0-0'})
        with urllib.request.urlopen(req,timeout=10)as r:checks['supabaseRead']=r.status in (200,206)
    except Exception:checks['supabaseRead']=False
    try:
        req=urllib.request.Request(v['BASE_RPC'].replace('wss://','https://',1),data=json.dumps({'jsonrpc':'2.0','id':1,'method':'eth_chainId','params':[]}).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=10)as r:checks['baseRpc']=json.load(r).get('result')=='0x2105'
    except Exception:checks['baseRpc']=False
    disk = shutil.disk_usage('/')
    free_percent = disk.free * 100 / disk.total
    dimensions = [{'Name': 'InstanceId', 'Value': INSTANCE}]
    aws('cloudwatch', 'put-metric-data', '--namespace', 'Peer/TelegramTrackerProd',
        '--metric-data', json.dumps([
            {'MetricName': 'HealthChecksPassed', 'Value': int(all(checks.values())),
             'Unit': 'Count', 'Dimensions': dimensions},
            {'MetricName': 'DiskFreePercent', 'Value': free_percent,
             'Unit': 'Percent', 'Dimensions': dimensions},
        ]))
    print(json.dumps({'checks': checks, 'diskFreePercent': round(free_percent, 2)}))


if __name__ == '__main__':
    main()
