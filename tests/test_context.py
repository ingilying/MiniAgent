import json
import tempfile
import unittest
import uuid
from pathlib import Path
from typing import get_type_hints

from miniagent import Context, Message


class ContextTests(unittest.TestCase):
    def test_prompt_is_first_message_and_replaced_without_duplicates(self) -> None:
        messages: list[Message] = [{"role": "user", "content": "Hello"}]
        context = Context(messages=messages, system_prompt="Be helpful")
        self.assertEqual(context.messages, [
            {"role": "system", "content": "Be helpful"},
            {"role": "user", "content": "Hello"},
        ])
        self.assertEqual(len(messages), 1)
        context.system_prompt = "Updated"
        self.assertEqual(context.messages[0], {"role": "system", "content": "Updated"})
        self.assertEqual(len(context.messages), 2)
        context.system_prompt = None
        self.assertEqual(context.messages, messages)

    def test_existing_system_message_is_preserved(self) -> None:
        context = Context(messages=[{"role": "system", "content": "Existing"}])
        self.assertEqual(context.system_prompt, "Existing")

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
            context = Context(storage_dir=directory, system_prompt="Be helpful")
            context.messages.append({"role": "user", "content": "hello"})

            saved_path = context.save()
            loaded = Context.load(context.id, directory)

            self.assertEqual(saved_path, Path(directory) / f"{context.id}.json")
            self.assertEqual(loaded.id, context.id)
            self.assertEqual(loaded.messages, context.messages)
            self.assertEqual(loaded.system_prompt, "Be helpful")
            self.assertEqual(loaded.messages[0], {"role": "system", "content": "Be helpful"})
            self.assertNotIn("system_prompt", json.loads(saved_path.read_text()))

    def test_load_legacy_context_without_system_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            context = Context(storage_dir=directory)
            context.path.write_text(json.dumps({"id": context.id, "messages": []}), encoding="utf-8")
            self.assertIsNone(Context.load(context.id, directory).system_prompt)

    def test_invalid_id_cannot_escape_storage_directory(self) -> None:
        with self.assertRaises(ValueError):
            Context(id="../unsafe")


if __name__ == "__main__":
    unittest.main()
