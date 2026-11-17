import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('local_service', Path(__file__).parents[1] / 'local_service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class NotesTests(unittest.TestCase):
    def test_only_installed_local_models_are_available(self):
        with patch.object(service, 'ollama', return_value={'models': [
            {'name': 'local:big', 'size': 20}, {'name': 'remote:cloud', 'size': 1},
            {'name': 'remote:latest', 'size': 2, 'remote_host': 'example.com'},
            {'name': 'local:small', 'size': 5}]}):
            self.assertEqual([m['name'] for m in service.local_models()], ['local:small', 'local:big'])

    def test_fabricated_quotes_are_removed(self):
        result = {'message': {'content': json.dumps({'summary': 'An argument.', 'points': [
            {'kind': 'claim', 'point': 'Access matters.', 'quote': 'People need jobs.'},
            {'kind': 'evidence', 'point': 'An invented statistic.', 'quote': 'Ninety percent agree.'}]})}}
        with patch.object(service, 'ollama', side_effect=[{'models': [{'name': 'local:small'}]}, result]) as api:
            notes = service.summarize({'text': 'People need jobs.', 'model': 'local:small'})
            self.assertEqual(len(notes['points']), 1)
            self.assertEqual(notes['omitted'], 1)
            request = api.call_args.args[1]
            self.assertEqual(request['messages'][0]['role'], 'system')
            self.assertIn('current_transcript', request['messages'][1]['content'])

    def test_remote_or_unknown_model_is_rejected_before_inference(self):
        with patch.object(service, 'ollama', return_value={'models': [{'name': 'local:small'}]}) as api:
            with self.assertRaises(ValueError):
                service.summarize({'text': 'An argument.', 'model': 'paid:cloud'})
            self.assertEqual(api.call_count, 1)

    def test_invalid_or_empty_transcript_is_rejected(self):
        for data in [[], {}, {'text': None}, {'text': ''}, {'text': 'x' * 30001}]:
            with self.subTest(data=str(data)[:30]), self.assertRaises(ValueError):
                service.summarize(data)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = service.ThreadingHTTPServer(('127.0.0.1', 0), service.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_page_and_assets_are_served(self):
        for path in ['/', '/local-ai.js', '/local-ai.css']:
            with urllib.request.urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers['Cross-Origin-Resource-Policy'], 'same-origin')

    def test_other_websites_cannot_call_local_service(self):
        request = urllib.request.Request(self.base + '/api/summarize', data=b'{}', headers={'Origin': 'https://evil.example', 'Content-Type': 'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 403)

    def test_dns_rebinding_host_is_rejected(self):
        request = urllib.request.Request(self.base + '/', headers={'Host': 'evil.example'})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 403)

    def test_form_post_is_rejected(self):
        request = urllib.request.Request(self.base + '/api/summarize', data=b'text=hello')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code, 415)

    def test_files_outside_allowlist_are_not_served(self):
        for path in ['/local_service.py', '/../.git/config']:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(self.base + path)
            self.assertEqual(caught.exception.code, 404)


if __name__ == '__main__':
    unittest.main()
