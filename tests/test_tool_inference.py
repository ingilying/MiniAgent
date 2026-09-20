import unittest
from typing import Literal, Optional

from miniagent import RawToolUse, Tool


class ToolInferenceTests(unittest.TestCase):
    def test_decorator_docs_defaults_and_execution(self):
        @Tool.from_function
        def weather(city: str, *, unit: Literal["celsius", "fahrenheit"] = "celsius") -> dict:
            """Get current weather.

            Args:
                city (str): City name, optionally including country.
                    For example, Paris, France.
                unit: Temperature unit.

            Returns:
                A weather report.
            """
            return {"city": city, "unit": unit}

        self.assertEqual(weather.name, "weather")
        self.assertEqual(weather.description, "Get current weather.")
        self.assertEqual(weather.parameters, {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description":
                         "City name, optionally including country. For example, Paris, France."},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"],
                         "default": "celsius", "description": "Temperature unit."},
            },
            "required": ["city"],
            "additionalProperties": False,
        })
        self.assertEqual(weather("Paris"), {"city": "Paris", "unit": "celsius"})
        self.assertEqual(weather.execute(RawToolUse("1", "weather", '{"city":"Paris"}')),
                         weather("Paris"))

    def test_nested_types_and_nullable_required_parameter(self):
        def query(rows: list[dict[str, int | float]], enabled: bool,
                  value: Optional[str], nothing: None = None):
            pass

        tool = Tool.from_function(query)
        properties = tool.parameters["properties"]
        self.assertEqual(properties["rows"], {
            "type": "array", "items": {"type": "object", "additionalProperties": {
                "anyOf": [{"type": "integer"}, {"type": "number"}],
            }},
        })
        self.assertEqual(properties["enabled"], {"type": "boolean"})
        self.assertEqual(properties["value"], {"anyOf": [{"type": "string"}, {"type": "null"}]})
        self.assertEqual(properties["nothing"], {"type": "null", "default": None})
        self.assertEqual(tool.parameters["required"], ["rows", "enabled", "value"])
        self.assertEqual(tool.description, "")

    def test_overrides_and_string_annotations(self):
        def greet(name: "str"):
            """Greet someone."""
            return name

        tool = Tool.from_function(greet, name="hello", description="Custom description")
        self.assertEqual(tool.name, "hello")
        self.assertEqual(tool.description, "Custom description")
        self.assertEqual(tool.parameters["properties"]["name"], {"type": "string"})

    def test_no_arguments(self):
        def ping():
            return "pong"

        tool = Tool.from_function(ping)
        self.assertEqual(tool.parameters["properties"], {})
        self.assertEqual(tool.parameters["required"], [])
        self.assertEqual(tool.execute(RawToolUse("1", "ping", "{}")), "pong")

    def test_invalid_signatures_fail_at_creation(self):
        def missing(value): pass
        def positional(value: str, /): pass
        def variadic(*values: str): pass
        def keywords(**values: str): pass
        def unsupported(value: set[str]): pass
        def bad_keys(value: dict[int, str]): pass
        def invalid_default(value: str = object()): pass
        async def asynchronous(value: str): pass

        for handler in (missing, positional, variadic, keywords, unsupported,
                        bad_keys, invalid_default, asynchronous):
            with self.subTest(handler=handler.__name__):
                with self.assertRaises(TypeError):
                    Tool.from_function(handler)


if __name__ == "__main__":
    unittest.main()
