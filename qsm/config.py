"""Runtime configuration from the environment.

Personal/company use should "just work" on first run: in development the secret and master keys are generated once
and kept in `<data_dir>/.keys` (mode 0600). In production (`QSM_ENV=production`) both keys must come from the
environment and be distinct, so a copied data folder never carries its own keys.
"""
from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
MIN_SECRET_LEN = 32


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    env: str
    data_dir: Path
    database_url: str
    secret_key: str
    master_key: str
    host: str
    port: int
    public_base_url: str
    scheduler_enabled: bool
    max_upload_mb: int
    setup_token: str = ""

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _dev_keys(data_dir: Path) -> dict[str, str]:
    """Generate (once) and persist the development keys."""
    path = data_dir / ".keys"
    if path.exists():
        return json.loads(path.read_text())
    keys = {"secret_key": secrets.token_urlsafe(48), "master_key": Fernet.generate_key().decode()}
    data_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(keys))
    path.chmod(0o600)
    return keys


def _validate_master(key: str) -> None:
    try:
        Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise ConfigError("QSM_MASTER_KEY must be a Fernet key (32 url-safe base64 bytes)") from exc


def load() -> Config:
    env = os.environ.get("QSM_ENV", "development").strip().lower()
    env = "production" if env in ("production", "prod") else env
    host = os.environ.get("QSM_HOST", "127.0.0.1")
    if env != "production" and host not in ("127.0.0.1", "localhost", "::1"):
        raise ConfigError("development mode listens on 127.0.0.1 only — set QSM_ENV=production to serve a network")
    data_dir = Path(os.environ.get("QSM_DATA_DIR", str(ROOT / "data"))).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    secret_key = os.environ.get("QSM_SECRET_KEY", "")
    master_key = os.environ.get("QSM_MASTER_KEY", "")
    if env == "production":
        if len(secret_key) < MIN_SECRET_LEN or not master_key:
            raise ConfigError("production needs QSM_SECRET_KEY (32+ chars) and QSM_MASTER_KEY")
        if secret_key == master_key:
            raise ConfigError("QSM_SECRET_KEY and QSM_MASTER_KEY must differ")
        if len(os.environ.get("QSM_SETUP_TOKEN", "")) < 16 and not (data_dir / "qsm.db").exists():
            raise ConfigError("first production start needs QSM_SETUP_TOKEN (16+ chars) to protect owner setup")
    else:
        keys = _dev_keys(data_dir)
        secret_key = secret_key or keys["secret_key"]
        master_key = master_key or keys["master_key"]
    _validate_master(master_key)
    port = int(os.environ.get("QSM_PORT", "8820"))
    return Config(
        env=env,
        data_dir=data_dir,
        database_url=os.environ.get("QSM_DATABASE_URL", f"sqlite:///{data_dir / 'qsm.db'}"),
        secret_key=secret_key,
        master_key=master_key,
        host=host,
        port=port,
        public_base_url=os.environ.get("QSM_PUBLIC_BASE_URL", "").rstrip("/"),
        scheduler_enabled=_flag("QSM_SCHEDULER", True),
        max_upload_mb=int(os.environ.get("QSM_MAX_UPLOAD_MB", "200")),
        setup_token=os.environ.get("QSM_SETUP_TOKEN", ""),
    )


@lru_cache(maxsize=1)
def get() -> Config:
    return load()


def reset() -> None:
    """Tests: forget the cached config so a new environment takes effect."""
    get.cache_clear()
