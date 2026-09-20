import json
import unittest
from unittest.mock import Mock

from miniagent import RawToolUse, Tool


class ToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.handler = Mock(return_value={"temperature": 20})
        self.tool = Tool(
            name="weather",
            description="Get weather for a city",
            parameters={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
                "additionalProperties": False,
            },
            handler=self.handler,
        )

    def test_openai_definition_is_json_serializable(self) -> None:
        self.assertEqual(json.loads(json.dumps(self.tool.to_openai())), {
            "type": "function",
            "function": {
                "name": "weather",
                "description": "Get weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                    "additionalProperties": False,
                },
            },
        })

    def test_execute_passes_keyword_arguments_and_returns_result(self) -> None:
        result = self.tool.execute(RawToolUse("call-1", "weather", '{"city":"Paris"}'))
        self.handler.assert_called_once_with(city="Paris")
        self.assertIs(result, self.handler.return_value)

    def test_wrong_name_does_not_execute_handler(self) -> None:
        with self.assertRaisesRegex(ValueError, "Expected tool"):
            self.tool.execute(RawToolUse("call-1", "search", "{}"))
        self.handler.assert_not_called()

    def test_malformed_json_does_not_execute_handler(self) -> None:
        with self.assertRaises(json.JSONDecodeError):
            self.tool.execute(RawToolUse("call-1", "weather", '{"city":'))
        self.handler.assert_not_called()

    def test_non_object_arguments_do_not_execute_handler(self) -> None:
        for arguments in ('[]', 'null', '"Paris"', '42', 'true'):
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(ValueError, "JSON object"):
                    self.tool.execute(RawToolUse("call-1", "weather", arguments))
        self.handler.assert_not_called()

    def test_handler_error_is_propagated(self) -> None:
        error = RuntimeError("service unavailable")
        self.handler.side_effect = error
        with self.assertRaises(RuntimeError) as caught:
            self.tool.execute(RawToolUse("call-1", "weather", '{"city":"Paris"}'))
        self.assertIs(caught.exception, error)

    def test_python_signature_binds_arguments(self) -> None:
        def greet(name: str = "world") -> str:
            return f"Hello {name}"

        tool = Tool("greet", "Say hello", {"type": "object"}, greet)
        self.assertEqual(tool.execute(RawToolUse("call-1", "greet", "{}")), "Hello world")
        with self.assertRaises(TypeError):
            tool.execute(RawToolUse("call-2", "greet", '{"unknown":true}'))


if __name__ == "__main__":
    unittest.main()
