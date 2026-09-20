# MiniAgent

## Configuration

The `miniagent` entry point and `miniagent.app.create_agent()` choose the
configuration directory using `MINIAGENT_MODE`:

| Mode | Configuration directory |
| --- | --- |
| `development` (default) | `./.config/miniagent/`, relative to the current working directory |
| `release` | `~/.config/miniagent/`, under your home directory |

Run in development mode:

```sh
MINIAGENT_MODE=development uv run miniagent
```

Or omit `MINIAGENT_MODE` to use development mode. For release mode:

```sh
MINIAGENT_MODE=release miniagent
```

Missing configuration files are automatically created in the selected directory:

```text
miniagent/
├── config.toml
└── system_prompt.md
```

On first use, edit the generated `config.toml` with your API key and model:

```toml
[LLM]
API_KEY = "your-api-key"
BASE_URL = "https://api.openai.com/v1"
MODEL = "your-model"
```

The generated `system_prompt.md` contains a basic general-purpose prompt that
you can customize. Existing files are never overwritten. The local configuration
directory is ignored by Git.

An explicit configuration directory overrides the mode:

```python
from miniagent.app import create_agent

agent = create_agent(config_dir="/path/to/miniagent-config")
```

Application setup registers the `read`, `write`, `edit`, and `command` tools.

## Library usage

`Agent` takes connection settings and an optional prompt directly. It does not
load or create configuration files and starts with no tools registered.

```python
from miniagent import Agent, Tool
from miniagent.tools import read

agent = Agent(
    api_key="your-api-key",
    base_url="https://api.openai.com/v1",
    model="your-model",
    system_prompt="You are a helpful assistant.",
)
agent.add_tool(Tool.from_function(read))
```

Pass `ctx` to reuse an existing context. Its existing system prompt is preserved.
