# Feature Spec: Nano Banana Image Generation

## Overview

Add image generation capabilities to the Google Drive MCP server using Google's **Nano Banana** models (Gemini native image generation). This extends the MCP with tools to generate and edit images via prompts, with the option to save locally or upload directly to Google Drive.

---

## Models

| Model | API ID | Strengths |
|---|---|---|
| **Nano Banana 2** (default) | `gemini-3.1-flash-image-preview` | Fast, cheap ($0.045–$0.15/img), up to 4K, good for most use cases |
| **Nano Banana Pro** | `gemini-3-pro-image-preview` | "Thinking" mode, best text rendering, professional assets ($0.13–$0.24/img) |

Nano Banana 2 is the default. Users can opt into Pro per-request via a `model` parameter.

---

## Authentication

### Approach: Reuse existing OAuth2 client

The `generativelanguage.googleapis.com` endpoint supports OAuth2 Bearer tokens (not just API keys). The existing MCP OAuth2 client can be reused by:

1. Adding a new scope alias in `src/auth/scopes.ts`:
   ```
   'generative-language': 'https://www.googleapis.com/auth/generative-language'
   ```

2. Adding it to the `full` preset and `DEFAULT_SCOPES`.

3. The REST calls to the Gemini API will use the existing `authClient` to obtain an access token and send it as `Authorization: Bearer <token>`.

### One-time re-auth required

Users must re-authenticate once (`npm run auth`) after upgrading to grant the new scope. The `authListScopes` tool will surface missing scopes.

### Fallback: API key

If the user has a `GEMINI_API_KEY` environment variable set, the tools should prefer it (sent as `?key=` query parameter). This provides a simpler path for users who don't want to re-auth, and avoids potential `ACCESS_TOKEN_SCOPE_INSUFFICIENT` issues with OAuth.

**Priority order:**
1. `GEMINI_API_KEY` env var (if set) — simplest, most reliable
2. OAuth2 Bearer token from `authClient` — seamless if scope is granted

---

## API Details

### Endpoint

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

### Request body (text-to-image)

```json
{
  "contents": [
    {
      "parts": [
        { "text": "A watercolor painting of a sunset over mountains" }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {
      "aspectRatio": "16:9",
      "imageSize": "1K"
    }
  }
}
```

### Request body (image editing — send image + prompt)

```json
{
  "contents": [
    {
      "parts": [
        {
          "inlineData": {
            "mimeType": "image/png",
            "data": "<BASE64_SOURCE_IMAGE>"
          }
        },
        { "text": "Remove the background and replace it with a beach" }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
```

### Response format

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          { "text": "Here is the generated image..." },
          {
            "inlineData": {
              "mimeType": "image/png",
              "data": "<BASE64_IMAGE_DATA>"
            }
          }
        ]
      }
    }
  ]
}
```

---

## New Tools

### Tool 1: `generateImage`

Generate an image from a text prompt.

**Parameters:**

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | yes | — | Text description of the image to generate |
| `model` | enum | no | `"nano-banana-2"` | `"nano-banana-2"` or `"nano-banana-pro"` |
| `aspectRatio` | enum | no | `"1:1"` | One of: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9` |
| `resolution` | enum | no | `"1K"` | One of: `512`, `1K`, `2K`, `4K` |
| `saveTo` | enum | no | `"drive"` | `"drive"` (upload to Google Drive) or `"local"` (save to local disk) |
| `fileName` | string | no | auto-generated | Output file name (without extension, `.png` appended) |
| `driveFolderId` | string | no | root | Google Drive folder ID or path (e.g., `/AI/Generated`) — only used when `saveTo=drive` |
| `localPath` | string | no | system temp dir | Local directory to save to — only used when `saveTo=local` |

**Returns:**
- On `saveTo=drive`: Drive file ID, file name, web view link, and the model's text description
- On `saveTo=local`: Absolute local file path, file size, and the model's text description

**Example call:**
```json
{
  "prompt": "A minimalist logo for a coffee shop called Brew & Bean",
  "aspectRatio": "1:1",
  "resolution": "2K",
  "saveTo": "drive",
  "driveFolderId": "/Design/Logos"
}
```

---

### Tool 2: `editImage`

Edit an existing image using a text prompt (style transfer, background removal, modifications, etc.).

**Parameters:**

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string | yes | — | Edit instruction (e.g., "Make the sky purple") |
| `sourceImagePath` | string | conditional | — | Local file path to the source image (provide this OR `sourceDriveFileId`) |
| `sourceDriveFileId` | string | conditional | — | Google Drive file ID of the source image (provide this OR `sourceImagePath`) |
| `model` | enum | no | `"nano-banana-2"` | `"nano-banana-2"` or `"nano-banana-pro"` |
| `aspectRatio` | enum | no | (preserve original) | Override aspect ratio |
| `resolution` | enum | no | `"1K"` | Output resolution |
| `saveTo` | enum | no | `"drive"` | `"drive"` or `"local"` |
| `fileName` | string | no | auto-generated | Output file name |
| `driveFolderId` | string | no | root | Drive folder for output |
| `localPath` | string | no | system temp dir | Local directory for output |

**Source image handling:**
- If `sourceImagePath` is given: read the local file, base64-encode it
- If `sourceDriveFileId` is given: download from Drive via the existing Drive API, base64-encode it
- Supported input formats: PNG, JPEG, WebP, GIF
- Max input size: 20MB (Gemini API limit)

**Returns:** Same structure as `generateImage`.

**Example call:**
```json
{
  "prompt": "Change the background to a tropical beach at sunset",
  "sourceDriveFileId": "1abc2def3ghi",
  "saveTo": "drive",
  "driveFolderId": "/Design/Edited"
}
```

---

## File Structure

### New file: `src/tools/imagen.ts`

Follows the exact same pattern as other tool modules:

```
src/tools/imagen.ts
├── Zod schemas (GenerateImageSchema, EditImageSchema)
├── Constants (MODEL_MAP, ASPECT_RATIOS, RESOLUTIONS, API_BASE_URL)
├── Helper: callGeminiImageApi(authClient, model, contents, generationConfig)
├── Helper: saveImageResult(base64Data, mimeType, options, ctx)
├── export const toolDefinitions: ToolDefinition[]
└── export async function handleTool(name, args, ctx): Promise<ToolResult | null>
```

### Modified files

| File | Change |
|---|---|
| `src/auth/scopes.ts` | Add `'generative-language'` scope alias, add to `full` preset and `DEFAULT_SCOPES` |
| `src/index.ts` | Import `imagenTools` from `./tools/imagen.js`, add to `domainModules` array |
| `src/types.ts` | No changes needed — existing `ToolContext` already has `authClient`, `getDrive`, `resolveFolderId`, `log` |
| `package.json` | No new dependencies needed — uses `fetch` (Node 18+ built-in) for REST calls |

---

## Implementation Details

### Gemini API caller (`callGeminiImageApi`)

```typescript
async function callGeminiImageApi(
  authClient: any,
  model: string,
  contents: any[],
  generationConfig: any,
): Promise<{ text?: string; imageData?: string; mimeType?: string }>
```

1. Resolve auth: check `GEMINI_API_KEY` env var first, then fall back to `authClient.getAccessToken()`
2. Build URL: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
3. If API key: append `?key=${apiKey}` to URL
4. If OAuth: set `Authorization: Bearer ${token}` and `x-goog-user-project` headers
5. POST the request body with `Content-Type: application/json`
6. Parse response: extract `text` parts and `inlineData` parts from `candidates[0].content.parts`
7. Return the text description and base64 image data

### Image saver (`saveImageResult`)

```typescript
async function saveImageResult(
  base64Data: string,
  mimeType: string,
  options: { saveTo: string; fileName?: string; driveFolderId?: string; localPath?: string },
  ctx: ToolContext,
): Promise<{ location: string; fileId?: string; filePath?: string; webViewLink?: string }>
```

**For `saveTo=drive`:**
1. Resolve folder via `ctx.resolveFolderId(driveFolderId)`
2. Convert base64 to Buffer, create a readable stream
3. Use `ctx.getDrive().files.create()` with `media: { mimeType, body: stream }` and `requestBody: { name, parents: [folderId] }`
4. Return file ID, name, and web view link

**For `saveTo=local`:**
1. Resolve directory (use provided `localPath` or `os.tmpdir()`)
2. Write base64 decoded Buffer to `${dir}/${fileName}.png`
3. Return absolute file path and file size

### File naming

Auto-generated names follow the pattern: `generated_{timestamp}.png` (e.g., `generated_20260512_143022.png`) to avoid collisions. Users can override via `fileName`.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| No auth (no API key, no OAuth token) | Return error: "No Gemini API credentials. Set GEMINI_API_KEY env var or re-authenticate with `npm run auth` to grant generative-language scope." |
| API returns 403 / scope insufficient | Return error with clear message to set `GEMINI_API_KEY` or re-auth |
| API returns safety block (content filtered) | Return error: "Image generation blocked by safety filters. Try rephrasing your prompt." with the safety ratings from the response |
| API returns no image in response | Return error: "Model returned text only, no image was generated. Try a more descriptive prompt." |
| Source image too large (>20MB) | Return error before API call: "Source image exceeds 20MB limit." |
| Source image format unsupported | Return error: "Unsupported image format. Use PNG, JPEG, WebP, or GIF." |
| Drive upload fails | Return error from Drive API with context |
| Local save fails (permissions, disk) | Return error with path and OS error |

---

## Scope of v1 (this PR)

### In scope
- `generateImage` tool — text-to-image generation
- `editImage` tool — image editing with source image + prompt
- Both `saveTo=drive` and `saveTo=local` output modes
- Nano Banana 2 and Nano Banana Pro model support
- API key and OAuth2 auth paths
- Aspect ratio and resolution configuration
- Auto-naming with timestamp

### Out of scope (future)
- Multi-turn conversational image editing (session memory)
- Batch generation (multiple images per prompt)
- `generateAndInsertImage` (direct insertion into Docs/Slides) — can be composed by chaining existing tools
- Imagen 4 models (different API surface, text-to-image only)
- Image-to-text / image analysis (already handled by the LLM client itself)
- Style transfer from reference images (multi-image input)
- Streaming / progress callbacks

---

## Testing Plan

### Unit tests (`test/imagen.test.ts`)
- Schema validation: valid/invalid params for both tools
- File naming: auto-generated name format, custom name handling
- Auth resolution: API key preferred over OAuth, error when neither available

### Integration tests (`test/integration/imagen.test.ts`)
- `generateImage` with `saveTo=local` — verify file exists on disk, is valid PNG
- `generateImage` with `saveTo=drive` — verify file appears in Drive
- `editImage` with local source image
- `editImage` with Drive source image
- Error cases: bad prompt (safety filter), missing source image

### Schema tests (`test/schema/imagen-schema.test.ts`)
- All tool definitions have valid JSON schemas
- Required fields enforced
- Enum values match API-supported values

---

## Configuration

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | no | Google AI API key. If set, preferred over OAuth for Gemini calls. |
| `GOOGLE_DRIVE_MCP_SCOPES` | no | Existing. Add `generative-language` to include the new scope. |

No new env vars are strictly required — OAuth works if the scope is granted, and API key is optional.

---

## Migration / Breaking Changes

**None.** This is purely additive:
- New tools are added; existing tools are untouched
- The new scope is added to defaults, but existing tokens continue working for Drive/Docs/Sheets/Slides/Calendar
- Users who don't use image generation are unaffected
- Users who want image generation either set `GEMINI_API_KEY` or re-run `npm run auth`
