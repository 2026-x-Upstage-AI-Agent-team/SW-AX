# Administrator bootstrap: deploy only the public certificate trust, IAM role and profile in this packet.
[CmdletBinding()]
param([string]$Profile)
$ErrorActionPreference='Stop'
$extra=@();if($Profile){$extra=@('--profile',$Profile)}
$identity=& aws sts get-caller-identity @extra --region ap-northeast-2 --output json --no-cli-pager | ConvertFrom-Json
if($LASTEXITCODE -or $identity.Account -ne '416775509196'){throw 'Use an authorized administrator in AWS account 416775509196.'}
$metadata=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'certificate.json') | ConvertFrom-Json
$stack='swax-demo-d1110a-pc-auth'
$preference=$ErrorActionPreference;$ErrorActionPreference='Continue'
$raw=& aws cloudformation describe-stacks --stack-name $stack @extra --region ap-northeast-2 --output json --no-cli-pager 2>&1
$describeExit=$LASTEXITCODE;$ErrorActionPreference=$preference
if($describeExit -eq 0){
    $existing=($raw|Out-String|ConvertFrom-Json).Stacks[0]
    $tags=@{};foreach($tag in $existing.Tags){$tags[$tag.Key]=$tag.Value}
    if($tags.DeploymentId -ne 'd1110a' -or $tags.Purpose -ne 'pc-worker-auth' -or $tags.DeviceId -ne $metadata.device_id){throw 'Existing stack belongs to another configuration; left unchanged.'}
}elseif(($raw|Out-String) -notmatch 'does not exist'){throw ($raw|Out-String)}
& aws cloudformation deploy --template-file (Join-Path $PSScriptRoot 'pc-auth.template.json') --stack-name $stack --capabilities CAPABILITY_NAMED_IAM --tags DeploymentId=d1110a Purpose=pc-worker-auth ('DeviceId='+$metadata.device_id) --no-fail-on-empty-changeset @extra --region ap-northeast-2 --no-cli-pager
if($LASTEXITCODE){throw 'Bootstrap failed. Review this stack events; existing application stacks were not changed.'}
$output=& aws cloudformation describe-stacks --stack-name $stack --query 'Stacks[0].Outputs' @extra --region ap-northeast-2 --output json --no-cli-pager
if($LASTEXITCODE){throw 'Cannot read registration outputs.'}
$result=Join-Path $PSScriptRoot 'cloud-result.json'
if(Test-Path -LiteralPath $result){Get-Content -Raw -Encoding UTF8 -LiteralPath $result | Out-Null}
$output | Set-Content -Encoding utf8 -LiteralPath $result
Write-Output ('Registration complete. Return this public output file: '+$result)
