// Every prompt the Storyboard sends to ComfyUI, built from fixed sentences and a film's checked fields (storyboard
// spec 6.3). The sentences are the ones that worked for the hand-made red door films (local-video RECIPE.md):
// remove then add, never "move"; "exactly one" against doubled characters; the cast wording word for word; and only
// positive words in a video prompt, because the fast video model runs at CFG 1 and reads "no tan" as "tan".
//
// Security-sensitive. Do not modify without Claude review.
//
// Fields arrive already checked (lengths, no control characters). Here every field is also flattened to one line and
// loses any "#" or "*", so it can't forge a "### ..." section or a "**...:**" label of the Ingredients prompt, and
// "embedding:" is broken up, because ComfyUI's text encoders read "embedding:name" as "load this file".

export type FilmLook = 'realistic' | 'cartoon'

export interface FilmCast { name: string; wording: string }
export interface FilmPlace { name: string; description: string; keep: string; prop?: string | undefined }
export interface FilmShot { action: string; startPose: string; endPose: string; closeUp: boolean }

/** The longest prompt these templates can make from the longest fields the film methods accept. */
export const MAX_PROMPT = 4000

const LOOK: Record<FilmLook, { picture: string; video: string }> = {
  realistic: { picture: 'Photorealistic.', video: 'photorealistic' },
  // Placeholder wording until the cartoon recipe test (T2) settles it.
  cartoon: { picture: 'A hand-drawn cartoon, soft painted colours.', video: 'hand-drawn cartoon' },
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

// The cast wording for "the face of ...": "a border collie with ..." reads as "a border collie".
function kind(cast: FilmCast): string {
  return field(cast.wording).split(/,| with /)[0]!
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

/** Fast edit of the empty master with the character's picture as picture 2: one start or end pose. */
export function posePrompt(cast: FilmCast, pose: string, place: FilmPlace): string {
  const name = field(cast.name)
  return `Add ${name} to picture 1: ${field(cast.wording)}, ${field(pose)}. ` +
    `Picture 2 only shows what ${name} looks like; there is exactly one ${name} in the whole picture. ${keepLine(place)}`
}

/** Fine edit for a close-up's start picture (the fast editor ignores framing words). */
export function closeUpPrompt(cast: FilmCast, pose: string): string {
  return `A close-up at ${field(cast.name)}'s eye level of ${field(cast.wording)}, ${field(pose)}, the place softly out of focus behind.`
}

/** The shot's prompt for LTX with the Ingredients add-on: the reference sheet's panels, then the shot itself. */
export function shotPrompt(place: FilmPlace, cast: FilmCast, shot: FilmShot, look: FilmLook): string {
  const name = field(cast.name)
  const wording = field(cast.wording)
  const sheet = [
    '### Reference Sheet Description',
    `**Top Row Left (Setting):** ${field(place.description)}.`,
    `**Top Row Right (Character):** ${name}, ${wording}, shown from the front, the side and the back.`,
    `**Bottom Row Left (Character):** A front-facing close-up of the face of ${name}.`,
    ...(place.prop ? [`**Bottom Row Middle (Prop):** ${field(place.prop)}.`] : []),
    `**Bottom Row Right (Setting):** The same place with ${name} in it.`,
  ]
  const framing = shot.closeUp ? 'close-up' : 'wide shot'
  const ending = shot.closeUp || !shot.endPose ? '' : ` It ends ${field(shot.endPose)}.`
  const target = `A cinematic, ${LOOK[look].video}, full-frame ${framing} of ${field(place.name)}, the camera still. ` +
    `${name}, ${wording}, starts ${field(shot.startPose)}, ${field(shot.action)}.${ending} Calm, natural movement.`
  return `${sheet.join(' ')} ### Target Description ${target}`
}
