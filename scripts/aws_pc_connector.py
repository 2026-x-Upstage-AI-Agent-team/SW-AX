"""SSM transport for the existing d1110a instance; never resizes or creates AWS resources."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'var/pc-connector-deployment'
AWS=Path(os.environ['LOCALAPPDATA'])/'Programs/Amazon/AWSCLIV2/aws.exe'
INSTANCE='i-0bad7f8ee33fac864'

def aws(*args,timeout=60):
    env={k:v for k,v in os.environ.items() if not k.startswith('AWS_')}
    result=subprocess.run([str(AWS),*map(str,args),'--profile','swax-d1110a','--region','ap-northeast-2','--output','json','--no-cli-pager'],
        env=env,capture_output=True,text=True,encoding='utf-8',timeout=timeout,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:raise RuntimeError('AWS command failed: '+result.stderr[:600])
    return json.loads(result.stdout)

def command(script,name):
    OUT.mkdir(parents=True,exist_ok=True)
    parameters=OUT/(name+'.parameters.json')
    parameters.write_text(json.dumps({'commands':script.splitlines(),'executionTimeout':['600']}),encoding='ascii')
    response=aws('ssm','send-command','--instance-ids',INSTANCE,'--document-name','AWS-RunPowerShellScript',
        '--parameters','file://'+str(parameters),'--comment','SWAX PC connector '+name)
    identity=response['Command']['CommandId']
    (OUT/(name+'.command.json')).write_text(json.dumps({'command_id':identity}),encoding='utf-8')
    print(json.dumps({'command_id':identity,'name':name}),flush=True)
    deadline=time.monotonic()+620
    while time.monotonic()<deadline:
        time.sleep(3)
        result=aws('ssm','get-command-invocation','--command-id',identity,'--instance-id',INSTANCE)
        if result['Status'] not in ('Pending','InProgress','Delayed'):
            (OUT/(name+'.result.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
            print(json.dumps({'status':result['Status'],'output':result['StandardOutputContent'],'error':result['StandardErrorContent']}))
            if result['Status']!='Success':raise RuntimeError('Remote command did not succeed')
            return result
    raise TimeoutError('Remote command remains in progress')

INSPECT=r"""$ErrorActionPreference='Stop'
$cfg=Get-Content -Raw C:\swax\config\deployment.json | ConvertFrom-Json
$release=(Get-Content -Raw C:\swax\config\current-release.txt).Trim()
$tasks=@(Get-ScheduledTask -TaskName 'SWAX-*' | ForEach-Object { [pscustomobject]@{name=$_.TaskName;state=[string]$_.State;execute=$_.Actions[0].Execute;arguments=$_.Actions[0].Arguments} })
[pscustomobject]@{release=$release;jar_sha256=(Get-FileHash C:\swax\current\app\swax-intake.jar -Algorithm SHA256).Hash.ToLowerInvariant();pc_enabled=$cfg.api_environment.AWARDS_PC_ENABLED;worker_managed=$cfg.api_environment.AWARDS_WORKER_MANAGED;tasks=$tasks;config_keys=@($cfg.PSObject.Properties.Name)} | ConvertTo-Json -Depth 5
"""

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--script',type=Path)
    parser.add_argument('--name',default='inspect')
    args=parser.parse_args()
    command(args.script.read_text(encoding='utf-8-sig') if args.script else INSPECT,args.name)
