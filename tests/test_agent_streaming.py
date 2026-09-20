import unittest
from unittest.mock import MagicMock, patch

from openai.types.chat import ChatCompletionChunk

from miniagent import Agent, TextChunk, Tool, ToolCall


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
    return source


class AgentStreamingTests(unittest.TestCase):
    def setUp(self):
        client_patch = patch("miniagent.OpenAI")
        self.client = client_patch.start().return_value
        self.addCleanup(client_patch.stop)
        self.agent = Agent(None, {"LLM": {
            "API_KEY": "test", "BASE_URL": "https://example.com", "MODEL": "test",
        }}, "")

    def results(self, source):
        self.client.chat.completions.create.side_effect = [source, stream(chunk({}, "stop"))]
        return self.agent.get_response()

    def test_text_is_immediate_and_iteration_resumes(self):
        source = stream(
            chunk({"role": "assistant", "content": ""}),
            chunk({"content": "Hello"}),
            chunk({"content": "ignored"}, index=1),
            chunk(),
            chunk({"content": " world"}),
            chunk({}, "stop"),
        )
        result = self.results(source)
        self.assertIs(iter(result), result)
        self.assertEqual(next(result), TextChunk("Hello"))
        source.close.assert_not_called()
        self.assertEqual(list(result), [TextChunk(" world")])
        self.assertEqual(list(result), [])
        source.close.assert_called_once()

    def test_interleaved_tool_calls_are_assembled_in_index_order(self):
        self.agent.add_tools([
            Tool("search", "", {}, lambda q: q),
            Tool("weather", "", {}, lambda city: city),
        ])
        source = stream(
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
        result = self.results(source)
        self.assertEqual(list(result), [
            TextChunk("Checking"),
            ToolCall("call-1", "search", {"q": "hello"}, "hello"),
            ToolCall("call-2", "weather", {"city": "Paris"}, "Paris"),
        ])
        source.close.assert_called_once()

    def test_empty_stream(self):
        source = stream(chunk())
        result = self.results(source)
        self.assertEqual(list(result), [])
        source.close.assert_called_once()

    def test_incomplete_tool_calls_are_not_emitted(self):
        for ending in ([], [chunk({}, "length")]):
            with self.subTest(ending=ending):
                source = stream(chunk({"tool_calls": [
                    {"index": 0, "id": "call-1", "type": "function",
                     "function": {"name": "search", "arguments": '{"q":'}},
                ]}), *ending)
                result = self.results(source)
                with self.assertRaises(ValueError):
                    list(result)
                source.close.assert_called_once()
                self.assertEqual(self.agent.ctx.messages, [{"role": "system", "content": ""}])


if __name__ == "__main__":
    unittest.main()
