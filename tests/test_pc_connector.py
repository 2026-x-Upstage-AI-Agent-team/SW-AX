import hashlib
from io import BytesIO
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx
from pypdf import PdfWriter

from pc_connector import agent,windows
from pc_connector.main import action_for,main

class ConnectorTests(unittest.TestCase):
    def test_two_slots_process_different_claims_at_the_same_time(self):
        rendezvous=threading.Barrier(2)
        processed=[]
        active=set();lock=threading.Lock()
        def handler(request):
            slot=json.loads(request.content)['slot']
            return httpx.Response(200,json={'kind':'file','id':str(slot)})
        client=httpx.Client
        def factory(**kwargs):return client(**kwargs,transport=httpx.MockTransport(handler))
        def process(api,task,**kwargs):
            processed.append(task['id']);rendezvous.wait(timeout=5)
        with patch.object(agent.httpx,'Client',side_effect=factory),patch.object(agent,'process',side_effect=process),ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(agent.work_slot,{'token':'fixture'},slot,active,lock,threading.Event()) for slot in (0,1)]
            self.assertTrue(all(f.result(timeout=8) for f in futures))
        self.assertEqual(set(processed),{'0','1'});self.assertEqual(active,set())

    def test_old_servers_cannot_make_both_slots_render_the_same_claim(self):
        entered=threading.Event();release=threading.Event()
        active=set();lock=threading.Lock()
        client=httpx.Client
        def factory(**kwargs):return client(**kwargs,transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'kind':'file','id':'same'})))
        def process(*args,**kwargs):entered.set();self.assertTrue(release.wait(5))
        with patch.object(agent.httpx,'Client',side_effect=factory),patch.object(agent,'process',side_effect=process) as convert,ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(agent.work_slot,{'token':'fixture'},0,active,lock,threading.Event())
            self.assertTrue(entered.wait(3))
            second=pool.submit(agent.work_slot,{'token':'fixture'},1,active,lock,threading.Event())
            try:self.assertFalse(second.result(timeout=3))
            finally:release.set()
            self.assertTrue(first.result(timeout=3));self.assertEqual(convert.call_count,1)

    def test_cancelled_slot_does_not_claim_work_for_the_previous_account(self):
        cancel=threading.Event();cancel.set()
        with patch.object(agent.httpx,'Client') as client:
            self.assertFalse(agent.work_slot({'token':'fixture'},0,set(),threading.Lock(),cancel))
            client.assert_not_called()

    def test_parallel_status_updates_remain_atomic(self):
        with TemporaryDirectory() as folder,patch.object(agent,'APP_HOME',Path(folder)),ThreadPoolExecutor(max_workers=2) as pool:
            def write(slot):
                for _ in range(20):agent.event('connected',slot=slot)
            list(pool.map(write,(0,1)))
            record=json.loads((Path(folder)/'status.json').read_text(encoding='utf-8'))
            self.assertEqual(record['state'],'connected');self.assertIn(record['slot'],(0,1))

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
