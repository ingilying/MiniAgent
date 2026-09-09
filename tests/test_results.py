import json
import unittest

from miniagent import AgentResult, FileContent, ImageContent, JsonContent, TextContent


class AgentResultTests(unittest.TestCase):
    def test_mixed_content_wire_contract(self) -> None:
        result = AgentResult(
            id="message-1",
            context_id="context-1",
            content=[
                TextContent("# 你好", format="markdown"),
                ImageContent("/assets/chart.png", alt="Sales chart"),
                FileContent("/assets/report.pdf", "report.pdf", "application/pdf"),
                JsonContent({"count": 2, "rows": [True, None]}),
            ],
        )
        expected = {
            "schema_version": 1,
            "id": "message-1",
            "context_id": "context-1",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "# 你好", "format": "markdown"},
                {"type": "image", "url": "/assets/chart.png", "alt": "Sales chart"},
                {"type": "file", "url": "/assets/report.pdf", "name": "report.pdf",
                 "media_type": "application/pdf"},
                {"type": "json", "data": {"count": 2, "rows": [True, None]}},
            ],
        }
        self.assertEqual(result.to_dict(), expected)
        self.assertEqual(json.loads(result.to_json()), expected)

    def test_independent_messages(self) -> None:
        first, second = AgentResult(), AgentResult()
        self.assertNotEqual(first.id, second.id)
        first.content.append(TextContent("hello"))
        self.assertEqual(second.content, [])

    def test_payload_is_detached(self) -> None:
        result = AgentResult(content=[JsonContent({"rows": [1]})])
        payload = result.to_dict()
        payload["content"][0]["data"]["rows"].append(2)
        self.assertEqual(result.content[0].data, {"rows": [1]})

    def test_plain_text_is_not_parsed(self) -> None:
        payload = AgentResult(content=[TextContent('{"count": 2}')]).to_dict()
        self.assertEqual(payload["content"][0], {
            "type": "text", "format": "plain", "text": '{"count": 2}',
        })

    def test_non_json_values_fail_serialization(self) -> None:
        with self.assertRaises(TypeError):
            AgentResult(content=[JsonContent(object())]).to_dict()
        with self.assertRaises(ValueError):
            AgentResult(content=[JsonContent(float("nan"))]).to_json()


if __name__ == "__main__":
    unittest.main()
