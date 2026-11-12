"""Prepare/deploy only a dedicated IAM role and Roles Anywhere trust/profile. No compute resources."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'var/aws-pc-auth-d1110a'
STACK='swax-demo-d1110a-pc-auth'
ACCOUNT='416775509196'
REGION='ap-northeast-2'
ROLE='swax-d1110a-pc-russe'

def build_template(metadata,pem,secrets):
    if 'PRIVATE KEY' in pem or not pem.startswith('-----BEGIN CERTIFICATE-----'):
        raise ValueError('Only the public CA certificate may be sent to AWS')
    tags=[{'Key':'DeploymentId','Value':'d1110a'},{'Key':'Purpose','Value':'pc-worker-auth'},{'Key':'DeviceId','Value':metadata['device_id']}]
    policy={'Version':'2012-10-17','Statement':[
        {'Sid':'TunnelOnly','Effect':'Allow','Action':'ssm:StartSession','Resource':[
            f'arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-0bad7f8ee33fac864',
            f'arn:aws:ssm:{REGION}::document/AWS-StartPortForwardingSessionToRemoteHost'],
         'Condition':{'BoolIfExists':{'ssm:SessionDocumentAccessCheck':'true'}}},
        {'Sid':'WorkerSecretsOnly','Effect':'Allow','Action':'secretsmanager:GetSecretValue','Resource':secrets}
    ]}
    trust={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':'rolesanywhere.amazonaws.com'},'Action':['sts:AssumeRole','sts:TagSession','sts:SetSourceIdentity'],
        'Condition':{'ArnEquals':{'aws:SourceArn':{'Fn::GetAtt':['TrustAnchor','TrustAnchorArn']}},
                     'StringEquals':{'aws:SourceAccount':ACCOUNT,'aws:PrincipalTag/x509Subject/CN':metadata['subject_cn'],'aws:PrincipalTag/x509Issuer/CN':metadata['issuer_cn']}}}]}
    return {'AWSTemplateFormatVersion':'2010-09-09','Description':'SWAX d1110a PC certificate authentication; no EC2/RDS/network/Private CA resources.',
        'Resources':{
            'TrustAnchor':{'Type':'AWS::RolesAnywhere::TrustAnchor','Properties':{'Name':ROLE,'Enabled':True,'Source':{'SourceType':'CERTIFICATE_BUNDLE','SourceData':{'X509CertificateData':pem}},'Tags':tags}},
            'WorkerRole':{'Type':'AWS::IAM::Role','Properties':{'RoleName':ROLE,'Description':'PC prepare/printer tunnel and three worker secrets only','MaxSessionDuration':3600,'AssumeRolePolicyDocument':trust,'Policies':[{'PolicyName':'TunnelAndWorkerSecretsOnly','PolicyDocument':policy}],'Tags':tags}},
            'WorkerProfile':{'Type':'AWS::RolesAnywhere::Profile','Properties':{'Name':ROLE,'Enabled':True,'DurationSeconds':3600,'RoleArns':[{'Fn::GetAtt':['WorkerRole','Arn']}],'Tags':tags}}
        },'Outputs':{'TrustAnchorArn':{'Value':{'Fn::GetAtt':['TrustAnchor','TrustAnchorArn']}},'ProfileArn':{'Value':{'Fn::GetAtt':['WorkerProfile','ProfileArn']}},'RoleArn':{'Value':{'Fn::GetAtt':['WorkerRole','Arn']}}}}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute',action='store_true')
    parser.add_argument('--profile',default='swax-d1110a')
    args=parser.parse_args()
    metadata=json.loads((STATE/'certificate.json').read_text(encoding='utf-8-sig'))
    handoff=json.loads((ROOT/'var/aws-integration-d1110a/handoff-verified/deployment-result.json').read_text(encoding='utf-8-sig'))
    keys=['local_worker_db_password','review_worker_token','output_worker_token']
    secrets=[handoff['secrets'][key]['reference'] for key in keys]
    if metadata['account_id']!=ACCOUNT or any(not ref.startswith(f'arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:swax-demo/d1110a/') for ref in secrets):raise ValueError('Unexpected deployment account or secret scope')
    template=build_template(metadata,(STATE/'root-ca.pem').read_text(encoding='utf-8-sig'),secrets)
    path=STATE/'pc-auth.template.json'
    if path.exists():path.read_text(encoding='utf-8')
    path.write_text(json.dumps(template,ensure_ascii=False,indent=2),encoding='utf-8')
    if not args.execute:
        print(json.dumps({'mode':'prepared','template':str(path),'stack':STACK,'role':ROLE,'secrets_count':3,'new_compute_resources':0,'paid_private_ca':False,'private_key_in_template':False}))
        return
    aws=Path(os.environ['LOCALAPPDATA'])/'Programs/Amazon/AWSCLIV2/aws.exe'
    def invoke(command,timeout=60):
        result=subprocess.run([str(aws),*command,'--profile',args.profile,'--region',REGION,'--no-cli-pager'],capture_output=True,text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW,timeout=timeout)
        if result.returncode:
            # These operations contain only public certificates/policies, never secret values.
            raise RuntimeError(result.stderr.strip() or result.stdout.strip())
        return result.stdout
    identity=json.loads(invoke(['sts','get-caller-identity','--output','json']))
    if identity['Account']!=ACCOUNT:raise ValueError('Wrong AWS account; no changes made')
    try:
        existing=json.loads(invoke(['cloudformation','describe-stacks','--stack-name',STACK,'--output','json']))['Stacks'][0]
    except RuntimeError as exc:
        if 'does not exist' not in str(exc):raise
    else:
        tags={tag['Key']:tag['Value'] for tag in existing.get('Tags',[])}
        if tags.get('DeploymentId')!='d1110a' or tags.get('Purpose')!='pc-worker-auth' or tags.get('DeviceId')!=metadata['device_id']:
            raise ValueError('Existing stack belongs to a different configuration; left unchanged')
    invoke(['cloudformation','deploy','--template-file',str(path),'--stack-name',STACK,'--capabilities','CAPABILITY_NAMED_IAM','--tags','DeploymentId=d1110a','Purpose=pc-worker-auth','DeviceId='+metadata['device_id'],'--no-fail-on-empty-changeset'],timeout=600)
    outputs=json.loads(invoke(['cloudformation','describe-stacks','--stack-name',STACK,'--query','Stacks[0].Outputs','--output','json']))
    result={item['OutputKey']:item['OutputValue'] for item in outputs}
    result.update(account_id=ACCOUNT,region=REGION,stack=STACK,certificate_thumbprint=metadata['thumbprint'])
    target=STATE/'cloud-result.json'
    if target.exists():target.read_text(encoding='utf-8')
    target.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        raise SystemExit(1)
