// Output naming rules (pure, unit-tested):
//  - default: <name>_output.mp4 next to the source
//  - a trailing "_output" (stacked any number of times) is stripped first so
//    re-processing an output never produces name_output_output.mp4
//  - never returns the input path itself

export function splitPath(p: string): { dir: string; sep: string; file: string } {
  const sep = p.includes('\\') ? '\\' : '/'
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return {
    dir: idx >= 0 ? p.slice(0, idx) : '',
    sep,
    file: idx >= 0 ? p.slice(idx + 1) : p
  }
}

export function baseNameNoExt(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

export function stripOutputSuffix(base: string): string {
  const stripped = base.replace(/(?:_output)+$/i, '')
  return stripped.length > 0 ? stripped : base
}

export interface NamingOptions {
  template?: string // {name} placeholder
  outputFolder?: string | null
}

export function outputPathFor(inputPath: string, opts: NamingOptions = {}): string {
  const { dir, sep, file } = splitPath(inputPath)
  const name = stripOutputSuffix(baseNameNoExt(file))
  const template = opts.template && opts.template.includes('{name}') ? opts.template : '{name}_output'
  let outName = template.replace('{name}', name)
  // strip characters Windows can't have in filenames
  outName = outName.replace(/[<>:"/\\|?*]/g, '').trim() || `${name}_output`
  const folder = opts.outputFolder && opts.outputFolder.trim().length > 0 ? opts.outputFolder : dir
  const folderSep = folder.includes('\\') ? '\\' : sep
  const joined = folder ? folder.replace(/[\\/]+$/, '') + folderSep + outName + '.mp4' : outName + '.mp4'
  return joined
}
