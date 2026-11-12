"""Package public trust material only for one administrator bootstrap."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'var/aws-pc-auth-d1110a'
metadata=json.loads((STATE/'certificate.json').read_text(encoding='utf-8-sig'))
files={name:(STATE/name).read_bytes() for name in ['pc-auth.template.json','certificate.json','root-ca.pem']}
files['Register-PCAuth.ps1']=(Path(__file__).parent/'Register-PCAuth.ps1').read_bytes()
files['README.md']=(Path(__file__).parent/'README.md').read_bytes()
if any(b'-----BEGIN PRIVATE KEY-----' in value or b'-----BEGIN RSA PRIVATE KEY-----' in value or b'-----BEGIN ENCRYPTED PRIVATE KEY-----' in value for value in files.values()):raise ValueError('Private key material is not allowed')
manifest={'account_id':'416775509196','region':'ap-northeast-2','deployment_id':'d1110a','device_id':metadata['device_id'],'public_material_only':True,'files':{name:hashlib.sha256(value).hexdigest() for name,value in files.items()}}
files['manifest.json']=json.dumps(manifest,ensure_ascii=False,indent=2).encode('utf-8')
target=STATE/('pc-auth-bootstrap-'+metadata['device_id']+'.zip')
if target.exists():target.read_bytes()
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED) as package:
    for name,value in files.items():package.writestr(name,value)
result={'path':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,'bucket':'swax-demo-d1110a-artifacts-416775509196','key':'pc-staging/d1110a/pc-auth/'+target.name,'public_material_only':True}
out=STATE/'public-packet.json'
if out.exists():out.read_text(encoding='utf-8')
out.write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result))
