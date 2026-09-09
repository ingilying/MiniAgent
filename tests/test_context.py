import tempfile
import unittest
import uuid
from pathlib import Path
from typing import get_type_hints

from miniagent import Context, Message


class ContextTests(unittest.TestCase):
    def test_defaults_are_independent(self) -> None:
        first = Context()
        second = Context()

        uuid.UUID(first.id)
        self.assertNotEqual(first.id, second.id)
        first.messages.append({"role": "user", "content": "hello"})
        self.assertEqual(second.messages, [])

    def test_accepts_openai_messages(self) -> None:
        messages: list[Message] = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "Hi!"},
        ]

        context = Context(messages=messages)

        self.assertEqual(context.messages, messages)
        self.assertEqual(
            get_type_hints(Context)["messages"],
            list[Message],
        )

    def test_save_and_load(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            context = Context(storage_dir=directory)
            context.messages.append({"role": "user", "content": "hello"})

            saved_path = context.save()
            loaded = Context.load(context.id, directory)

            self.assertEqual(saved_path, Path(directory) / f"{context.id}.json")
            self.assertEqual(loaded.id, context.id)
            self.assertEqual(loaded.messages, context.messages)

    def test_invalid_id_cannot_escape_storage_directory(self) -> None:
        with self.assertRaises(ValueError):
            Context(id="../unsafe")


if __name__ == "__main__":
    unittest.main()
