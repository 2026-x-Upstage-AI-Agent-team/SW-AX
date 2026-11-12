import importlib.util
from pathlib import Path
import sys
import tempfile
import json
import unittest

sys.path.insert(0,str(Path(__file__).parent))
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'var/aws-integration-d1110a'))
from provision import build_template
from configure_pc import normalize_outputs,isolated_environment,ACCOUNT,REGION

class DeviceAuthTests(unittest.TestCase):
    def setUp(self):
        self.metadata={'device_id':'test-device','subject_cn':'only-this-device','issuer_cn':'only-this-issuer'}
        self.secrets=[f'arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:swax-demo/d1110a/{name}-abcdef' for name in ['db-worker','review-worker-token','output-worker-token']]
        self.template=build_template(self.metadata,'-----BEGIN CERTIFICATE-----\npublic-only\n-----END CERTIFICATE-----',self.secrets)

    def test_only_identity_resources_are_created(self):
        self.assertEqual({v['Type'] for v in self.template['Resources'].values()},{'AWS::RolesAnywhere::TrustAnchor','AWS::IAM::Role','AWS::RolesAnywhere::Profile'})

    def test_role_has_no_human_admin_or_shell_permissions(self):
        policy=self.template['Resources']['WorkerRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
        self.assertEqual({v['Action'] for v in policy},{'ssm:StartSession','secretsmanager:GetSecretValue'})
        self.assertEqual(policy[1]['Resource'],self.secrets)
        self.assertTrue(all(resource!='*' for s in policy for resource in s['Resource']))

    def test_certificate_and_anchor_are_pinned(self):
        condition=self.template['Resources']['WorkerRole']['Properties']['AssumeRolePolicyDocument']['Statement'][0]['Condition']
        self.assertEqual(condition['StringEquals']['aws:PrincipalTag/x509Subject/CN'],'only-this-device')
        self.assertEqual(condition['StringEquals']['aws:PrincipalTag/x509Issuer/CN'],'only-this-issuer')
        self.assertEqual(condition['ArnEquals']['aws:SourceArn'],{'Fn::GetAtt':['TrustAnchor','TrustAnchorArn']})

    def test_private_key_is_rejected(self):
        with self.assertRaises(ValueError):build_template(self.metadata,'-----BEGIN PRIVATE KEY-----',self.secrets)

    def test_wrong_aws_account_is_rejected(self):
        with self.assertRaises(ValueError):normalize_outputs({'RoleArn':'arn:aws:iam::000000000000:role/swax-d1110a-pc-russe'})

    def test_public_cloudformation_outputs_are_accepted(self):
        values={'RoleArn':f'arn:aws:iam::{ACCOUNT}:role/swax-d1110a-pc-russe','TrustAnchorArn':f'arn:aws:rolesanywhere:{REGION}:{ACCOUNT}:trust-anchor/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','ProfileArn':f'arn:aws:rolesanywhere:{REGION}:{ACCOUNT}:profile/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        self.assertEqual(normalize_outputs([{'OutputKey':k,'OutputValue':v} for k,v in values.items()]),values)

    def test_human_credentials_are_not_inherited(self):
        from unittest.mock import patch
        with patch.dict('os.environ',{'AWS_ACCESS_KEY_ID':'dummy','AWS_SECRET_ACCESS_KEY':'dummy','AWS_PROFILE':'human'}):
            env=isolated_environment(Path('device-profile'))
        self.assertNotIn('AWS_ACCESS_KEY_ID',env)
        self.assertNotIn('AWS_SECRET_ACCESS_KEY',env)
        self.assertNotIn('AWS_PROFILE',env)
        self.assertEqual(env['AWS_CONFIG_FILE'],'device-profile')

    def test_runtime_waits_for_verified_activation(self):
        import native_runtime as runtime
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DEVICE_STATE',Path(tmp)):
            self.assertEqual(runtime.aws_settings()[0],'swax-d1110a')

    def test_runtime_uses_only_device_credentials_after_activation(self):
        import native_runtime as runtime
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DEVICE_STATE',Path(tmp)),patch.dict('os.environ',{'AWS_PROFILE':'human','AWS_ACCESS_KEY_ID':'dummy'}):
            config=Path(tmp)/'worker.awsconfig';config.write_text('test profile',encoding='utf-8')
            (Path(tmp)/'ready.json').write_text(json.dumps({'profile':'swax-pc-worker-d1110a','role_arn':f'arn:aws:iam::{ACCOUNT}:role/swax-d1110a-pc-russe','config_file':str(config)}),encoding='utf-8')
            profile,env=runtime.aws_settings()
            self.assertEqual(profile,'swax-pc-worker-d1110a')
            self.assertNotIn('AWS_ACCESS_KEY_ID',env)
            self.assertNotIn('AWS_PROFILE',env)

    def test_invalid_device_does_not_fall_back_to_human(self):
        import native_runtime as runtime
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DEVICE_STATE',Path(tmp)):
            (Path(tmp)/'ready.json').write_text(json.dumps({'profile':'human','role_arn':'wrong'}),encoding='utf-8')
            with self.assertRaises(RuntimeError):runtime.aws_settings()

if __name__=='__main__':unittest.main()
