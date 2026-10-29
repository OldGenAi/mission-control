// The Storyboard's film, as video.film.get sends it (gateway video/films.ts), and the names of its joins.

export type Stage = 'story' | 'plan' | 'places' | 'shots' | 'making' | 'done' | 'stopped'

export interface FilmCast { castId: string; name: string; wording: string; pictureId: string | null; turnaroundId: string | null; faceId: string | null }

export interface FilmPlace {
  id: string; position: number; name: string; description: string; keep: string; prop: string | null
  masterId: string | null; emptyId: string | null; sheetId: string | null
}

export interface FilmShot {
  id: string; position: number; placeId: string; castId: string; action: string; startPose: string; endPose: string | null
  seconds: number; joins: string; closeUp: boolean; seed: number; startId: string | null; endId: string | null
  clipId: string | null; clipSeed: number | null; revision: number; clipRev: number | null
}

export interface FilmPicture {
  id: string; ownerKind: 'place' | 'shot' | 'cast'; ownerId: string; role: string; jobId: string; status: string | null
  imageId: string | null; seed: number; checkState: string; checkNotes: string | null; createdAt: number
}

export interface Film {
  id: string; title: string; story: string; seconds: number; look: string; sound: boolean; stage: Stage
  problem: string | null; videoId: string | null; createdAt: number; updatedAt: number
  cast: FilmCast[]; places: FilmPlace[]; shots: FilmShot[]; pictures: FilmPicture[]
}

export const JOINS: Record<string, string> = {
  follows: 'Follows on (a straight cut)',
  fade_short: 'Time passes (a short fade)',
  fade_long: 'Time passes (a longer fade)',
}
