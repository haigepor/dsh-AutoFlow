/** Metadata for the verified embedded startup video. */
import clip from './clip.json' with { type: 'json' }

/** The selected video's byte count, compact digest, and encoded length. */
export const CLIPS = [{
  ...clip,
  ext: '.mp4',
  sha256: clip.sha256.slice(0, 16),
  b64: Math.ceil(clip.bytes / 3) * 4,
}]
