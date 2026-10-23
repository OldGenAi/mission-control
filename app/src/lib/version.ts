// The app's own version, read from app/package.json when Vite starts (see vite.config.ts), so the
// labels follow each release without editing them by hand.
export const APP_VERSION = `v${(import.meta.env.VITE_MC_APP_VERSION as string | undefined) ?? "?"}`
