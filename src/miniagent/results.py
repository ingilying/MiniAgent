"""Frontend-neutral result contract, independent of model providers."""

import json
import uuid
from dataclasses import asdict, dataclass, field
from typing import Literal


type JsonValue = None | bool | int | float | str | list[JsonValue] | dict[str, JsonValue]


@dataclass(frozen=True)
class TextContent:
    text: str
    format: Literal["plain", "markdown"] = "plain"
    type: Literal["text"] = field(default="text", init=False)


@dataclass(frozen=True)
class ImageContent:
    """An image at a frontend-accessible URL, not a server filesystem path."""

    url: str
    alt: str = ""
    type: Literal["image"] = field(default="image", init=False)


@dataclass(frozen=True)
class FileContent:
    """A downloadable file at a frontend-accessible URL."""

    url: str
    name: str
    media_type: str = "application/octet-stream"
    type: Literal["file"] = field(default="file", init=False)


@dataclass(frozen=True)
class JsonContent:
    """Structured data a frontend can render as a tree or custom view."""

    data: JsonValue
    type: Literal["json"] = field(default="json", init=False)


type ResultContent = TextContent | ImageContent | FileContent | JsonContent


@dataclass(frozen=True)
class AgentResult:
    """One completed assistant message with ordered, typed content blocks."""

    content: list[ResultContent] = field(default_factory=list)
    context_id: str | None = None
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    role: Literal["assistant"] = field(default="assistant", init=False)
    schema_version: Literal[1] = field(default=1, init=False)

    def to_dict(self) -> dict[str, JsonValue]:
        """Return a detached JSON-compatible payload; reject invalid JSON data."""
        return json.loads(self.to_json())

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, allow_nan=False)
