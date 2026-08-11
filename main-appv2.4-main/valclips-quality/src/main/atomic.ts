import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

// Atomic write discipline: all outputs (encodes, settings, downloads) are written
// to a hidden temp name in the destination folder, then renamed into place.
// A crash mid-write can never leave a half-written file under the final name,
// and sources are never opened for writing at all.

export function tempPathFor(target: string): string {
  const dir = path.dirname(target)
  const base = path.basename(target)
  return path.join(dir, `.${base}.tmp-${randomBytes(4).toString('hex')}`)
}

export async function atomicWriteFile(target: string, data: string | Buffer): Promise<void> {
  const tmp = tempPathFor(target)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(tmp, data)
  await commitTemp(tmp, target)
}

/** Rename temp onto target, replacing it. Falls back to copy+delete across devices. */
export async function commitTemp(tmp: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(tmp, target)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EXDEV' || code === 'EPERM') {
      await fs.promises.copyFile(tmp, target)
      await fs.promises.unlink(tmp).catch(() => {})
    } else {
      await fs.promises.unlink(tmp).catch(() => {})
      throw err
    }
  }
}

/** Remove a temp/partial file, never throwing. Used on every failure path. */
export async function discardTemp(tmp: string | null | undefined): Promise<void> {
  if (!tmp) return
  await fs.promises.unlink(tmp).catch(() => {})
}
