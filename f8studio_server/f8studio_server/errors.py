from __future__ import annotations

from f8pysdk.specs import F8JsonValue
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from starlette.responses import JSONResponse


from f8pysdk.platform_errors import (
    InvalidRequestError as InvalidRequestError,
    NotFoundError as NotFoundError,
    ConflictError as ConflictError,
    ServiceUnavailableError as ServiceUnavailableError,
)


def api_error(status: int, code: str, message: str, *, detail: F8JsonValue = None) -> JSONResponse:
    from starlette.responses import JSONResponse
    # Keep detail during the API/1 transition for existing external clients.
    return JSONResponse(status_code=status, content={
        "code": code, "message": message, "detail": message if detail is None else detail,
    })
