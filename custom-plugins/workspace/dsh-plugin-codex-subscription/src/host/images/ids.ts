/** Nominal identifiers are admitted explicitly from untrusted JSON and URL strings. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { ImageServiceError } from './errors.ts'

/** One durable image task; unrelated task, asset and account identifiers are not interchangeable. */
export type ImageTaskId = Branded<'CodexImageTaskId'>
/** One generated asset within an image task. */
export type ImageAssetId = Branded<'CodexImageAssetId'>

/** Admit one task identifier from the public JSON projection.
 * @param value JSON or URL task identifier.
 * @returns Validated nominal task identifier.
 */
export function parseImageTaskId(value: string): ImageTaskId { validate(value); return brandString<ImageTaskId>(value) }

/** Admit one image-asset identifier from the public JSON projection.
 * @param value JSON or URL image-asset identifier.
 * @returns Validated nominal asset identifier.
 */
export function parseImageAssetId(value: string): ImageAssetId { validate(value); return brandString<ImageAssetId>(value) }

function validate(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new ImageServiceError('invalid-image-id', 'An image identifier is invalid.')
}
