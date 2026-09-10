import { execFile, spawn } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bridgeDirectory = "C:\\Users\\63172\\AppData\\Local\\ClaudeQwenBridge";
const coworkSessionsDirectory =
  "C:\\Users\\63172\\AppData\\Local\\Claude-3p\\local-agent-mode-sessions";
const openCodeExecutable =
  "C:\\Users\\63172\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
const qwenMessagesEndpoint =
  "https://ws-pirzl9pr7z0vab2u.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages";
const supportedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

async function readUserEnvironment(name) {
  if (process.env[name]) return process.env[name];

  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Environment", "/v", name],
      { encoding: "utf8", windowsHide: true },
    );
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = stdout.match(new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.+)$`, "mi"));
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

function extractFinalText(stdout) {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        finalText = event.part.text;
      }
    } catch {
      // Ignore non-JSON diagnostic lines from the CLI.
    }
  }
  return finalText.trim();
}

function detectMediaType(buffer, fileName = "") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  throw new Error("Unsupported image format. Use PNG, JPEG, GIF, or WebP.");
}

async function findCoworkUpload(requestedPath = "") {
  const requestedName = requestedPath
    ? path.win32.basename(requestedPath.replaceAll("/", "\\"))
    : "";
  const stack = [coworkSessionsDirectory];
  const candidates = [];

  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || path.basename(directory).toLowerCase() !== "uploads") continue;
      if (!supportedImageExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (requestedName && entry.name !== requestedName) continue;
      try {
        const info = await stat(fullPath);
        candidates.push({ fullPath, modified: info.mtimeMs });
      } catch {
        // Ignore files removed while scanning.
      }
    }
  }

  candidates.sort((a, b) => b.modified - a.modified);
  if (!candidates.length) {
    throw new Error(
      requestedName
        ? `No Claude Cowork upload named ${requestedName} was found.`
        : "No uploaded image was found in recent Claude Cowork sessions.",
    );
  }
  return candidates[0].fullPath;
}

async function loadVisionInput({ image_path, image_data, media_type }) {
  if (image_data) {
    const dataUrl = image_data.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/i);
    const resolvedMediaType = dataUrl?.[1]?.toLowerCase() || media_type?.toLowerCase();
    const rawBase64 = (dataUrl?.[2] || image_data).replace(/\s+/g, "");
    if (!resolvedMediaType || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(resolvedMediaType)) {
      throw new Error("Raw base64 input requires media_type: image/png, image/jpeg, image/gif, or image/webp.");
    }
    const buffer = Buffer.from(rawBase64, "base64");
    if (!buffer.length) throw new Error("The supplied base64 image is empty or invalid.");
    if (buffer.length > 20 * 1024 * 1024) throw new Error("The image exceeds the 20 MB limit.");
    return { buffer, mediaType: resolvedMediaType };
  }

  let resolvedPath = image_path || "";
  if (resolvedPath) {
    try {
      await access(resolvedPath);
    } catch {
      resolvedPath = await findCoworkUpload(resolvedPath);
    }
  } else {
    resolvedPath = await findCoworkUpload();
  }
  const buffer = await readFile(resolvedPath);
  if (buffer.length > 20 * 1024 * 1024) throw new Error("The image exceeds the 20 MB limit.");
  return { buffer, mediaType: detectMediaType(buffer, resolvedPath) };
}

async function callQwenVision(input, prompt) {
  const apiKey = await readUserEnvironment("DASHSCOPE_API_KEY");
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured in the Windows user environment.");
  const { buffer, mediaType } = await loadVisionInput(input);
  const response = await fetch(qwenMessagesEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "qwen3.7-plus",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Qwen API returned HTTP ${response.status}: ${body.replaceAll(apiKey, "<redacted>")}`);
  const parsed = JSON.parse(body);
  const text = parsed.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!text) throw new Error("Qwen API returned no text content.");
  return text;
}

async function runOpenCode(agent, prompt, imagePath) {
  const apiKey = await readUserEnvironment("DASHSCOPE_API_KEY");
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY is not configured in the Windows user environment.");
  }

  const exaEnabled = (await readUserEnvironment("OPENCODE_ENABLE_EXA")) || "1";
  const args = [
    "run",
    "--agent",
    agent,
    "--format",
    "json",
    prompt,
  ];
  if (imagePath) args.push("--file", imagePath);

  try {
    const text = await new Promise((resolve, reject) => {
      const child = spawn(openCodeExecutable, args, {
      cwd: bridgeDirectory,
      env: {
        ...process.env,
        DASHSCOPE_API_KEY: apiKey,
        OPENCODE_ENABLE_EXA: exaEnabled,
      },
      windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const finalText = extractFinalText(stdout);
        if (child.exitCode === null) child.kill();
        if (error) reject(error);
        else if (finalText) resolve(finalText);
        else reject(new Error(stderr.trim() || "OpenCode completed without returning model text."));
      };

      const timer = setTimeout(() => {
        finish(new Error("OpenCode Qwen call timed out after 180 seconds."));
      }, 180_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        for (const line of lines) {
          if (!line.trimStart().startsWith("{")) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "step_finish" && event.part?.reason !== "tool-calls") {
              finish();
              return;
            }
          } catch {
            // Wait for a complete JSONL event.
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", finish);
      child.on("exit", (code) => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `OpenCode exited with code ${code}.`));
      });
    });
    if (!text) throw new Error("OpenCode completed without returning model text.");
    return text;
  } catch (error) {
    const raw = [error?.message, error?.stderr].filter(Boolean).join("\n");
    throw new Error(raw.replaceAll(apiKey, "<redacted>"));
  }
}

const tools = [
  {
    name: "qwen_vision",
    title: "Qwen Vision",
    description:
      "Use Qwen3.7-Plus to inspect an image, screenshot, scan, diagram, or document page. Accepts a local/Cowork image path or base64/data URL. If no image input is supplied, it automatically uses the most recently uploaded Claude Cowork image. Never ask the user for an API key.",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "Optional Windows or Cowork upload path; omit for the latest uploaded image" },
        image_data: { type: "string", description: "Optional raw base64 image or data:image/...;base64,... URL" },
        media_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
        prompt: { type: "string", description: "What to inspect; defaults to a structured factual visual analysis" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "qwen_research",
    title: "Qwen Web Research",
    description:
      "Use Qwen3.7-Plus with real web search to research current facts for coding and document tasks. Returns a concise synthesis with source URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The research question, including any date or source constraints" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  try {
    if (name === "qwen_vision") {
      const text = await callQwenVision(
        args,
        args.prompt || "请对图片做结构化、忠实的视觉分析，并明确标注不确定内容。",
      );
      return { content: [{ type: "text", text }] };
    }
    if (name === "qwen_research") {
      if (!args.query) throw new Error("query is required.");
      const text = await runOpenCode("qwen-research", args.query);
      return { content: [{ type: "text", text }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const label = name === "qwen_research" ? "Qwen research" : "Qwen vision";
    return { content: [{ type: "text", text: `${label} failed: ${error.message}` }], isError: true };
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id === undefined) return;

  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "qwen-assistant", version: "1.0.1" },
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools };
    } else if (message.method === "tools/call") {
      result = await callTool(message.params?.name, message.params?.arguments || {});
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
  }
}

process.stdin.setEncoding("utf8");
let inputBuffer = "";
let queue = Promise.resolve();
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split(/\r?\n/);
  inputBuffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    queue = queue.then(() => handleMessage(JSON.parse(line))).catch((error) => {
      console.error(error);
    });
  }
});
