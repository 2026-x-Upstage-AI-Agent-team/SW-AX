# Create a deployment-specific certificate in CurrentUser\My; export public certificates only.
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$state=Join-Path $root 'var\aws-pc-auth-d1110a'
New-Item -ItemType Directory -Force $state | Out-Null
$metadata=Join-Path $state 'certificate.json'
if(Test-Path -LiteralPath $metadata){
    $saved=Get-Content -Raw -Encoding UTF8 -LiteralPath $metadata | ConvertFrom-Json
    $leaf=Get-Item ('Cert:\CurrentUser\My\'+$saved.thumbprint) -ErrorAction Stop
    if(-not $leaf.HasPrivateKey -or $leaf.NotAfter -lt (Get-Date).AddDays(1)){throw 'Existing device certificate requires renewal; left unchanged.'}
}else{
    $device=[Guid]::NewGuid().ToString('N').Substring(0,12)
    $issuer='SWAX-d1110a-PC-CA-'+$device
    $subject='swax-d1110a-pc-russe-'+$device
    $now=Get-Date
    $common=@{Type='Custom';CertStoreLocation='Cert:\CurrentUser\My';Provider='Microsoft Software Key Storage Provider';KeyAlgorithm='RSA';KeyLength=2048;KeyExportPolicy='NonExportable';HashAlgorithm='SHA256';KeyProtection='None';NotBefore=$now.AddMinutes(-10)}
    $ca=New-SelfSignedCertificate @common -Subject ('CN='+$issuer) -FriendlyName ('SWAX d1110a private CA '+$device) -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') -NotAfter $now.AddYears(5)
    $leaf=New-SelfSignedCertificate @common -Subject ('CN='+$subject) -Signer $ca -FriendlyName ('SWAX d1110a PC worker '+$device) -KeyUsage DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=0','2.5.29.37={text}1.3.6.1.5.5.7.3.2') -NotAfter $now.AddDays(365)
    foreach($pair in @(@($ca,'root-ca.pem'),@($leaf,'device.pem'))){
        $text="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String($pair[0].RawData,[Base64FormattingOptions]::InsertLineBreaks)+"`n-----END CERTIFICATE-----`n"
        [IO.File]::WriteAllText((Join-Path $state $pair[1]),$text,[Text.UTF8Encoding]::new($false))
    }
    $key=[System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($leaf)
    if($key.Key.ExportPolicy -ne [System.Security.Cryptography.CngExportPolicies]::None){throw 'Expected a non-exportable Windows key.'}
    [ordered]@{deployment_id='d1110a';account_id='416775509196';region='ap-northeast-2';device_id=$device;subject_cn=$subject;issuer_cn=$issuer;thumbprint=$leaf.Thumbprint;serial=$leaf.SerialNumber;not_after=$leaf.NotAfter.ToUniversalTime().ToString('o');ca_thumbprint=$ca.Thumbprint;private_key_exported=$false;certificate_store='CurrentUser\My'} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $metadata
}
$helper=Join-Path $state 'aws_signing_helper.exe'
$expected='fc4c3e65864c1829fcd87ae3718387db03b8ea48b8819f5a6031482ba5d243cd'
if(-not (Test-Path -LiteralPath $helper)){
    Invoke-WebRequest -Uri 'https://rolesanywhere.amazonaws.com/releases/1.8.5/X86_64/Windows/Server2022/aws_signing_helper.exe' -OutFile ($helper+'.download')
    if((Get-FileHash -LiteralPath ($helper+'.download') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'Official helper checksum mismatch; executable not activated.'}
    Move-Item -LiteralPath ($helper+'.download') -Destination $helper
}
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'Existing helper checksum mismatch; left unchanged.'}
$signature=Get-AuthenticodeSignature -LiteralPath $helper
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Amazon'){throw 'Official helper signature verification failed.'}
$selector='Key=x509Serial,Value='+$leaf.SerialNumber
& $helper sign-string --cert-selector $selector --digest SHA256 --format json | Out-Null
if($LASTEXITCODE){throw 'Certificate signing self-check failed.'}
[pscustomobject]@{certificate=$leaf.Subject;not_after=$leaf.NotAfter;private_key_exported=$false;helper_sha256=$expected;helper_signature=$signature.Status.ToString();public_state=$state} | ConvertTo-Json
