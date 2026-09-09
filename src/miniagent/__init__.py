import json
import tomllib
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Self

from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam as Message


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
    def __init__(self, ctx: Context | None,) -> None:
        pass


def main() -> None:
    # config load
    with open("config.toml", "rb") as file:
        config = tomllib.load(file)

    api_key = config["LLM"]["API_KEY"]
    base_url = config["LLM"]["BASE_URL"]
    model = config["LLM"]["MODEL"]

