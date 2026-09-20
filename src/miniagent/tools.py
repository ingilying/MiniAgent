import subprocess
from itertools import islice
from pathlib import Path


def read(path: str, limit: int = 2000) -> str:
    """Read a UTF-8 text file.

    Args:
        path: Absolute path or path relative to the current working directory.
        limit: Maximum number of lines to return; must be positive.
    """
    if limit <= 0:
        raise ValueError("limit must be positive")
    with Path(path).expanduser().open(encoding="utf-8") as file:
        return "".join(islice(file, limit))


def write(path: str, content: str) -> str:
    """Create or overwrite a UTF-8 text file, creating parent directories as needed.

    Args:
        path: Absolute path or path relative to the current working directory.
        content: Complete contents to write.
    """
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Wrote {target}"


def edit(path: str, old_text: str, new_text: str) -> str:
    """Replace one exact text match in a UTF-8 file. Fail if absent or ambiguous.

    Args:
        path: Absolute path or path relative to the current working directory.
        old_text: Nonempty text that must occur exactly once.
        new_text: Replacement text; use an empty string to delete the match.
    """
    if not old_text:
        raise ValueError("old_text must not be empty")
    target = Path(path).expanduser()
    content = target.read_text(encoding="utf-8")
    count = content.count(old_text)
    if count != 1:
        raise ValueError(f"Expected one match for old_text, found {count}")
    target.write_text(content.replace(old_text, new_text, 1), encoding="utf-8")
    return f"Edited {target}"


def command(
    command: str, workdir: str = ".", timeout: int = 120, limit: int = 2000,
) -> dict[str, str | int]:
    """Run a shell command and return stdout, stderr, and its exit code.

    Args:
        command: Shell command to execute using the system's default shell.
        workdir: Working directory for this command only.
        timeout: Maximum execution time in seconds; must be positive.
        limit: Maximum lines returned for each of stdout and stderr; must be positive.
    """
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    if limit <= 0:
        raise ValueError("limit must be positive")
    result = subprocess.run(
        command,
        shell=True,
        cwd=Path(workdir).expanduser(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return {
        "stdout": "".join(result.stdout.splitlines(keepends=True)[:limit]),
        "stderr": "".join(result.stderr.splitlines(keepends=True)[:limit]),
        "exit_code": result.returncode,
    }
