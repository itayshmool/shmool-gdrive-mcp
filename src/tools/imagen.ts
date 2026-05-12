import { z } from 'zod';
import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { Readable } from 'stream';
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js';
import { errorResponse } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MODEL_MAP: Record<string, string> = {
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'nano-banana-pro': 'gemini-3-pro-image-preview',
};

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'] as const;
const RESOLUTIONS = ['512', '1K', '2K', '4K'] as const;
const MODELS = ['nano-banana-2', 'nano-banana-pro'] as const;
const SAVE_TARGETS = ['drive', 'local'] as const;
const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_SOURCE_SIZE = 20 * 1024 * 1024; // 20MB

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const GenerateImageSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  model: z.enum(MODELS).optional().default('nano-banana-2'),
  aspectRatio: z.enum(ASPECT_RATIOS).optional().default('1:1'),
  resolution: z.enum(RESOLUTIONS).optional().default('1K'),
  saveTo: z.enum(SAVE_TARGETS).optional().default('drive'),
  fileName: z.string().optional(),
  driveFolderId: z.string().optional(),
  localPath: z.string().optional(),
});

const EditImageSchema = z.object({
  prompt: z.string().min(1, 'Edit instruction is required'),
  sourceImagePath: z.string().optional(),
  sourceDriveFileId: z.string().optional(),
  model: z.enum(MODELS).optional().default('nano-banana-2'),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  resolution: z.enum(RESOLUTIONS).optional().default('1K'),
  saveTo: z.enum(SAVE_TARGETS).optional().default('drive'),
  fileName: z.string().optional(),
  driveFolderId: z.string().optional(),
  localPath: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateFileName(prefix: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\..+/, '').slice(0, 15);
  return `${prefix}_${ts}`;
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '.png';
  }
}

function extToMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/png';
  }
}

async function getAuthHeaders(authClient: any): Promise<{ headers: Record<string, string>; urlSuffix: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (apiKey) {
    return {
      headers: { 'Content-Type': 'application/json' },
      urlSuffix: `?key=${apiKey}`,
    };
  }

  const tokenRes = await authClient.getAccessToken();
  const token = tokenRes?.token || tokenRes?.res?.data?.access_token;
  if (!token) {
    throw new Error(
      'No Gemini API credentials available. Set GEMINI_API_KEY env var or re-authenticate (npm run auth) to grant the generative-language scope.',
    );
  }

  return {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    urlSuffix: '',
  };
}

interface GeminiImageResult {
  text?: string;
  imageData: string;
  mimeType: string;
}

async function callGeminiImageApi(
  authClient: any,
  model: string,
  contents: unknown[],
  generationConfig: unknown,
  log: ToolContext['log'],
): Promise<GeminiImageResult> {
  const modelId = MODEL_MAP[model] || model;
  const { headers, urlSuffix } = await getAuthHeaders(authClient);
  const url = `${API_BASE}/${modelId}:generateContent${urlSuffix}`;

  log('Calling Gemini image API', { model: modelId });

  const body = JSON.stringify({ contents, generationConfig });
  const response = await fetch(url, { method: 'POST', headers, body });

  if (!response.ok) {
    const errorText = await response.text();
    let detail: string;
    try {
      const parsed = JSON.parse(errorText);
      detail = parsed.error?.message || errorText;
    } catch {
      detail = errorText;
    }
    throw new Error(`Gemini API error (${response.status}): ${detail}`);
  }

  const data = await response.json() as any;

  // Check for safety blocks
  if (data.candidates?.[0]?.finishReason === 'SAFETY') {
    const ratings = data.candidates[0].safetyRatings
      ?.map((r: any) => `${r.category}: ${r.probability}`)
      .join(', ');
    throw new Error(`Image generation blocked by safety filters. ${ratings ? `Ratings: ${ratings}` : 'Try rephrasing your prompt.'}`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error('Gemini API returned an empty response. Try a more descriptive prompt.');
  }

  let text: string | undefined;
  let imageData: string | undefined;
  let mimeType = 'image/png';

  for (const part of parts) {
    if (part.text) {
      text = part.text;
    }
    if (part.inlineData) {
      imageData = part.inlineData.data;
      mimeType = part.inlineData.mimeType || 'image/png';
    }
  }

  if (!imageData) {
    throw new Error('Model returned text only — no image was generated. Try a more descriptive or visual prompt.');
  }

  return { text, imageData, mimeType };
}

interface SaveOptions {
  saveTo: string;
  fileName?: string;
  driveFolderId?: string;
  localPath?: string;
}

async function saveImageResult(
  imageData: string,
  mimeType: string,
  options: SaveOptions,
  ctx: ToolContext,
): Promise<{ text: string; fileId?: string; filePath?: string }> {
  const baseName = options.fileName || generateFileName('generated');
  const ext = mimeToExt(mimeType);
  const fullName = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;
  const buffer = Buffer.from(imageData, 'base64');

  if (options.saveTo === 'local') {
    const dir = options.localPath || tmpdir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const filePath = join(dir, fullName);
    await writeFile(filePath, buffer);
    ctx.log('Image saved locally', { path: filePath, size: buffer.length });

    return {
      text: `Image saved locally:\n- Path: ${filePath}\n- Size: ${(buffer.length / 1024).toFixed(1)} KB\n- Format: ${mimeType}`,
      filePath,
    };
  }

  // saveTo === 'drive'
  const folderId = await ctx.resolveFolderId(options.driveFolderId);
  const stream = Readable.from(buffer);

  const driveRes = await ctx.getDrive().files.create({
    requestBody: {
      name: fullName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,
  });

  const fileId = driveRes.data.id || '';
  const webViewLink = driveRes.data.webViewLink || '';
  ctx.log('Image uploaded to Drive', { fileId, name: driveRes.data.name });

  return {
    text: `Image uploaded to Google Drive:\n- File ID: ${fileId}\n- Name: ${driveRes.data.name}\n- Link: ${webViewLink}\n- Size: ${(buffer.length / 1024).toFixed(1)} KB\n- Format: ${mimeType}`,
    fileId,
  };
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt using Google Gemini Nano Banana models. Supports multiple aspect ratios, resolutions, and can save to Google Drive or locally.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        model: {
          type: 'string',
          enum: [...MODELS],
          description: 'Model to use: nano-banana-2 (fast, default) or nano-banana-pro (high fidelity, better text rendering)',
        },
        aspectRatio: {
          type: 'string',
          enum: [...ASPECT_RATIOS],
          description: 'Image aspect ratio (default: 1:1)',
        },
        resolution: {
          type: 'string',
          enum: [...RESOLUTIONS],
          description: 'Output resolution: 512, 1K, 2K, or 4K (default: 1K)',
        },
        saveTo: {
          type: 'string',
          enum: [...SAVE_TARGETS],
          description: 'Save to Google Drive or locally (default: drive)',
        },
        fileName: { type: 'string', description: 'Output file name (without extension, auto-generated if omitted)' },
        driveFolderId: {
          type: 'string',
          description: 'Google Drive folder ID or path (e.g., /AI/Generated) — used when saveTo=drive',
        },
        localPath: {
          type: 'string',
          description: 'Local directory to save to — used when saveTo=local',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'editImage',
    description:
      'Edit an existing image using a text prompt via Google Gemini Nano Banana models. Provide a source image (local path or Drive file ID) and an edit instruction. Supports style transfer, background removal, modifications, and more.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Edit instruction (e.g., "Remove the background", "Make it look like a watercolor painting")' },
        sourceImagePath: { type: 'string', description: 'Local file path to the source image (provide this OR sourceDriveFileId)' },
        sourceDriveFileId: { type: 'string', description: 'Google Drive file ID of the source image (provide this OR sourceImagePath)' },
        model: {
          type: 'string',
          enum: [...MODELS],
          description: 'Model to use: nano-banana-2 (fast, default) or nano-banana-pro (high fidelity)',
        },
        aspectRatio: {
          type: 'string',
          enum: [...ASPECT_RATIOS],
          description: 'Override aspect ratio (omit to preserve original)',
        },
        resolution: {
          type: 'string',
          enum: [...RESOLUTIONS],
          description: 'Output resolution (default: 1K)',
        },
        saveTo: {
          type: 'string',
          enum: [...SAVE_TARGETS],
          description: 'Save to Google Drive or locally (default: drive)',
        },
        fileName: { type: 'string', description: 'Output file name (without extension)' },
        driveFolderId: {
          type: 'string',
          description: 'Google Drive folder ID or path for output — used when saveTo=drive',
        },
        localPath: {
          type: 'string',
          description: 'Local directory to save output to — used when saveTo=local',
        },
      },
      required: ['prompt'],
    },
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (toolName) {
    case 'generateImage': {
      const validation = GenerateImageSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;

      const contents = [{ parts: [{ text: parsed.prompt }] }];
      const generationConfig: any = {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: parsed.aspectRatio,
          imageSize: parsed.resolution,
        },
      };

      const result = await callGeminiImageApi(ctx.authClient, parsed.model, contents, generationConfig, ctx.log);

      const saved = await saveImageResult(result.imageData, result.mimeType, {
        saveTo: parsed.saveTo,
        fileName: parsed.fileName,
        driveFolderId: parsed.driveFolderId,
        localPath: parsed.localPath,
      }, ctx);

      const textParts = [saved.text];
      if (result.text) {
        textParts.push(`\nModel description: ${result.text}`);
      }

      return {
        content: [{ type: 'text', text: textParts.join('\n') }],
        isError: false,
      };
    }

    case 'editImage': {
      const validation = EditImageSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const parsed = validation.data;

      if (!parsed.sourceImagePath && !parsed.sourceDriveFileId) {
        return errorResponse('Provide either sourceImagePath (local file) or sourceDriveFileId (Drive file).');
      }

      // Load source image
      let sourceBase64: string;
      let sourceMimeType: string;

      if (parsed.sourceImagePath) {
        if (!existsSync(parsed.sourceImagePath)) {
          return errorResponse(`Source image not found: ${parsed.sourceImagePath}`);
        }
        const fileBuffer = await readFile(parsed.sourceImagePath);
        if (fileBuffer.length > MAX_SOURCE_SIZE) {
          return errorResponse(`Source image exceeds 20MB limit (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB).`);
        }
        sourceMimeType = extToMime(parsed.sourceImagePath);
        if (!SUPPORTED_IMAGE_TYPES.includes(sourceMimeType)) {
          return errorResponse(`Unsupported image format. Use PNG, JPEG, WebP, or GIF.`);
        }
        sourceBase64 = fileBuffer.toString('base64');
      } else {
        // Download from Drive
        ctx.log('Downloading source image from Drive', { fileId: parsed.sourceDriveFileId });
        const driveRes = await ctx.getDrive().files.get(
          { fileId: parsed.sourceDriveFileId!, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer' },
        );
        const buf = Buffer.from(driveRes.data as ArrayBuffer);
        if (buf.length > MAX_SOURCE_SIZE) {
          return errorResponse(`Source image exceeds 20MB limit (${(buf.length / 1024 / 1024).toFixed(1)}MB).`);
        }
        // Get the file metadata for mime type
        const metaRes = await ctx.getDrive().files.get({
          fileId: parsed.sourceDriveFileId!,
          fields: 'mimeType',
          supportsAllDrives: true,
        });
        sourceMimeType = metaRes.data.mimeType || 'image/png';
        if (!SUPPORTED_IMAGE_TYPES.includes(sourceMimeType)) {
          return errorResponse(`Unsupported image format (${sourceMimeType}). Use PNG, JPEG, WebP, or GIF.`);
        }
        sourceBase64 = buf.toString('base64');
      }

      const contents = [
        {
          parts: [
            { inlineData: { mimeType: sourceMimeType, data: sourceBase64 } },
            { text: parsed.prompt },
          ],
        },
      ];

      const generationConfig: any = {
        responseModalities: ['TEXT', 'IMAGE'],
      };
      if (parsed.aspectRatio || parsed.resolution) {
        generationConfig.imageConfig = {
          ...(parsed.aspectRatio && { aspectRatio: parsed.aspectRatio }),
          ...(parsed.resolution && { imageSize: parsed.resolution }),
        };
      }

      const result = await callGeminiImageApi(ctx.authClient, parsed.model, contents, generationConfig, ctx.log);

      const saved = await saveImageResult(result.imageData, result.mimeType, {
        saveTo: parsed.saveTo,
        fileName: parsed.fileName || generateFileName('edited'),
        driveFolderId: parsed.driveFolderId,
        localPath: parsed.localPath,
      }, ctx);

      const textParts = [saved.text];
      if (result.text) {
        textParts.push(`\nModel description: ${result.text}`);
      }

      return {
        content: [{ type: 'text', text: textParts.join('\n') }],
        isError: false,
      };
    }

    default:
      return null;
  }
}
