---
name: qwen-assistant
description: Use Qwen3.7-Plus for visual analysis of uploaded images and for current web research with source URLs. Invoke when an image is unsupported by Claude, when OCR/layout/chart evidence is needed, or when a coding/document task needs up-to-date external facts.
---

# Qwen Assistant

Use the plugin MCP tools instead of asking the user for an API key.

## Images

When the user uploads an image or asks you to inspect the newest screenshot, call `qwen_vision`.

- Normally omit `image_path` and `image_data`; the tool will use the most recently uploaded Claude Cowork image.
- If a mounted upload path or filename is known, pass it as `image_path`; the tool maps Cowork paths to the host upload automatically.
- Use `image_data` only when the actual base64/data URL is already available.
- Put the requested OCR, layout, chart, or visual-analysis task in `prompt`.
- Never ask the user to paste `DASHSCOPE_API_KEY`.

## Web research

For current or externally verifiable information, call `qwen_research` with a precise query. Preserve the returned source URLs and distinguish verified facts from inference.

## Handoff

Treat Qwen output as evidence for the main coding or document-editing task. Do not claim an image was inspected or a source was searched unless the corresponding tool completed successfully.
