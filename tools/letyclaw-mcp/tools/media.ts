/**
 * Media tools — Image processing, image generation (DALL-E), text-to-speech (OpenAI TTS).
 *
 * Requires:
 *   - OPENAI_API_KEY for image_generate and tts
 *   - ImageMagick (convert) for image processing
 */
import { writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import type { MCPToolDefinition, MCPHandler, MCPResponse } from "../types.js";
import { ok, error } from "./_util.js";

const OPENAI_KEY = (): string => process.env.OPENAI_API_KEY || "";

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "image",
    description:
      "Process an image file — resize, convert format, get info. Uses ImageMagick. For image *analysis*, use Claude's built-in vision instead.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Path to input image" },
        output_path: { type: "string", description: "Path for output (optional, defaults to same dir)" },
        operation: {
          type: "string",
          enum: ["resize", "convert", "info", "compress"],
          description: "Operation to perform",
        },
        width: { type: "number", description: "Target width (for resize)" },
        height: { type: "number", description: "Target height (for resize)" },
        format: { type: "string", description: "Target format (for convert): jpg, png, webp" },
        quality: { type: "number", description: "Quality 1-100 (for compress, default: 80)" },
      },
      required: ["input_path", "operation"],
    },
  },
  {
    name: "image_generate",
    description:
      "Generate an image using DALL-E 3. Returns the image URL and saves to disk. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image generation prompt (be descriptive)" },
        size: {
          type: "string",
          enum: ["1024x1024", "1792x1024", "1024x1792"],
          description: "Image size (default: 1024x1024)",
        },
        quality: {
          type: "string",
          enum: ["standard", "hd"],
          description: "Quality (default: standard)",
        },
        save_path: { type: "string", description: "Path to save the image (optional)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "tts",
    description:
      "Convert text to speech using OpenAI TTS. Returns path to audio file. Requires OPENAI_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        voice: {
          type: "string",
          enum: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
          description: "Voice (default: nova)",
        },
        model: {
          type: "string",
          enum: ["tts-1", "tts-1-hd"],
          description: "TTS model (default: tts-1)",
        },
        speed: { type: "number", description: "Speed 0.25-4.0 (default: 1.0)" },
        output_path: { type: "string", description: "Output file path (default: /tmp/tts-{timestamp}.mp3)" },
      },
      required: ["text"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

export const handlers: Record<string, MCPHandler> = {
  async image(args: Record<string, unknown>): Promise<MCPResponse> {
    const input_path = args.input_path as string;
    const output_path = args.output_path as string | undefined;
    const operation = args.operation as string;
    const width = args.width as number | undefined;
    const height = args.height as number | undefined;
    const format = args.format as string | undefined;
    const quality = (args.quality as number | undefined) ?? 80;

    if (!existsSync(input_path)) return error(`File not found: ${input_path}`);

    switch (operation) {
      case "info": {
        try {
          const result = await runCmd("identify", ["-verbose", input_path]);
          return ok(result);
        } catch (err) {
          return error(`ImageMagick identify failed: ${(err as Error).message}. Is ImageMagick installed?`);
        }
      }

      case "resize": {
        if (!width && !height) return error("width and/or height required for resize");
        const size = width && height ? `${width}x${height}` : width ? `${width}x` : `x${height}`;
        const out = output_path || input_path.replace(/(\.\w+)$/, `-${size}$1`);
        try {
          await runCmd("convert", [input_path, "-resize", size, out]);
          return ok(JSON.stringify({ output: out, size }));
        } catch (err) {
          return error(`Resize failed: ${(err as Error).message}`);
        }
      }

      case "convert": {
        if (!format) return error("format required for convert");
        const out = output_path || input_path.replace(/\.\w+$/, `.${format}`);
        try {
          await runCmd("convert", [input_path, out]);
          return ok(JSON.stringify({ output: out, format }));
        } catch (err) {
          return error(`Convert failed: ${(err as Error).message}`);
        }
      }

      case "compress": {
        const out = output_path || input_path.replace(/(\.\w+)$/, `-compressed$1`);
        try {
          await runCmd("convert", [input_path, "-quality", String(quality), out]);
          return ok(JSON.stringify({ output: out, quality }));
        } catch (err) {
          return error(`Compress failed: ${(err as Error).message}`);
        }
      }

      default:
        return error(`Unknown operation: ${operation}`);
    }
  },

  async image_generate(args: Record<string, unknown>): Promise<MCPResponse> {
    const prompt = args.prompt as string;
    const size = (args.size as string | undefined) ?? "1024x1024";
    const quality = (args.quality as string | undefined) ?? "standard";
    const save_path = args.save_path as string | undefined;

    const apiKey = OPENAI_KEY();
    if (!apiKey) return error("OPENAI_API_KEY not set. Set it to use DALL-E image generation.");

    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt,
          n: 1,
          size,
          quality,
        }),
      });

      const data = await res.json() as unknown;
      const body = data as Record<string, unknown>;
      if (body.error) {
        const errObj = body.error as Record<string, unknown>;
        return error(`DALL-E API: ${errObj.message as string}`);
      }

      const dataArr = body.data as Array<Record<string, unknown>> | undefined;
      const imageUrl = dataArr?.[0]?.url as string | undefined;
      const revisedPrompt = dataArr?.[0]?.revised_prompt as string | undefined;
      if (!imageUrl) return error("No image URL in response");

      const result: Record<string, unknown> = { url: imageUrl, revised_prompt: revisedPrompt };

      // Optionally save to disk
      if (save_path) {
        try {
          const imgRes = await fetch(imageUrl);
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          writeFileSync(save_path, buffer);
          result.saved_to = save_path;
        } catch (err) {
          result.save_error = (err as Error).message;
        }
      }

      return ok(JSON.stringify(result, null, 2));
    } catch (err) {
      return error(`image_generate failed: ${(err as Error).message}`);
    }
  },

  async tts(args: Record<string, unknown>): Promise<MCPResponse> {
    const text = args.text as string;
    const voice = (args.voice as string | undefined) ?? "nova";
    const model = (args.model as string | undefined) ?? "tts-1";
    const speed = (args.speed as number | undefined) ?? 1.0;
    const output_path = args.output_path as string | undefined;

    const apiKey = OPENAI_KEY();
    if (!apiKey) return error("OPENAI_API_KEY not set. Set it to use OpenAI TTS.");

    if (!text) return error("text is required");
    if (text.length > 4096) return error("Text too long (max 4096 chars)");

    const outPath = output_path || `/tmp/tts-${Date.now()}.mp3`;

    try {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          speed,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as unknown;
        const errObj = errBody as Record<string, unknown>;
        const errInner = errObj.error as Record<string, unknown> | undefined;
        return error(`TTS API: ${(errInner?.message as string) || res.statusText}`);
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(outPath, buffer);

      return ok(JSON.stringify({
        output: outPath,
        voice,
        model,
        size_bytes: buffer.length,
        text_length: text.length,
      }, null, 2));
    } catch (err) {
      return error(`tts failed: ${(err as Error).message}`);
    }
  },
};

// ── Internal helpers ──────────────────────────────────────────────────

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
    child.on("error", reject);
    setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 30000);
  });
}
