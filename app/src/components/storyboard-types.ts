// The Storyboard's film, as video.film.get sends it (gateway video/films.ts), and the names of its joins.

export type Stage = 'story' | 'plan' | 'places' | 'shots' | 'making' | 'done' | 'stopped'

export interface FilmCast {
  castId: string; name: string; wording: string; kind: string | null; pictureId: string | null; turnaroundId: string | null; faceId: string | null
}

/** One character in a shot, in the order the pictures add them. */
export interface ShotCharacter { castId: string; startPose: string; endPose: string | null }

export interface FilmPlace {
  id: string; position: number; name: string; description: string; keep: string; prop: string | null
  masterId: string | null; emptyId: string | null; sheetId: string | null; sheetBasis: string | null
}

export interface FilmShot {
  id: string; position: number; placeId: string; characters: ShotCharacter[]; action: string
  seconds: number; joins: string; closeUp: boolean; seed: number; startId: string | null; endId: string | null
  clipId: string | null; clipSeed: number | null; revision: number; clipRev: number | null
}

export interface FilmPicture {
  id: string; ownerKind: 'place' | 'shot' | 'cast'; ownerId: string; role: string; jobId: string; status: string | null
  imageId: string | null; steps: number; step: number; stale: boolean; seed: number; checkState: string; checkNotes: string | null; createdAt: number
}

export interface Film {
  id: string; title: string; story: string; seconds: number; look: string; sound: boolean; stage: Stage
  problem: string | null; videoId: string | null; createdAt: number; updatedAt: number
  cast: FilmCast[]; places: FilmPlace[]; shots: FilmShot[]; pictures: FilmPicture[]
}

/** As the gateway's followsOn (video/films.ts), which keeps such a shot's start on the end picture before it. */
export function followsOn(before: FilmShot | undefined, shot: FilmShot): boolean {
  return !!before && !before.closeUp && !shot.closeUp && shot.joins === 'follows' && before.placeId === shot.placeId &&
    before.characters.length === shot.characters.length && shot.characters.every((c) => before.characters.some((b) => b.castId === c.castId))
}

export const JOINS: Record<string, string> = {
  follows: 'Follows on (a straight cut)',
  fade_short: 'Time passes (a short fade)',
  fade_long: 'Time passes (a longer fade)',
}
