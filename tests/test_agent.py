import json
import unittest
from unittest.mock import MagicMock, patch

from openai.types.chat import ChatCompletionChunk

from miniagent import Agent, Context, TextChunk, Tool, ToolCall


def completion(text=None, calls=()):
    delta = {}
    if text is not None:
        delta["content"] = text
    if calls:
        delta["tool_calls"] = [
            {"index": index, "id": id, "type": "function",
             "function": {"name": name, "arguments": arguments}}
            for index, (id, name, arguments) in enumerate(calls)
        ]
    chunks = [ChatCompletionChunk(
        id="completion", created=0, model="test", object="chat.completion.chunk",
        choices=[{"index": 0, "delta": value, "finish_reason": finish}],
    ) for value, finish in [(delta, None), ({}, "tool_calls" if calls else "stop")]]
    stream = MagicMock()
    stream.__iter__.return_value = iter(chunks)
    return stream


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.client_patch = patch("miniagent.OpenAI")
        self.client = self.client_patch.start().return_value
        self.addCleanup(self.client_patch.stop)
        self.config = {"LLM": {"API_KEY": "test", "BASE_URL": "https://example.com", "MODEL": "test"}}
        self.agent = Agent(self.config,
                           Context(messages=[{"role": "user", "content": "Help"}]), "Be helpful")

    def test_registration_is_atomic_and_agent_local(self):
        @Tool.from_function
        def first(): return 1

        @Tool.from_function
        def second(): return 2

        self.agent.add_tool(first)
        with self.assertRaises(ValueError):
            self.agent.add_tools([second, first])
        self.assertEqual(self.agent.tools, {"first": first})
        with self.assertRaises(ValueError):
            self.agent.add_tools([second, second])
        self.assertEqual(self.agent.tools, {"first": first})
        self.agent.add_tools(iter([second]))
        self.assertEqual(self.agent.tools, {"first": first, "second": second})
        self.assertEqual(Agent(self.config, system_prompt="").tools, {})

    def test_text_only_and_system_prompt(self):
        source = completion("Hello")
        self.client.chat.completions.create.return_value = source
        self.assertEqual(list(self.agent.get_response()), [TextChunk("Hello")])
        request = self.client.chat.completions.create.call_args.kwargs
        self.assertEqual(request["messages"], [
            {"role": "system", "content": "Be helpful"},
            {"role": "user", "content": "Help"},
        ])
        self.assertNotIn("tools", request)
        self.assertEqual(self.agent.ctx.messages[-1], {"role": "assistant", "content": "Hello"})
        source.close.assert_called_once()

    def test_context_system_prompt_is_used_and_can_be_updated(self):
        context = Context(system_prompt="Context prompt")
        with patch("builtins.open") as open_file:
            agent = Agent(self.config, context)
        open_file.assert_not_called()
        self.assertEqual(agent.system_prompt, "Context prompt")
        context.system_prompt = "Updated prompt"
        self.client.chat.completions.create.return_value = completion("Hello")
        list(agent.get_response())
        self.assertEqual(self.client.chat.completions.create.call_args.kwargs["messages"][0],
                         {"role": "system", "content": "Updated prompt"})

    def test_explicit_prompt_overrides_context_and_empty_prompt_skips_file(self):
        context = Context(system_prompt="Original")
        agent = Agent(self.config, context, "Override")
        self.assertEqual(context.system_prompt, "Override")
        agent.system_prompt = ""
        with patch("builtins.open") as open_file:
            Agent(self.config, context)
        open_file.assert_not_called()

    def test_multiple_tools_and_successive_rounds(self):
        @Tool.from_function
        def double(value: int): return {"value": value * 2}

        @Tool.from_function
        def greet(name: str): return f"Hello {name}"

        self.agent.add_tools([double, greet])
        sources = [
            completion("Working", [("a", "double", '{"value":2}'), ("b", "greet", '{"name":"Ada"}')]),
            completion(calls=[("c", "double", '{"value":4}')]),
            completion("Done"),
        ]
        self.client.chat.completions.create.side_effect = sources
        self.assertEqual(list(self.agent.get_response()), [
            TextChunk("Working"),
            ToolCall("a", "double", {"value": 2}, {"value": 4}),
            ToolCall("b", "greet", {"name": "Ada"}, "Hello Ada"),
            ToolCall("c", "double", {"value": 4}, {"value": 8}),
            TextChunk("Done"),
        ])
        self.assertEqual(self.agent.ctx.messages[0], {"role": "system", "content": "Be helpful"})
        history = self.agent.ctx.messages[1:]
        self.assertEqual([message["role"] for message in history],
                         ["user", "assistant", "tool", "tool", "assistant", "tool", "assistant"])
        self.assertEqual(history[1]["content"], "Working")
        self.assertEqual(history[1]["tool_calls"][0]["id"], "a")
        self.assertEqual(history[2]["tool_call_id"], "a")
        self.assertEqual(json.loads(history[2]["content"]), {"value": 4})
        self.assertEqual(history[3]["content"], "Hello Ada")
        requests = self.client.chat.completions.create.call_args_list
        self.assertEqual(requests[1].kwargs["messages"][1:], history[:4])
        self.assertEqual(requests[2].kwargs["messages"][1:], history[:6])
        for request in requests:
            self.assertEqual(request.kwargs["tools"], [double.to_openai(), greet.to_openai()])
        for source in sources:
            source.close.assert_called_once()

    def test_tool_errors_are_returned_to_model_and_ui(self):
        def fail(): raise RuntimeError("failed")

        self.agent.add_tools([
            Tool("fail", "", {}, fail),
            Tool("bad_result", "", {}, lambda: object()),
        ])
        cases = [("missing", "{}", "ValueError"), ("fail", "{", "JSONDecodeError"),
                 ("fail", "[]", "ValueError"), ("fail", "{}", "RuntimeError"),
                 ("bad_result", "{}", "TypeError")]
        for name, arguments, error_type in cases:
            with self.subTest(name=name, arguments=arguments):
                self.client.chat.completions.create.side_effect = [
                    completion(calls=[("a", name, arguments)]), completion("Recovered"),
                ]
                events = list(self.agent.get_response())
                self.assertEqual(events[0].response["error"]["type"], error_type)
                if arguments in ("{", "[]"):
                    self.assertEqual(events[0].arguments, arguments)
                self.assertEqual(events[-1], TextChunk("Recovered"))
                self.assertEqual(json.loads(self.agent.ctx.messages[-2]["content"]), events[0].response)

    def test_close_during_text_closes_source(self):
        source = completion("Hello")
        self.client.chat.completions.create.return_value = source
        results = self.agent.get_response()
        self.assertEqual(next(results), TextChunk("Hello"))
        results.close()
        source.close.assert_called_once()
        self.assertEqual(len(self.agent.ctx.messages), 2)

    def test_all_tool_results_recorded_before_first_event(self):
        handler = MagicMock(return_value=True)
        self.agent.add_tool(Tool("run", "", {}, handler))
        source = completion(calls=[("a", "run", "{}"), ("b", "run", "{}")])
        self.client.chat.completions.create.return_value = source
        results = self.agent.get_response()
        self.assertIsInstance(next(results), ToolCall)
        results.close()
        self.assertEqual(handler.call_count, 2)
        self.assertEqual([message["role"] for message in self.agent.ctx.messages],
                         ["system", "user", "assistant", "tool", "tool"])
        self.client.chat.completions.create.assert_called_once()
        source.close.assert_called_once()

    def test_stream_error_propagates_and_closes(self):
        source = MagicMock()
        source.__iter__.side_effect = RuntimeError("connection lost")
        self.client.chat.completions.create.return_value = source
        with self.assertRaisesRegex(RuntimeError, "connection lost"):
            list(self.agent.get_response())
        source.close.assert_called_once()
        self.assertEqual(len(self.agent.ctx.messages), 2)


if __name__ == "__main__":
    unittest.main()
