import hashlib
from io import BytesIO
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx
from pypdf import PdfWriter

from pc_connector import agent,windows
from pc_connector.main import action_for,main

class ConnectorTests(unittest.TestCase):
    def test_renamed_download_installs_and_installed_binary_only_opens(self):
        with patch.object(sys,'frozen',True,create=True),patch.object(sys,'argv',['connector']),\
                patch.object(windows,'install') as install,patch.object(windows,'notice') as notice,\
                patch.object(windows,'start_worker') as start,patch('webbrowser.open') as open_web:
            with patch.object(sys,'executable',str(Path('downloads')/'SWAX-PC-Setup (1).exe')):
                main();install.assert_called_once_with(quiet=False)
                start.assert_not_called();notice.assert_not_called()
            with patch.object(sys,'executable',str(windows.executable())):
                main();start.assert_called_once();open_web.assert_called_once()
                self.assertEqual(install.call_count,1)

    def test_protocol_arguments_cannot_trigger_installer_or_background_flags(self):
        uri='swax-pc://connect?code='+'a'*64
        self.assertEqual(action_for([uri],False),'connect')
        self.assertEqual(action_for(['--background'],False),'background')
        self.assertEqual(action_for(['--install','--quiet'],True),'install')
        for args in ([uri,'--background'],[uri,'--install','--quiet'],['--install']):
            with self.subTest(args=args),self.assertRaises(ValueError):action_for(args,False)

    def test_connection_uri_accepts_only_a_single_scoped_one_use_code(self):
        code='a'*64
        self.assertEqual(agent.connection_code('swax-pc://connect?code='+code),code)
        for uri in ['https://other.example/?code='+code,'swax-pc://other?code='+code,
                    'swax-pc://connect/../../x?code='+code,'swax-pc://connect?code='+code+'&server=https://other.example',
                    'swax-pc://connect?code='+code+'&code='+code,'swax-pc://connect?code=short']:
            with self.subTest(uri=uri),self.assertRaises(ValueError):agent.connection_code(uri)

    def test_credentials_are_protected_and_round_trip_for_current_user(self):
        with TemporaryDirectory() as folder,patch.object(windows,'APP_HOME',Path(folder)):
            value={'device_id':'test','token':'a'*64,'login':'fixture'}
            windows.save_connection(value)
            self.assertNotIn(value['token'].encode(),(Path(folder)/'connection.bin').read_bytes())
            self.assertEqual(windows.load_connection(),value)

    def test_only_one_worker_owns_a_windows_profile(self):
        with TemporaryDirectory() as folder,patch.object(windows,'APP_HOME',Path(folder)):
            first=windows.worker_lock()
            self.assertIsNotNone(first)
            try:self.assertIsNone(windows.worker_lock())
            finally:first.close()
            next_worker=windows.worker_lock();self.assertIsNotNone(next_worker);next_worker.close()

    def test_restart_cleans_only_its_interrupted_work_files(self):
        with TemporaryDirectory() as directory,patch.object(agent,'APP_HOME',Path(directory)):
            home=Path(directory);job=home/'work/document-abcdefgh';job.mkdir(parents=True)
            (job/'input.hwp').write_bytes(b'fictional temporary original')
            personal=home/'work/my-documents';personal.mkdir();(personal/'input.hwp').write_bytes(b'keep')
            guarded=home/('hancom/jobs/'+'a'*32);guarded.mkdir(parents=True);(guarded/'output.pdf').write_bytes(b'temp')
            agent.clear_interrupted_files()
            self.assertFalse(job.exists());self.assertFalse(guarded.exists())
            self.assertEqual((personal/'input.hwp').read_bytes(),b'keep')

    def exercise(self,*,bad_hash=False,bad_pdf=False,fail_upload=False):
        original=b'fictional original hwp'
        task={'kind':'file','id':'test-file','claim_token':'lease','sha256':hashlib.sha256(original).hexdigest(), 'extension':'.hwp'}
        if bad_hash:task['sha256']='0'*64
        calls=[]
        def handler(request):
            calls.append(request)
            if request.url.path.endswith('/input'):return httpx.Response(200,content=original)
            if fail_upload and request.url.path.endswith('/pdf'):return httpx.Response(503)
            return httpx.Response(204)
        def signals(file,renderer):
            pdf=Path(file['_source']).with_suffix('.pdf')
            if bad_pdf:pdf.write_bytes(b'broken')
            else:
                writer=PdfWriter();writer.add_blank_page(width=595,height=842);writer.write(pdf)
            return '?',1,{'apps':[],'consent':[],'mixed':False,'body':'','identity':'','page':1}
        with TemporaryDirectory() as folder:
            home=Path(folder);(home/'work').mkdir()
            with patch.object(agent,'APP_HOME',home),patch('service.documents.read_signals',side_effect=signals),\
                    httpx.Client(base_url='https://service.example',transport=httpx.MockTransport(handler)) as api:
                try:agent.process(api,task)
                except Exception as error:
                    if not (bad_hash or fail_upload):raise
                    self.assertIsInstance(error,ValueError if bad_hash else httpx.HTTPStatusError)
                self.assertEqual(list((home/'work').iterdir()),[])
        return calls

    def test_source_hash_and_pdf_result_are_bound_to_the_claim(self):
        calls=self.exercise()
        metadata=next(call for call in calls if call.url.path.endswith('/metadata'))
        self.assertEqual(json.loads(metadata.content)['kind'],'?')
        output=next(call for call in calls if call.url.path.endswith('/pdf'))
        self.assertEqual(output.headers['X-Claim-Token'],'lease')
        self.assertEqual(output.headers['X-Source-Sha256'],hashlib.sha256(b'fictional original hwp').hexdigest())
        self.assertTrue(output.content.startswith(b'%PDF-'))

    def test_wrong_source_hash_is_not_analysed_or_uploaded(self):
        self.assertEqual(len(self.exercise(bad_hash=True)),1)

    def test_invalid_pdf_is_reported_as_failure_with_no_partial_result(self):
        calls=self.exercise(bad_pdf=True)
        self.assertTrue(any(call.url.path.endswith('/failure') for call in calls))
        self.assertFalse(any(call.url.path.endswith(('/pdf','/metadata')) for call in calls))

    def test_network_upload_error_does_not_mark_a_valid_document_failed(self):
        calls=self.exercise(fail_upload=True)
        self.assertFalse(any(call.url.path.endswith('/failure') for call in calls))

if __name__=='__main__':unittest.main()
