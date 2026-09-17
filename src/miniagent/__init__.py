import json
import tomllib
import uuid
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Self

from openai.types.chat import ChatCompletionMessageParam as Message
from openai import OpenAI
from openai import Stream as OpenAIStream
from openai.types.chat import ChatCompletionChunk, ChatCompletionToolParam

from ._tool_schema import function_schema

type OriginStream = OpenAIStream[ChatCompletionChunk]


@dataclass(frozen=True)
class TextChunk:
    text: str


@dataclass(frozen=True)
class RawToolUse:
    id: str
    name: str
    arguments: str

@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    response: dict[str,Any]

@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Any] = field(repr=False)

    @classmethod
    def from_function(
        cls,
        handler: Callable[..., Any],
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> Self:
        summary, parameters = function_schema(handler)
        return cls(
            name=handler.__name__ if name is None else name,
            description=summary if description is None else description,
            parameters=parameters,
            handler=handler,
        )

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.handler(*args, **kwargs)

    def to_openai(self) -> ChatCompletionToolParam:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def execute(self, call: RawToolUse) -> Any:
        if call.name != self.name:
            raise ValueError(f"Expected tool {self.name!r}, got {call.name!r}")
        arguments = json.loads(call.arguments)
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be a JSON object")
        return self.handler(**arguments)

type Result = TextChunk | RawToolUse


@dataclass
class ResultStream:
    stream: OriginStream
    _results: Generator[Result, None, None] = field(init=False, repr=False)
    _closed: bool = field(default=False, init=False, repr=False)

    def __post_init__(self) -> None:
        self._results = self._iterate()

    def __iter__(self) -> Self:
        return self

    def __next__(self) -> Result:
        if self._closed:
            raise StopIteration
        try:
            return next(self._results)
        except BaseException:
            self.close()
            raise

    def _iterate(self) -> Generator[Result, None, None]:
        calls: dict[int, RawToolUse] = {}
        for chunk in self.stream:
            for choice in chunk.choices:
                if choice.index != 0:
                    continue
                if choice.delta.content:
                    yield TextChunk(choice.delta.content)
                for delta in choice.delta.tool_calls or []:
                    call = calls.get(delta.index, RawToolUse("", "", ""))
                    function = delta.function
                    calls[delta.index] = RawToolUse(
                        id=call.id + (delta.id or ""),
                        name=call.name + (function.name or "" if function else ""),
                        arguments=call.arguments + (function.arguments or "" if function else ""),
                    )
                if choice.finish_reason is not None:
                    if calls and choice.finish_reason not in ("tool_calls", "stop"):
                        raise ValueError(f"Incomplete tool calls: {choice.finish_reason}")
                    for index in sorted(calls):
                        yield calls[index]
                    return
        if calls:
            raise ValueError("Stream ended before tool calls were complete")

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            try:
                self._results.close()
            finally:
                self.stream.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


@dataclass
class Context:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    messages: list[Message] = field(default_factory=list)
    storage_dir: str | Path = field(default=Path("contexts"), repr=False)

    def __post_init__(self) -> None:
        self.id = str(uuid.UUID(self.id))

    @property
    def path(self) -> Path:
        return Path(self.storage_dir) / f"{self.id}.json"

    def save(self) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _ = self.path.write_text(
            json.dumps({"id": self.id, "messages": self.messages}, ensure_ascii=False),
            encoding="utf-8",
        )
        return self.path

    @classmethod
    def load(cls, id: str, storage_dir: str | Path | None = None) -> Self:
        storage_dir = Path("contexts") if storage_dir is None else storage_dir
        context = cls(id=id, storage_dir=storage_dir)
        data = json.loads(context.path.read_text(encoding="utf-8"))
        if data["id"] != id:
            raise ValueError(f"context file ID does not match {id}")
        context.messages = data["messages"]
        return context


class Agent:
    ctx: Context
    api_key: str
    base_url: str
    model: str
    system_prompt: str
    client: OpenAI

    def __init__(self, ctx: Context | None, config: dict[str, Any], system_prompt: str | None) -> None:
        if ctx is None:
            self.ctx = Context()
        else:
            self.ctx = ctx

        self.api_key = config["LLM"]["API_KEY"]
        self.base_url = config["LLM"]["BASE_URL"]
        self.model = config["LLM"]["MODEL"]
        if system_prompt is None:
            with open("system_prompt.md",encoding = "utf-8") as file:
                self.system_prompt = file.read()
        self.client = OpenAI(base_url=self.base_url,api_key=self.api_key)

    def  get_response(self) -> ResultStream:
        stream: OriginStream = self.client.chat.completions.create(
            messages= self.ctx.messages,
            model= self.model,
            stream= True,
        )
        return ResultStream(stream)


def main() -> None:
    # config load
    with open("config.toml", "rb") as file:
        config = tomllib.load(file)
