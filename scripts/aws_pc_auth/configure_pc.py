"""Validate the certificate role without human credentials, then activate the PC-only profile."""
import argparse
import datetime
import json
import locale
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'var/aws-pc-auth-d1110a'
ACCOUNT='416775509196'
REGION='ap-northeast-2'
PROFILE='swax-pc-worker-d1110a'
ROLE='swax-d1110a-pc-russe'

def normalize_outputs(value):
    if isinstance(value,list):value={x['OutputKey']:x['OutputValue'] for x in value}
    expected={'RoleArn':f'arn:aws:iam::{ACCOUNT}:role/{ROLE}'}
    if value.get('RoleArn')!=expected['RoleArn']:raise ValueError('Wrong account or role; no activation')
    for key,kind in [('TrustAnchorArn','trust-anchor'),('ProfileArn','profile')]:
        if not re.fullmatch(f'arn:aws:rolesanywhere:{REGION}:{ACCOUNT}:{kind}/[0-9a-f-]+',value.get(key,'')):
            raise ValueError('Unexpected Roles Anywhere ARN; no activation')
    return {key:value[key] for key in ['RoleArn','TrustAnchorArn','ProfileArn']}

def isolated_environment(config):
    result={k:v for k,v in os.environ.items() if not k.startswith('AWS_')}
    result.update(AWS_CONFIG_FILE=str(config),AWS_SHARED_CREDENTIALS_FILE=str(STATE/'empty-credentials'),AWS_LOGIN_CACHE_DIRECTORY=str(STATE/'no-human-login-cache'),AWS_EC2_METADATA_DISABLED='true')
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cloud-result',type=Path,default=STATE/'cloud-result.json')
    args=parser.parse_args()
    metadata=json.loads((STATE/'certificate.json').read_text(encoding='utf-8-sig'))
    cloud=normalize_outputs(json.loads(args.cloud_result.read_text(encoding='utf-8-sig')))
    if datetime.datetime.fromisoformat(metadata['not_after'].replace('Z','+00:00')) < datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1):raise ValueError('Device certificate expired or near expiry')
    config=STATE/'worker.awsconfig'
    helper=STATE/'aws_signing_helper.exe'
    command='"'+str(helper)+'" credential-process --cert-selector Key=x509Serial,Value='+metadata['serial']+' --trust-anchor-arn '+cloud['TrustAnchorArn']+' --profile-arn '+cloud['ProfileArn']+' --role-arn '+cloud['RoleArn']+' --session-duration 3600'
    content=f'[profile {PROFILE}]\nregion = {REGION}\ncredential_process = {command}\n'
    # The embedded CLI reads this config with the Windows locale, even with PYTHONUTF8 set.
    encoded=content.encode(locale.getencoding())
    previous=config.read_bytes() if config.exists() else None
    compatible=(encoded,content.encode('utf-8'),content.replace('\n','\r\n').encode(locale.getencoding()),content.replace('\n','\r\n').encode('utf-8'))
    if previous is not None and previous not in compatible:raise ValueError('A different device profile already exists; left unchanged')
    if previous!=encoded:config.write_bytes(encoded)
    empty=STATE/'empty-credentials'
    if empty.exists() and empty.read_bytes():raise ValueError('Expected an empty credentials file')
    if not empty.exists():empty.write_bytes(b'')
    env=isolated_environment(config)
    aws=Path(os.environ['LOCALAPPDATA'])/'Programs/Amazon/AWSCLIV2/aws.exe'
    def invoke(command):
        result=subprocess.run([str(aws),*command,'--profile',PROFILE,'--region',REGION,'--output','json','--no-cli-pager'],env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW,timeout=60)
        if result.returncode:raise RuntimeError('Device-certificate AWS call failed; credential values were not printed')
        return json.loads(result.stdout)
    credentials=invoke(['configure','export-credentials','--format','process'])
    expiration=credentials['Expiration'];del credentials
    identity=invoke(['sts','get-caller-identity'])
    if identity['Account']!=ACCOUNT or not identity['Arn'].startswith(f'arn:aws:sts::{ACCOUNT}:assumed-role/{ROLE}/'):
        raise ValueError('Human or unexpected identity used; no activation')
    handoff=json.loads((ROOT/'var/aws-integration-d1110a/handoff-verified/deployment-result.json').read_text(encoding='utf-8-sig'))
    for name in ['local_worker_db_password','review_worker_token','output_worker_token']:
        secret=invoke(['secretsmanager','get-secret-value','--secret-id',handoff['secrets'][name]['reference']])
        if not isinstance(secret.get('SecretString'),str):raise ValueError('Worker secret unavailable')
        del secret
    ready={'profile':PROFILE,'config_file':str(config),'config_encoding':locale.getencoding(),'certificate_thumbprint':metadata['thumbprint'],'certificate_not_after':metadata['not_after'],'role_arn':cloud['RoleArn'],'identity_arn':identity['Arn'],'credential_expiration':expiration,'human_login_cache_used':False,'worker_secrets_verified':3}
    target=STATE/'ready.json'
    if target.exists() and json.loads(target.read_text(encoding='utf-8'))['role_arn']!=cloud['RoleArn']:raise ValueError('Different activation already exists')
    if target.exists():target.read_text(encoding='utf-8')
    temp=target.with_suffix('.tmp');temp.write_text(json.dumps(ready,indent=2),encoding='utf-8');temp.replace(target)
    print(json.dumps(ready))

if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        raise SystemExit(1)
