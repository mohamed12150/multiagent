"""Encrypted secret storage (Fernet). Plaintext never leaves the server; the API shows a 4-character hint."""
from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config
from .models import Secret


class VaultError(Exception):
    pass


def _fernet() -> Fernet:
    return Fernet(config.get().master_key.encode())


def hint(value: str) -> str:
    """Last 4 characters only for long tokens; a short password never reveals any of its characters."""
    return ("•••" + value[-4:]) if len(value) >= 20 else "•••"


def put(s: Session, name: str, plaintext: str) -> Secret:
    if not plaintext:
        raise VaultError("empty secret")
    row = s.scalar(select(Secret).where(Secret.name == name))
    token = _fernet().encrypt(plaintext.encode()).decode()
    if row is None:
        row = Secret(name=name, ciphertext=token, hint=hint(plaintext))
        s.add(row)
    else:
        row.ciphertext, row.hint = token, hint(plaintext)
    s.flush()
    return row


def get(s: Session, name: str) -> str | None:
    """Server-side only. Never return this value from an API route."""
    row = s.scalar(select(Secret).where(Secret.name == name))
    if row is None:
        return None
    try:
        return _fernet().decrypt(row.ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise VaultError(f"cannot decrypt {name} — master key mismatch") from exc


def hints(s: Session, prefix: str) -> dict[str, str]:
    """{field: hint} for every secret under `<prefix>.`."""
    rows = s.scalars(select(Secret).where(Secret.name.startswith(prefix + "."))).all()
    return {r.name[len(prefix) + 1:]: r.hint for r in rows}


def delete(s: Session, name: str) -> None:
    row = s.scalar(select(Secret).where(Secret.name == name))
    if row is not None:
        s.delete(row)


def delete_prefix(s: Session, prefix: str) -> None:
    for row in s.scalars(select(Secret).where(Secret.name.startswith(prefix + "."))).all():
        s.delete(row)
