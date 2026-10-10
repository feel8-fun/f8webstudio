"""Studio API: errors."""
from __future__ import annotations

from f8studio_server.errors import InvalidRequestError, NotFoundError
import logging
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from f8media_protocol.client import MediaGatewayRequestError, MediaGatewayUnavailable
from f8studio_core.graph import GraphValidationError, IdempotencyConflictError, OperationTargetError, RevisionConflictError
from ..application import StudioApplication
from ..errors import ConflictError, ServiceUnavailableError, api_error
from f8pysdk.f8_naming import TokenValidationError
from f8media_protocol.models import MediaInputError
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from ..http_support import json_value

logger = logging.getLogger(__name__)

def install_errors_routes(app: FastAPI, studio: StudioApplication) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        response = api_error(exc.status_code, f"http_{exc.status_code}", str(exc.detail), detail=json_value(exc.detail))
        if exc.headers:
            response.headers.update(exc.headers)
        return response


    @app.exception_handler(RequestValidationError)
    async def request_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return api_error(422, "invalid_request", str(exc), detail=json_value(exc.errors()))


    @app.exception_handler(GraphValidationError)
    async def graph_validation_error(_request: Request, exc: GraphValidationError) -> JSONResponse:
        return api_error(422, exc.code, str(exc), detail={"code": exc.code, "message": str(exc)})


    @app.exception_handler(RevisionConflictError)
    async def revision_conflict(_request: Request, exc: RevisionConflictError) -> JSONResponse:
        return api_error(409, exc.code, str(exc), detail={"code": exc.code, "message": str(exc)})


    @app.exception_handler(IdempotencyConflictError)
    async def idempotency_conflict(_request: Request, exc: IdempotencyConflictError) -> JSONResponse:
        return api_error(409, exc.code, str(exc), detail={"code": exc.code, "message": str(exc)})


    @app.exception_handler(OperationTargetError)
    async def operation_target_error(_request: Request, exc: OperationTargetError) -> JSONResponse:
        return api_error(422, exc.code, str(exc), detail={"code": exc.code, "message": str(exc)})


    @app.exception_handler(NotFoundError)
    async def not_found(_request: Request, exc: NotFoundError) -> JSONResponse:
        return api_error(404, "not_found", str(exc))


    @app.exception_handler(FileExistsError)
    async def already_exists(_request: Request, exc: FileExistsError) -> JSONResponse:
        return api_error(409, "already_exists", str(exc))


    @app.exception_handler(TokenValidationError)
    @app.exception_handler(MediaInputError)
    @app.exception_handler(InvalidRequestError)
    async def invalid_value(_request: Request, exc: InvalidRequestError) -> JSONResponse:
        return api_error(422, "invalid_request", str(exc))


    @app.exception_handler(ConflictError)
    async def lifecycle_conflict(_request: Request, exc: ConflictError) -> JSONResponse:
        return api_error(409, "conflict", str(exc))


    @app.exception_handler(ServiceUnavailableError)
    async def service_unavailable(_request: Request, exc: ServiceUnavailableError) -> JSONResponse:
        return api_error(503, "service_unavailable", str(exc))


    @app.exception_handler(MediaGatewayRequestError)
    async def media_gateway_request_error(_request: Request, exc: MediaGatewayRequestError) -> JSONResponse:
        await studio.events.publish(
            event_type="media.error",
            scope="server",
            payload={"operation": "Media gateway", "message": str(exc.detail)},
        )
        return api_error(exc.status_code, "media_error", str(exc.detail), detail=json_value(exc.detail))


    @app.exception_handler(MediaGatewayUnavailable)
    async def media_gateway_unavailable(_request: Request, exc: MediaGatewayUnavailable) -> JSONResponse:
        await studio.events.publish(
            event_type="media.error",
            scope="server",
            payload={"operation": "Media gateway", "message": str(exc)},
        )
        return api_error(503, "media_unavailable", str(exc))


    @app.exception_handler(Exception)
    async def unhandled_error(_request: Request, exc: Exception) -> JSONResponse:
        logger.exception("unhandled Web Studio API error", exc_info=exc)
        await studio.events.publish(
            event_type="server.error",
            scope="server",
            payload={"message": f"{type(exc).__name__}: {exc}"},
        )
        return api_error(500, "internal_error", "An internal server error occurred",
                         detail={"code": "internal_error", "message": "An internal server error occurred"})

