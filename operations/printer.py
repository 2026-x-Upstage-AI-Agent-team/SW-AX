"""Windows printer for one leased report version. Configure the URL and secret on the printer PC."""
import argparse
import hashlib
import os
import socket
import ssl
import subprocess
import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

import httpx
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .native import render


def print_one(api, worker, renderer=render):
    response = api.post("claim",json={"worker_id":worker})
    response.raise_for_status()
    if response.status_code == 204:
        return False
    job = response.json()
    endpoint = job["id"]
    headers = {"X-Claim-Token":job["claim_token"], "X-Hwpx-Sha256":job["sha256"]}
    stop = threading.Event()
    def heartbeat():
        while not stop.wait(5):
            try:
                if api.put(endpoint+"/lease",headers=headers).status_code == 409:
                    return
            except httpx.TransportError:
                continue
    thread = threading.Thread(target=heartbeat,daemon=True)
    thread.start()
    try:
        with TemporaryDirectory(prefix="swax-print-") as work:
            source = Path(work)/"report.hwpx"
            source.write_bytes(api.get(endpoint+"/hwpx",headers=headers).raise_for_status().content)
            if hashlib.sha256(source.read_bytes()).hexdigest() != job["sha256"]:
                raise ValueError("출력 원본 해시 불일치")
            pdf = Path(work)/"report.pdf"
            renderer(source,pdf)
            if not len(PdfReader(pdf).pages):
                raise ValueError("빈 출력")
            result = api.put(endpoint+"/pdf",content=pdf.read_bytes(),headers={**headers,"Content-Type":"application/pdf"})
            result.raise_for_status()
    except (OSError,ValueError,subprocess.SubprocessError,PdfReadError):
        api.put(endpoint+"/failure",headers=headers).raise_for_status()
    finally:
        stop.set()
        thread.join(timeout=2)
    return True


def worker_api(url, token):
    parsed = urlsplit(url)
    if not token or parsed.username or parsed.password or parsed.query or parsed.fragment or not (parsed.scheme=="https" or
            (parsed.scheme=="http" and parsed.hostname in ("127.0.0.1","localhost","::1"))):
        raise ValueError("출력 서버 HTTPS 주소와 출력 전용 토큰을 설정하세요.")
    return httpx.Client(base_url=url.rstrip("/")+"/api/worker/output/",timeout=150,
                        headers={"Authorization":"Bearer "+token},trust_env=False,verify=ssl.create_default_context())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once",action="store_true")
    args = parser.parse_args()
    with worker_api(os.getenv("AWARDS_API_URL","http://127.0.0.1:18765"), os.getenv("AWARDS_OUTPUT_WORKER_TOKEN","")) as api:
        while True:
            try:
                busy = print_one(api,socket.gethostname()[:80])
            except httpx.HTTPError as exc:
                if args.once:
                    raise
                print("출력 API 연결·배정 확인",type(exc).__name__,flush=True)
                busy = False
            if args.once:
                return
            if not busy:
                time.sleep(3)


if __name__ == "__main__":
    main()
