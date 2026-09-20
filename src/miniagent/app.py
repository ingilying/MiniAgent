import os
import tomllib
from pathlib import Path

from . import Agent, Tool
from . import tools
from ._defaults import CONFIG, SYSTEM_PROMPT


def create_agent(config_dir: str | Path | None = None) -> Agent:
    if config_dir is None:
        mode = os.environ.get("MINIAGENT_MODE", "development")
        if mode == "development":
            config_dir = Path.cwd() / ".config" / "miniagent"
        elif mode == "release":
            config_dir = Path.home() / ".config" / "miniagent"
        else:
            raise ValueError("MINIAGENT_MODE must be 'development' or 'release'")
    directory = Path(config_dir).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in (
        ("config.toml", CONFIG),
        ("system_prompt.md", SYSTEM_PROMPT),
    ):
        try:
            with (directory / name).open("x", encoding="utf-8") as file:
                file.write(content)
        except FileExistsError:
            pass

    with (directory / "config.toml").open("rb") as file:
        config = tomllib.load(file)
    system_prompt = (directory / "system_prompt.md").read_text(encoding="utf-8")
    agent = Agent(
        api_key=config["LLM"]["API_KEY"],
        base_url=config["LLM"]["BASE_URL"],
        model=config["LLM"]["MODEL"],
        system_prompt=system_prompt,
    )
    agent.add_tools(
        Tool.from_function(handler)
        for handler in (tools.read, tools.write, tools.edit, tools.command)
    )
    return agent


def main() -> None:
    create_agent()
