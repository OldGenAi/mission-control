// Every prompt the Storyboard sends to ComfyUI, built from fixed sentences and a film's checked fields (storyboard
// spec 6.3). The sentences are the ones that worked for the hand-made red door films (local-video RECIPE.md) and hand
// tests T6, T2 and T8: remove then add, never "move"; one character added per edit, each with its own position, the
// ones before kept and "exactly N" counting everyone so far; the cast wording word for word; and only positive words
// in a video prompt, because the fast video model runs at CFG 1 and reads "no tan" as "tan".
//
// Security-sensitive. Do not modify without Claude review.
//
// Fields arrive already checked (lengths, no control characters). Here every field is also flattened to one line and
// loses any "#" or "*", so it can't forge a "### ..." section or a "**...:**" label of the Ingredients prompt, and
// "embedding:" is broken up, because ComfyUI's text encoders read "embedding:name" as "load this file".

export type FilmLook = 'realistic' | 'cartoon'

/** A character as the wording uses it; `kind` is one word for what it is ("dog", "man"), for the "exactly" counts. */
export interface FilmCast { name: string; wording: string; kind?: string | null | undefined }
export interface FilmPlace { name: string; description: string; keep: string; prop?: string | null | undefined }
export interface ShotCharacter { cast: FilmCast; startPose: string; endPose: string }
export interface FilmShot { action: string; closeUp: boolean; characters: ShotCharacter[] }
/** A character being added to a pose picture: its kind is known (the director checks first). */
export type PoseCast = FilmCast & { kind: string }
/** The reference sheet's own character, and everyone in its "place with the cast" panel. */
export interface SheetCast { cast: FilmCast; with: FilmCast[] }

/** The longest prompt these templates can make from the longest fields the film methods accept. */
export const MAX_PROMPT = 8000

// The cartoon look from hand test T2 (local-video\jobs\t2-cartoon-2026-10-29).
const CARTOON = 'A hand-drawn 2D animated cartoon in the style of a classic illustrated animated film, with bold ink outlines, ' +
  'soft painted watercolour backgrounds and flat painted colours.'

const LOOK: Record<FilmLook, { picture: string; opening: (framing: string) => string; closing: string }> = {
  realistic: { picture: 'Photorealistic.', opening: (framing) => `A cinematic, photorealistic, full-frame ${framing} of`, closing: 'Calm, natural movement.' },
  cartoon: { picture: CARTOON, opening: (framing) => `${CARTOON} A ${framing} of`, closing: 'Calm, gentle animation.' },
}

const NUMBERS = ['no', 'one', 'two', 'three']
const IRREGULAR: Readonly<Record<string, string>> = {
  child: 'children', person: 'people', mouse: 'mice', goose: 'geese', ox: 'oxen', wolf: 'wolves', calf: 'calves',
  sheep: 'sheep', deer: 'deer', fish: 'fish',
  // Words that end in "man" but aren't a man.
  human: 'humans', shaman: 'shamans', german: 'germans', roman: 'romans', caiman: 'caimans', talisman: 'talismans',
}

/**
 * One line of plain text: line breaks, tabs, invisible format characters and the "#" and "*" the Ingredients prompt
 * uses for its headings and labels become spaces; "embedding:" is broken up.
 */
export function flatten(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f\p{Cf}#*]/gu, ' ')
    .replace(/embedding\s*:/gi, 'embedding ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The fields as they go into a sentence, with any final full stop dropped so the template's own punctuation stands.
function field(text: string): string {
  return flatten(text).replace(/[.\s]+$/, '')
}

function plural(kind: string): string {
  if (IRREGULAR[kind]) return IRREGULAR[kind]
  if (kind.endsWith('man')) return `${kind.slice(0, -3)}men`
  if (/(s|x|z|ch|sh)$/.test(kind)) return `${kind}es`
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`
  return `${kind}s`
}

// "Bess", "Bess and Nipper", "Bess, Nipper and Tom".
function names(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

// "There are exactly two dogs and one man in the whole picture." Kinds in the order they first appear.
function countLine(kinds: string[]): string {
  const counts = new Map<string, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  const groups = [...counts].map(([kind, n]) => `${NUMBERS[n]} ${n === 1 ? kind : plural(kind)}`)
  return `There ${kinds.length === 1 ? 'is' : 'are'} exactly ${names(groups)} in the whole picture.`
}

function keepLine(place: FilmPlace): string {
  return `Keep everything else in picture 1 exactly the same: same camera, same light, ${field(place.keep)}.`
}

/** Fast edit of the character's own picture: the recolour that fixed the brown eyebrows. */
export function cleanupPrompt(cast: FilmCast): string {
  return `Recolour only the small patches that don't match this description so they match it exactly: ${field(cast.wording)}. ` +
    'Keep everything else in picture 1 exactly the same: same pose, same light.'
}

/** Fine edit: the front, side and back views for the reference sheet. */
export function turnaroundPrompt(cast: FilmCast): string {
  return `Show ${field(cast.wording)} three times side by side on a plain light grey background: from the front, from the side ` +
    'and from the back, full body, same size, evenly lit.'
}

/** Fine edit: the face close-up for the reference sheet. */
export function facePrompt(cast: FilmCast): string {
  return `A front-facing close-up of the face of ${field(cast.wording)}, filling the picture, plain soft background.`
}

/** Fast edit of the first character's picture into the first place. */
export function firstMasterPrompt(place: FilmPlace, look: FilmLook): string {
  return `Show a new place: ${field(place.description)}, wide shot at eye level. ${LOOK[look].picture} No people or animals.`
}

/** Fast edit of the first chosen master into each later place, so the light and style carry over. */
export function laterMasterPrompt(place: FilmPlace): string {
  return `Show a new place in the same world, with the same light and style: ${field(place.description)}, wide shot at eye level. No people or animals.`
}

/** Fast edit of a chosen master that shows anyone: the place on its own, for the poses to be added into. */
export function emptyMasterPrompt(place: FilmPlace): string {
  return `Remove every person and animal from picture 1. Keep everything else exactly the same: same camera, same light, ${field(place.keep)}.`
}

/**
 * One start or end pose, as a chain of fast edits: the first adds the first character to the empty master, each next
 * one adds the next character to the picture before, with that character's own picture as picture 2. Every character
 * needs its kind (the director checks first).
 */
export function posePrompts(characters: Array<{ cast: PoseCast; pose: string }>, place: FilmPlace, look: FilmLook): string[] {
  const style = (name: string) => look === 'cartoon' ? ` Draw ${name} in the same hand-drawn cartoon style as picture 1.` : ''
  return characters.map(({ cast, pose }, i) => {
    const name = field(cast.name)
    const kind = field(cast.kind)
    const before = characters.slice(0, i)
    const adding = `${before.some((c) => field(c.cast.kind) === kind) ? 'more ' : ''}${kind}`
    const known = i === 0
      ? `Picture 2 only shows what ${name} looks like; there is exactly one ${kind} in the whole picture.`
      : `Picture 2 only shows what ${name} looks like. Keep ${names(before.map((c) => field(c.cast.name)))} exactly as before, ` +
        `in the same place${i > 1 ? 's' : ''}. ${countLine(characters.slice(0, i + 1).map((c) => field(c.cast.kind)))}`
    return `Add exactly one ${adding} to picture 1: ${name}, ${field(cast.wording)}, ${field(pose)}. ${known}${style(name)} ${keepLine(place)}`
  })
}

/**
 * The order a pose's characters are added in: each after anyone their own pose names, otherwise as in the shot. A
 * pose that names someone not in the picture yet ("sitting to the left of Spot", Spot still to come) made the editor
 * draw a stray animal to be Spot (live test). Two who name each other keep the shot's order.
 */
export function addingOrder<T extends { cast: { name: string }; pose: string }>(characters: T[]): T[] {
  const names = (c: T, other: T) => new RegExp(`(^|[^\\p{L}\\p{N}])${other.cast.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(c.pose)
  const left = [...characters]
  const order: T[] = []
  while (left.length > 0) {
    const ready = left.findIndex((c) => left.every((other) => other === c || !names(c, other)))
    order.push(...left.splice(ready < 0 ? 0 : ready, 1))
  }
  return order
}

/** Fine edit for a close-up's start picture (the fast editor ignores framing words). */
export function closeUpPrompt(cast: FilmCast, pose: string, place: FilmPlace, look: FilmLook): string {
  const name = field(cast.name)
  // The place described, the character alone in it, and the look: without them the live test's close-up was a photo
  // of a dog on a road, then a cartoon dog on a deck with people behind (hand test T10b).
  const style = look === 'cartoon' ? ` Draw ${name} and the place in the same hand-drawn cartoon style as picture 1.` : ''
  return `A close-up at ${name}'s eye level of ${field(cast.wording)}, ${field(pose)}. ` +
    `Behind ${name}, softly out of focus, is the place in picture 1: ${field(place.description)}. ${name} is the only one there. ` +
    `Picture 2 only shows what ${name} looks like.${style}`
}

/**
 * The shot's prompt for LTX with the Ingredients add-on: the reference sheet's panels (its one character, and the
 * characters in its last panel), then the shot itself with every character in it, the same words as its pictures.
 */
export function shotPrompt(place: FilmPlace, sheet: SheetCast, shot: FilmShot, look: FilmLook): string {
  const sheetName = field(sheet.cast.name)
  const panels = [
    '### Reference Sheet Description',
    `**Top Row Left (Setting):** ${field(place.description)}.`,
    `**Top Row Right (Character):** ${sheetName}, ${field(sheet.cast.wording)}, shown from the front, the side and the back.`,
    `**Bottom Row Left (Character):** A front-facing close-up of the face of ${sheetName}.`,
    ...(place.prop ? [`**Bottom Row Middle (Prop):** ${field(place.prop)}.`] : []),
    `**Bottom Row Right (Setting):** The same place with ${names(sheet.with.map((c) => field(c.name)))} in it.`,
  ]
  const opening = `${LOOK[look].opening(shot.closeUp ? 'close-up' : 'wide shot')} ${field(place.name)}, the camera still.`
  const ends = !shot.closeUp && shot.characters.every((c) => c.endPose)
  let action: string
  if (shot.characters.length === 1) {
    const [{ cast, startPose, endPose }] = shot.characters as [ShotCharacter]
    action = `${field(cast.name)}, ${field(cast.wording)}, starts ${field(startPose)}, ${field(shot.action)}.${ends ? ` It ends ${field(endPose)}.` : ''}`
  } else {
    const who = shot.characters.map((c) => `${field(c.cast.name)}, ${field(c.cast.wording)}`).join('; ')
    const each = (verb: string, pose: (c: ShotCharacter) => string) => names(shot.characters.map((c) => `${field(c.cast.name)} ${verb} ${field(pose(c))}`))
    const happens = field(shot.action)
    action = `${capitalised(NUMBERS[shot.characters.length]!)} characters together: ${who}. ${each('starts', (c) => c.startPose)}. ` +
      `${capitalised(happens)}.${ends ? ` ${each('ends', (c) => c.endPose)}.` : ''}`
  }
  return `${panels.join(' ')} ### Target Description ${opening} ${action} ${LOOK[look].closing}`
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
