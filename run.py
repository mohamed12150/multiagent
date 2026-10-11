"""Start Qhub Smart Marketing:  .venv/bin/python run.py   (then open http://127.0.0.1:8820)"""
from __future__ import annotations

import logging

import uvicorn

from qsm import config

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "httpcore", "httpx2", "httpcore2"):  # request URLs never reach the log
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = config.get()
    uvicorn.run("qsm.app:create_app", factory=True, host=cfg.host, port=cfg.port, proxy_headers=True,
                forwarded_allow_ips="127.0.0.1", log_level="info")
