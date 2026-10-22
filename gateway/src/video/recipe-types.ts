// The parameters a video recipe accepts. A recipe declares them; the page and Dave can only
// fill them in, never change the graph a recipe builds.

export type ParamSpec =
  | { kind: 'text'; maxLength: number; required?: boolean; default?: string }
  | { kind: 'int'; min: number; max: number; default?: number }
  | { kind: 'choice'; options: readonly string[]; default?: string }
  // An input image already uploaded to Mission Control, named by its 32-hex-digit id.
  | { kind: 'image'; required?: boolean }

export type RecipeParams = Readonly<Record<string, ParamSpec>>

export type ParamValues = Record<string, string | number>

export type ParamResult =
  | { ok: true; values: ParamValues }
  | { ok: false; errors: string[] }
