/** Local image selection checks; the Host still validates and decodes admitted image bytes. */
import { imageRefSchema } from '../shared/model.ts'

/** Import limits read from the active profile, shared by file selection and drop handling. */
export interface ImageImportLimits {
  maxImages: number
  maxImageBytes: number
  maxUploadBytes: number
}

/** In-place feedback for a rejected batch; existing selected files remain intact. */
export type ImportIssue = 'no-files' | 'unsupported' | 'empty-file' | 'count' | 'file-size' | 'batch-size'

/** Native file-picker filter derived from the same media types accepted by the Host. */
export const acceptedImageTypes = imageRefSchema.shape.mediaType.options.join(',')

/** Check a complete incoming batch before replacing the current selection.
 * @param files Browser-supplied file metadata; no image bytes are uploaded here.
 * @param limits Current profile limits.
 * @returns A rejection reason, or null when every file is eligible for local preview.
 */
export function validateImageSelection(files: readonly Pick<File, 'size' | 'type'>[], limits: ImageImportLimits): ImportIssue | null {
  if (!files.length) return 'no-files'
  if (files.length > limits.maxImages) return 'count'
  if (files.some(file => !imageRefSchema.shape.mediaType.safeParse(file.type).success)) return 'unsupported'
  if (files.some(file => file.size === 0)) return 'empty-file'
  if (files.some(file => file.size > limits.maxImageBytes)) return 'file-size'
  if (files.reduce((total, file) => total + file.size, 0) > limits.maxUploadBytes) return 'batch-size'
  return null
}
