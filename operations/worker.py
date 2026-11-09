"""Run independent preparation, Studio, delivery and report queues on the trusted processing host."""
import argparse
import threading
import time

import httpx

from service import studio
from service.mailing import mail_settings
from .delivery import admin_address, deliver
from .preparation import prepare
from .reports import report_tick
from .store import configuration, connect
from .studio_worker import run_studio

ROLES = ("prepare","studio","mail","report")


def serve(role, cfg, once=False):
    url = cfg.get("AWARDS_API_URL", "http://127.0.0.1:"+cfg.get("AWARDS_PORT","18765"))
    endpoint = httpx.URL(url)
    if endpoint.scheme!="https" and not (endpoint.scheme=="http" and endpoint.host in ("127.0.0.1","localhost","::1")):
        raise ValueError("원격 API에는 HTTPS가 필요합니다.")
    with httpx.Client(base_url=url.rstrip("/")+"/api/worker/",timeout=45,trust_env=False,
                      headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]}) as api, studio.client(cfg) as remote:
        while True:
            try:
                with connect(cfg) as db:
                    owned = db.execute("SELECT pg_try_advisory_lock(175703111,%s) AS locked",(ROLES.index(role),)).fetchone()
                    if owned["locked"]:
                        heartbeat = 0
                        while True:
                            if role in ("studio","mail") and time.monotonic() >= heartbeat:
                                if role == "studio":
                                    cfg = configuration()
                                    remote.headers["Authorization"] = "Bearer " + cfg.get("UPSTAGE_API_KEY", "")
                                mail = mail_settings(cfg) if role == "mail" else {}
                                configured = bool(cfg.get("UPSTAGE_API_KEY") and cfg.get("UPSTAGE_AGENT_ID")) if role=="studio" else bool(mail.get("MAIL_READY"))
                                db.execute("""INSERT INTO workflow_health(role,configured,config,mail_mode,mail_recipient) VALUES(%s,%s,%s,%s,%s)
                                    ON CONFLICT(role) DO UPDATE SET updated_at=now(),configured=excluded.configured,
                                    config=excluded.config,mail_mode=excluded.mail_mode,mail_recipient=excluded.mail_recipient""",
                                           (role,configured,cfg.get("UPSTAGE_CONFIG_ID",studio.CONFIG),mail.get("MAIL_MODE","local"),
                                            admin_address(mail) if role=="mail" else None))
                                heartbeat = time.monotonic()+30
                            if role=="prepare":
                                busy = prepare(db,api)
                            elif role=="studio":
                                busy = run_studio(db,api,remote,cfg)
                            elif role=="mail":
                                busy = deliver(db,cfg)
                            else:
                                busy = report_tick(db,cfg)
                            if once:
                                return
                            if not busy:
                                time.sleep(1)
            except Exception as exc:
                if once:
                    raise
                # External payload, document names and connection strings may contain private data.
                print(f"{role} 처리 재개 대기 · {type(exc).__name__}",flush=True)
            if once:
                return
            time.sleep(3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role",choices=ROLES)
    parser.add_argument("--once",action="store_true")
    args = parser.parse_args()
    cfg = configuration()
    if args.role:
        serve(args.role,cfg,args.once)
        return
    threads = [threading.Thread(target=serve,args=(role,cfg,args.once),daemon=True) for role in ROLES]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads):
        for t in threads:
            t.join(0.5)


if __name__=="__main__":
    main()
