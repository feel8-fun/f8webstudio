from __future__ import annotations

from collections.abc import Mapping
from types import CodeType
from f8pysdk.expressions import (
    GLOBAL_FUNCTIONS, compile_expression, evaluate_expression,
    is_identifier as is_identifier, normalize_expr_code as normalize_expr_code,
    unwrap_value as unwrap_value, wrap_value as wrap_value,
)

RuntimeValue = object


def compile_expr(expression: str, *, allow_numpy: bool) -> tuple[CodeType | None, str | None]:
    if allow_numpy:
        return None, "NumPy expressions are unavailable in the Web Studio runtime"
    return compile_expression(expression, functions=GLOBAL_FUNCTIONS.keys())


def safe_eval_compiled(code: CodeType, *, names: Mapping[str, object]) -> object:
    return evaluate_expression(code, names=names, functions=GLOBAL_FUNCTIONS)


__all__ = ["RuntimeValue", "compile_expr", "is_identifier", "normalize_expr_code",
           "safe_eval_compiled", "unwrap_value", "wrap_value"]
