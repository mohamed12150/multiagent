"""Application factory: routes, security headers, CSRF guard, the SPA, and the network's engines."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import update
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, db, events, security
from .agents.loader import load_all
from .agents.runtime import runtime
from .api import (
    auth,
    campaigns,
    channels,
    content,
    hooks,
    inbox,
    library,
    network,
    reports,
    settings_api,
    system,
    users,
)
from .bodylimit import BodyLimit
from .engine.scheduler import scheduler
from .models import Agent, Post, Task
from .seed import run as seed

log = logging.getLogger("qsm")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; "
       "form-action 'self'; object-src 'none'")
CSRF_EXEMPT = ("/api/hooks/",)
JSON_BODY_LIMIT = 2 * 1024 * 1024
UPLOAD_FILES = 20


def _recover() -> None:
    """Work interrupted by a restart goes back to the queue instead of hanging as 'running'."""
    with db.session() as s:
        s.execute(update(Task).where(Task.status == "running").values(status="queued"))
        s.execute(update(Post).where(Post.status == "publishing").values(status="scheduled"))
        s.execute(update(Agent).where(Agent.status == "working").values(status="idle", current_task_id=None))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    db.init_db()
    load_all()
    with db.session() as s:
        seed(s)
    _recover()
    events.bind_loop(asyncio.get_running_loop())
    cfg = config.get()
    if cfg.scheduler_enabled:
        runtime.start()
        scheduler.start()
    log.info("Qhub Smart Marketing ready on %s:%s (%s)", cfg.host, cfg.port, cfg.env)
    yield
    await scheduler.stop()
    await runtime.stop()


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"ok": False, "data": None, "error": {"code": code, "message": message}}, status_code=status)


def create_app() -> FastAPI:
    cfg = config.get()
    app = FastAPI(title="Qhub Smart Marketing", version="1.0.0", lifespan=lifespan,
                  docs_url=None if cfg.is_production else "/api/docs", redoc_url=None, openapi_url=None
                  if cfg.is_production else "/api/openapi.json")

    @app.middleware("http")
    async def guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        path = request.url.path
        if (request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/")
                and not path.startswith(CSRF_EXEMPT) and request.headers.get(security.CSRF_HEADER) != "1"):
            return _error(403, "csrf", "طلب مرفوض (رأس الحماية مفقود)")
        response: Response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", CSP)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if cfg.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if path.startswith("/api/") and "cache-control" not in response.headers:
            response.headers["Cache-Control"] = "no-store"
        elif path.startswith("/assets/"):
            # Modules revalidate on every load (ETag → 304), so an update is never masked by a stale import graph.
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict):
            return _error(exc.status_code, exc.detail.get("code", "error"), exc.detail.get("message", "خطأ"))
        message = {400: "طلب غير صالح أو أكبر من المسموح", 404: "غير موجود", 405: "الطريقة غير مسموحة"}.get(
            exc.status_code, "تعذر تنفيذ الطلب")
        return _error(exc.status_code, f"http_{exc.status_code}", message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ())[1:])
        return _error(422, "validation", f"قيمة غير صالحة: {where}" if where else "طلب غير صالح")

    @app.exception_handler(Exception)
    async def crash(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return _error(500, "server_error", "حدث خطأ غير متوقع — سجّله الحارس")

    app.add_middleware(BodyLimit, default=JSON_BODY_LIMIT,
                       overrides={"/api/library": cfg.max_upload_mb * 1024 * 1024 * UPLOAD_FILES})

    for module in (auth, network, campaigns, content, library, channels, inbox, reports, system, settings_api, users,
                   hooks):
        app.include_router(module.router)

    web = config.WEB_DIR
    app.mount("/assets", StaticFiles(directory=web / "assets"), name="assets")

    @app.get("/favicon.svg", include_in_schema=False)
    def favicon() -> FileResponse:
        return FileResponse(web / "assets" / "img" / "favicon.svg", media_type="image/svg+xml")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        if path.startswith("api/"):
            return _error(404, "not_found", "غير موجود")
        return FileResponse(web / "index.html", headers={"Cache-Control": "no-cache"})

    return app
