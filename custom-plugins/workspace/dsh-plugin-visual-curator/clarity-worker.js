// src/media/clarity-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import * as ort from "onnxruntime-web/wasm";
import { z as z3 } from "zod";

// src/shared/clarity.ts
import { z } from "zod";
var claritySettingsSchema = z.strictObject({
  version: z.literal("espcn-luma-v1").default("espcn-luma-v1"),
  enabled: z.boolean().default(true),
  maxSubjectPixels: z.number().int().min(4096).max(2e6).default(8e5),
  timeoutMs: z.number().int().min(1e3).max(12e4).default(3e4),
  blend: z.number().positive().max(0.5).default(0.35),
  featherPixels: z.number().int().min(1).max(32).default(8)
});
var clarityStateSchema = z.strictObject({
  status: z.enum(["pending", "not-needed", "enhancing", "reviewing", "passed", "needs-review", "failed"]),
  reason: z.string(),
  originalOutputId: z.string().optional(),
  enhancedOutputId: z.string().optional(),
  model: z.literal("espcn-x3-luma").optional(),
  modelSha256: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  pixels: z.number().int().nonnegative().optional(),
  tiles: z.number().int().nonnegative().optional(),
  changedPixels: z.number().int().nonnegative().optional()
});

// src/shared/background-resolution.ts
import { z as z2 } from "zod";
var backgroundResolutionSettingsSchema = z2.strictObject({
  version: z2.literal("espcn-background-v1").default("espcn-background-v1"),
  enabled: z2.boolean().default(true),
  maxInputPixels: z2.number().int().min(4096).max(2e6).default(2e6),
  timeoutMs: z2.number().int().min(1e3).max(12e4).default(12e4)
});
var dimensions = z2.strictObject({ width: z2.number().int().positive(), height: z2.number().int().positive() });
var backgroundResolutionStateSchema = z2.strictObject({
  status: z2.enum(["enhancing", "reviewing", "passed", "needs-review", "failed"]),
  reason: z2.string(),
  input: dimensions.extend({ digest: z2.string() }),
  originalId: z2.string().optional(),
  enhancedId: z2.string().optional(),
  output: dimensions.optional(),
  model: z2.literal("espcn-x3-luma").optional(),
  modelSha256: z2.string().optional(),
  durationMs: z2.number().nonnegative().optional(),
  pixels: z2.number().int().positive().optional(),
  tiles: z2.number().int().positive().optional()
});

// src/media/clarity-worker.ts
var pixelRect = z3.strictObject({ left: z3.number().int().nonnegative(), top: z3.number().int().nonnegative(), width: z3.number().int().positive(), height: z3.number().int().positive() });
var common = { bytes: z3.instanceof(Uint8Array), modelPath: z3.string(), maxPixels: z3.number().int().positive() };
var taskSchema = z3.discriminatedUnion("kind", [
  z3.strictObject({ ...common, kind: z3.literal("subject"), regions: z3.array(pixelRect).min(1).max(32), protectedRegions: z3.array(pixelRect).max(32), policy: claritySettingsSchema }),
  z3.strictObject({ ...common, kind: z3.literal("background"), width: z3.number().int().positive(), height: z3.number().int().positive(), policy: backgroundResolutionSettingsSchema })
]);
var modelDigest = "85f36ff88cc504a24af5e0602148bc56a8aa09a58eca8c0da2756f3e8186035e";
var tile = 224;
var halo = 8;
var core = tile - 2 * halo;
var scale = 3;
async function resolveRgb(rgb, width, height, session) {
  const resolved = Buffer.alloc(width * scale * height * scale * 3);
  const interpolated = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(width * scale, height * scale, { kernel: "cubic" }).raw().toBuffer();
  let tiles = 0;
  for (let top = 0; top < height; top += core) for (let left = 0; left < width; left += core) {
    const input = new Float32Array(tile * tile);
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const i = (Math.max(0, Math.min(height - 1, top + y - halo)) * width + Math.max(0, Math.min(width - 1, left + x - halo))) * 3;
      input[y * tile + x] = (rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114) / 255;
    }
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 1, tile, tile]) });
    const values = result[session.outputNames[0]];
    if (values.type !== "float32" || values.dims.join(",") !== "1,1,672,672") throw new Error("clarity-model-output-invalid");
    const luma = values.data;
    if (!(luma instanceof Float32Array)) throw new Error("clarity-model-output-invalid");
    for (let y = 0; y < Math.min(core, height - top) * scale; y++) for (let x = 0; x < Math.min(core, width - left) * scale; x++) {
      const at = ((top * scale + y) * width * scale + left * scale + x) * 3;
      const value = luma[(y + halo * scale) * tile * scale + x + halo * scale];
      if (!Number.isFinite(value)) throw new Error("clarity-model-output-invalid");
      const old = interpolated[at] * 0.299 + interpolated[at + 1] * 0.587 + interpolated[at + 2] * 0.114;
      const delta = Math.max(0, Math.min(255, value * 255)) - old;
      for (let c = 0; c < 3; c++) resolved[at + c] = Math.max(0, Math.min(255, Math.round(interpolated[at + c] + delta)));
    }
    values.dispose();
    tiles++;
  }
  return { resolved, tiles };
}
async function run() {
  const task = taskSchema.parse(workerData), started = performance.now();
  let pixels;
  if (task.kind === "subject") {
    pixels = task.regions.reduce((total, rect) => total + rect.width * rect.height, 0);
    if (pixels > task.policy.maxSubjectPixels) throw new Error("clarity-region-budget-exceeded");
  } else {
    if (!task.policy.enabled) throw new Error("background-resolution-disabled");
    if (task.width * task.height > task.maxPixels) throw new Error("background-resolution-output-budget-exceeded");
    const metadata = await sharp(task.bytes, { limitInputPixels: task.maxPixels }).metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("background-resolution-input-invalid");
    pixels = metadata.width * metadata.height;
    if (pixels > task.policy.maxInputPixels) throw new Error("background-resolution-input-budget-exceeded");
    if (pixels * scale * scale > task.maxPixels) throw new Error("background-resolution-intermediate-budget-exceeded");
    if (task.width > metadata.width * scale || task.height > metadata.height * scale) throw new Error("background-resolution-scale-exceeded");
    if (Math.abs(metadata.width - metadata.height * task.width / task.height) > 1) throw new Error("background-resolution-ratio-mismatch");
  }
  const model = await readFile(task.modelPath);
  if (createHash("sha256").update(model).digest("hex") !== modelDigest) throw new Error("clarity-model-digest-mismatch");
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], logSeverityLevel: 3 });
  try {
    const decoded = await sharp(task.bytes, { limitInputPixels: task.maxPixels }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const { width, height } = decoded.info;
    if (task.kind === "background") {
      const { resolved, tiles: tiles2 } = await resolveRgb(decoded.data, width, height, session);
      const image2 = await sharp(resolved, { raw: { width: width * scale, height: height * scale, channels: 3 } }).resize(task.width, task.height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
      return { bytes: image2, model: "espcn-x3-luma", modelSha256: modelDigest, durationMs: performance.now() - started, pixels, tiles: tiles2, sourceWidth: width, sourceHeight: height, outputWidth: task.width, outputHeight: task.height };
    }
    for (const rect of [...task.regions, ...task.protectedRegions]) if (rect.left + rect.width > width || rect.top + rect.height > height) throw new Error("clarity-region-outside-image");
    const output = Buffer.from(decoded.data), touched = new Uint8Array(width * height);
    let tiles = 0;
    for (const rect of task.regions) {
      const rgb = await sharp(decoded.data, { raw: { width, height, channels: 3 } }).extract(rect).raw().toBuffer();
      const resolution = await resolveRgb(rgb, rect.width, rect.height, session), resolved = resolution.resolved;
      tiles += resolution.tiles;
      const sampled = await sharp(resolved, { raw: { width: rect.width * scale, height: rect.height * scale, channels: 3 } }).resize(rect.width, rect.height, { kernel: "lanczos3" }).raw().toBuffer();
      for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
        const global = (rect.top + y) * width + rect.left + x;
        if (touched[global]) continue;
        touched[global] = 1;
        const weight = task.policy.blend * Math.min(1, Math.min(x, y, rect.width - 1 - x, rect.height - 1 - y) / task.policy.featherPixels);
        for (let c = 0; c < 3; c++) output[global * 3 + c] = Math.round(decoded.data[global * 3 + c] * (1 - weight) + sampled[(y * rect.width + x) * 3 + c] * weight);
      }
    }
    for (const rect of task.protectedRegions) for (let y = rect.top; y < rect.top + rect.height; y++) {
      const start = (y * width + rect.left) * 3, end = start + rect.width * 3;
      decoded.data.copy(output, start, start, end);
    }
    let changedPixels = 0;
    for (let index = 0; index < width * height; index++) if (touched[index] && (output[index * 3] !== decoded.data[index * 3] || output[index * 3 + 1] !== decoded.data[index * 3 + 1] || output[index * 3 + 2] !== decoded.data[index * 3 + 2])) changedPixels++;
    const image = await sharp(output, { raw: { width, height, channels: 3 } }).png().toBuffer();
    return { bytes: image, model: "espcn-x3-luma", modelSha256: modelDigest, durationMs: performance.now() - started, pixels, tiles, changedPixels };
  } finally {
    await session.release();
  }
}
void run().then((result) => {
  parentPort.postMessage({ ok: true, ...result });
  parentPort.close();
}, (error) => {
  parentPort.postMessage({ ok: false, code: error instanceof Error ? error.message : "clarity-processing-failed" });
  parentPort.close();
});
