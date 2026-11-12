"""Stage the immutable reviewed package in the existing account's private artifact bucket."""
import datetime
import hashlib
import json
from pathlib import Path

from aws_pc_connector import aws,OUT,ROOT

def main():
    bundle=OUT/'pc-connector.zip'
    digest=hashlib.sha256(bundle.read_bytes()).hexdigest()
    marker=OUT/'upload.json'
    if marker.exists():
        previous=json.loads(marker.read_text(encoding='utf-8'))
        if previous['sha256']!=digest:raise RuntimeError('Staged package changed; review before making another deployment')
        print(json.dumps(previous));return
    now=datetime.datetime.now(datetime.timezone.utc).astimezone(datetime.timezone(datetime.timedelta(hours=9)))
    identity='pc-'+now.strftime('%Y%m%d-%H%M%S')
    bucket='swax-demo-d1110a-artifacts-416775509196'
    key='pc-staging/d1110a/'+identity+'/pc-connector.zip'
    result=aws('s3api','put-object','--bucket',bucket,'--key',key,'--body',bundle,
               '--server-side-encryption','AES256','--checksum-algorithm','SHA256',timeout=300)
    state={'patch_id':identity,'bucket':bucket,'key':key,'sha256':digest,'version_id':result.get('VersionId')}
    marker.write_text(json.dumps(state,indent=2),encoding='utf-8')
    apply=(ROOT/'deploy/pc-connector/apply.ps1').read_text(encoding='utf-8')
    command='& {\n'+apply+'\n} -BundleKey \''+key+'\' -BundleSha256 \''+digest+'\' -PatchId \''+identity+'\'\n'
    (OUT/'apply-request.ps1').write_text(command,encoding='utf-8')
    print(json.dumps(state))

if __name__=='__main__':main()
