// Input formats the app accepts. Everything else is rejected with a friendly message.

export const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'] as const

export function extensionOf(pathOrName: string): string {
  const file = pathOrName.split(/[\\/]/).pop() ?? ''
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(dot).toLowerCase() : ''
}

export function isSupportedVideo(pathOrName: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(pathOrName))
}

export function supportedListHuman(): string {
  return SUPPORTED_EXTENSIONS.join(', ')
}
