import inspect
import json
import re
import types
from collections.abc import Callable
from typing import Any, Literal, Union, get_args, get_origin, get_type_hints


def type_schema(annotation: Any) -> dict[str, Any]:
    primitives = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null"}
    if annotation in primitives:
        return {"type": primitives[annotation]}
    origin, args = get_origin(annotation), get_args(annotation)
    if origin is list and len(args) == 1:
        return {"type": "array", "items": type_schema(args[0])}
    if origin is dict and len(args) == 2 and args[0] is str:
        return {"type": "object", "additionalProperties": type_schema(args[1])}
    if origin in (Union, types.UnionType):
        return {"anyOf": [type_schema(arg) for arg in args]}
    if origin is Literal:
        if not args or any(type(arg) not in (str, int, float, bool, type(None)) for arg in args):
            raise TypeError(f"Unsupported literal: {annotation!r}")
        json.dumps(args, allow_nan=False)
        kinds = list(dict.fromkeys(primitives[type(arg)] for arg in args))
        return {"type": kinds[0] if len(kinds) == 1 else kinds, "enum": list(args)}
    raise TypeError(f"Unsupported annotation: {annotation!r}")


def doc_descriptions(handler: Callable[..., Any]) -> tuple[str, dict[str, str]]:
    lines = (inspect.getdoc(handler) or "").splitlines()
    summary: list[str] = []
    descriptions: dict[str, str] = {}
    in_args = False
    current = None
    entry_indent = None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.endswith(":"):
            break
        summary.append(stripped)
    for line in lines:
        stripped = line.strip()
        if stripped in ("Args:", "Arguments:"):
            in_args = True
            continue
        # Only parse lines after the actual section header.
        if not in_args or not stripped:
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            in_args = False
            continue
        match = re.fullmatch(r"(\w+)(?:\s*\([^)]*\))?:\s*(.*)", stripped)
        if match and (entry_indent is None or indent == entry_indent):
            current, text = match.groups()
            entry_indent = indent
            descriptions[current] = text
        elif current is not None and entry_indent is not None and indent > entry_indent:
            descriptions[current] = (descriptions[current] + " " + stripped).strip()
    return " ".join(summary), descriptions


def function_schema(handler: Callable[..., Any]) -> tuple[str, dict[str, Any]]:
    if inspect.iscoroutinefunction(handler) or inspect.isasyncgenfunction(handler):
        raise TypeError("Tool handlers must be synchronous")
    signature = inspect.signature(handler)
    hints = get_type_hints(handler)
    description, descriptions = doc_descriptions(handler)
    properties = {}
    required = []
    for name, parameter in signature.parameters.items():
        if parameter.kind not in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY):
            raise TypeError(f"Parameter {name!r} must accept a named argument")
        if name not in hints:
            raise TypeError(f"Parameter {name!r} requires a type annotation")
        try:
            schema = type_schema(hints[name])
        except (TypeError, ValueError) as error:
            raise TypeError(f"Parameter {name!r}: {error}") from error
        if name in descriptions:
            schema["description"] = descriptions[name]
        if parameter.default is inspect.Parameter.empty:
            required.append(name)
        else:
            try:
                schema["default"] = json.loads(json.dumps(parameter.default, allow_nan=False))
            except (TypeError, ValueError) as error:
                raise TypeError(f"Parameter {name!r} requires a JSON-serializable default") from error
        properties[name] = schema
    return description, {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }
