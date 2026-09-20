import json
import tomllib
import uuid
from collections.abc import Callable, Generator, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Self

from openai.types.chat import ChatCompletionMessageParam as Message
from openai import OpenAI
from openai.types.chat import ChatCompletionToolParam, ChatCompletionAssistantMessageParam

from ._tool_schema import function_schema


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
    arguments: dict[str, Any] | str
    response: Any

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

    def execute(self, arguments: dict[str,Any]) -> Any:
        return self.handler(**arguments)

type AgentResult = TextChunk | ToolCall


@dataclass(init=False)
class Context:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    messages: list[Message] = field(default_factory=list)
    storage_dir: str | Path = field(default=Path("contexts"), repr=False)

    def __init__(
        self,
        id: str | None = None,
        messages: list[Message] | None = None,
        storage_dir: str | Path = Path("contexts"),
        system_prompt: str | None = None,
    ) -> None:
        self.id = str(uuid.uuid4()) if id is None else str(uuid.UUID(id))
        self.messages = list(messages) if messages is not None else []
        self.storage_dir = storage_dir
        if system_prompt is not None:
            self.system_prompt = system_prompt

    @property
    def system_prompt(self) -> str | None:
        if self.messages and self.messages[0]["role"] == "system":
            content = self.messages[0].get("content")
            if isinstance(content, str):
                return content
        return None

    @system_prompt.setter
    def system_prompt(self, value: str | None) -> None:
        if self.messages and self.messages[0]["role"] == "system":
            self.messages.pop(0)
        if value is not None:
            self.messages.insert(0, {"role": "system", "content": value})

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
        if data.get("system_prompt") is not None:
            context.system_prompt = data["system_prompt"]
        return context


class Agent:
    ctx: Context
    api_key: str
    base_url: str
    model: str
    client: OpenAI
    tools: dict[str, Tool]

    def __init__(self,config: dict[str, Any], ctx: Context | None = None,  system_prompt: str | None = None) -> None:
        if ctx is None:
            self.ctx = Context()
        else:
            self.ctx = ctx

        self.api_key = config["LLM"]["API_KEY"]
        self.base_url = config["LLM"]["BASE_URL"]
        self.model = config["LLM"]["MODEL"]
        if system_prompt is not None:
            self.ctx.system_prompt = system_prompt
        elif self.ctx.system_prompt is None:
            with open("system_prompt.md",encoding = "utf-8") as file:
                self.ctx.system_prompt = file.read()
        self.tools = {}
        self.client = OpenAI(base_url=self.base_url,api_key=self.api_key)

    @property
    def system_prompt(self) -> str | None:
        return self.ctx.system_prompt

    @system_prompt.setter
    def system_prompt(self, value: str | None) -> None:
        self.ctx.system_prompt = value

    def add_tool(self, tool: Tool) -> None:
        self.add_tools([tool])

    def add_tools(self, tools: Iterable[Tool]) -> None:
        additions: dict[str, Tool] = {}
        for tool in tools:
            if tool.name in self.tools or tool.name in additions:
                raise ValueError(f"Duplicate tool name: {tool.name}")
            additions[tool.name] = tool
        self.tools.update(additions)

    def _execute_tool(self, call: RawToolUse) -> tuple[ToolCall, str]:
        arguments: dict[str, Any] | str = call.arguments
        try:
            parsed = json.loads(call.arguments)
            if not isinstance(parsed, dict):
                raise ValueError("Tool arguments must be a JSON object")
            arguments = parsed
            if call.name not in self.tools:
                raise ValueError(f"Unknown tool: {call.name}")
            response = self.tools[call.name].execute(arguments)
            content = response if isinstance(response, str) else json.dumps(
                response, ensure_ascii=False, allow_nan=False,
            )
        except Exception as error:
            response = {"error": {"type": type(error).__name__, "message": str(error)}}
            content = json.dumps(response, ensure_ascii=False)
        return ToolCall(call.id, call.name, arguments, response), content

    def get_response(self) -> Generator[AgentResult, None, None]:
        while True:
            messages = list(self.ctx.messages)
            openai_tools = [tool.to_openai() for tool in self.tools.values()]
            stream = self.client.chat.completions.create(
                messages=messages,
                model=self.model,
                stream=True,
                **({"tools": openai_tools} if openai_tools else {}),
            )
            text: list[str] = []
            pending_tools: dict[int, RawToolUse] = {}
            finished = False
            try:
                for chunk in stream:
                    for choice in chunk.choices:
                        if choice.index != 0:
                            continue
                        if choice.delta.content:
                            text.append(choice.delta.content)
                            yield TextChunk(choice.delta.content)
                        for delta in choice.delta.tool_calls or []:
                            call = pending_tools.get(delta.index, RawToolUse("", "", ""))
                            function = delta.function
                            pending_tools[delta.index] = RawToolUse(
                                id=call.id + (delta.id or ""),
                                name=call.name + (function.name or "" if function else ""),
                                arguments=call.arguments + (function.arguments or "" if function else ""),
                            )
                        if choice.finish_reason is not None:
                            if pending_tools and choice.finish_reason not in ("tool_calls", "stop"):
                                raise ValueError(f"Incomplete tool calls: {choice.finish_reason}")
                            finished = True
                            break
                    if finished:
                        break
                if pending_tools and not finished:
                    raise ValueError("Stream ended before tool calls were complete")
            finally:
                stream.close()

            # tool calls
            calls = [pending_tools[index] for index in sorted(pending_tools)]
            assistant: ChatCompletionAssistantMessageParam = {
                "role": "assistant", "content": "".join(text) if text else None,
            }
            if calls:
                assistant["tool_calls"] = [
                    {"id": call.id, "type": "function", "function": {
                        "name": call.name, "arguments": call.arguments,
                    }} for call in calls
                ]
            self.ctx.messages.append(assistant)
            if not calls:
                return
            events: list[ToolCall] = []
            for call in calls:
                event, content = self._execute_tool(call)
                self.ctx.messages.append({
                    "role": "tool", "tool_call_id": call.id, "content": content,
                })
                events.append(event)
            yield from events


def main() -> None:
    # config load
    with open("config.toml", "rb") as file:
        config = tomllib.load(file)

    agent = Agent(config)
