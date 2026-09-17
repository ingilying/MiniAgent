import unittest
from unittest.mock import MagicMock

from openai.types.chat import ChatCompletionChunk

from miniagent import ResultStream, TextChunk, RawToolUse


def chunk(delta=None, finish_reason=None, index=0):
    return ChatCompletionChunk(
        id="completion-1",
        created=0,
        model="test",
        object="chat.completion.chunk",
        choices=[] if delta is None else [
            {"index": index, "delta": delta, "finish_reason": finish_reason},
        ],
    )


def stream(*chunks):
    source = MagicMock()
    source.__iter__.return_value = iter(chunks)
    return ResultStream(source)


class ResultStreamTests(unittest.TestCase):
    def test_text_is_immediate_and_iteration_resumes(self):
        result = stream(
            chunk({"role": "assistant", "content": ""}),
            chunk({"content": "Hello"}),
            chunk({"content": "ignored"}, index=1),
            chunk(),
            chunk({"content": " world"}),
            chunk({}, "stop"),
        )
        self.assertIs(iter(result), result)
        self.assertEqual(next(result), TextChunk("Hello"))
        result.stream.close.assert_not_called()
        self.assertEqual(list(result), [TextChunk(" world")])
        self.assertEqual(list(result), [])
        result.stream.close.assert_called_once()

    def test_interleaved_tool_calls_are_assembled_in_index_order(self):
        result = stream(
            chunk({"content": "Checking", "tool_calls": [
                {"index": 1, "id": "call-2", "type": "function",
                 "function": {"name": "weather", "arguments": '{"city":'}},
                {"index": 0, "id": "call-1", "type": "function",
                 "function": {"name": "search", "arguments": '{"q":'}},
            ]}),
            chunk({"tool_calls": [
                {"index": 0, "function": {"arguments": '"hello"}'}},
                {"index": 1, "function": {"arguments": '"Paris"}'}},
            ]}),
            chunk({}, "tool_calls"),
        )
        self.assertEqual(list(result), [
            TextChunk("Checking"),
            RawToolUse("call-1", "search", '{"q":"hello"}'),
            RawToolUse("call-2", "weather", '{"city":"Paris"}'),
        ])
        result.stream.close.assert_called_once()

    def test_empty_stream(self):
        result = stream(chunk())
        self.assertEqual(list(result), [])
        result.stream.close.assert_called_once()

    def test_context_manager_closes_early(self):
        result = stream(chunk({"content": "hello"}), chunk({"content": "world"}))
        with result as entered:
            self.assertIs(entered, result)
            self.assertEqual(next(result), TextChunk("hello"))
        result.close()
        result.stream.close.assert_called_once()
        self.assertEqual(list(result), [])

    def test_upstream_error_is_propagated_and_closed(self):
        error = RuntimeError("connection failed")
        result = stream()
        result.stream.__iter__.side_effect = error
        with self.assertRaises(RuntimeError) as caught:
            next(result)
        self.assertIs(caught.exception, error)
        result.stream.close.assert_called_once()

    def test_incomplete_tool_calls_are_not_emitted(self):
        for ending in ([], [chunk({}, "length")]):
            with self.subTest(ending=ending):
                result = stream(chunk({"tool_calls": [
                    {"index": 0, "id": "call-1", "type": "function",
                     "function": {"name": "search", "arguments": '{"q":'}},
                ]}), *ending)
                with self.assertRaises(ValueError):
                    list(result)
                result.stream.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
