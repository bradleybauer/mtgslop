// Global dataset configuration.
// Adjust these constants to switch which file the app prefers.
export const DATASET_PREFERRED = 'all.json';
export const DATASET_FALLBACK = 'legal.json';

// Ordered candidate relative/absolute paths the loader will attempt.
export function datasetCandidatePaths(): string[] {
  const pref = DATASET_PREFERRED; const fb = DATASET_FALLBACK;
  return [
    pref, `/${pref}`, `../${pref}`, `../notes/${pref}`, `../../notes/${pref}`, `/mtgcanvas/${pref}`,
    fb, `/${fb}`, `../${fb}`, `../notes/${fb}`, `../../notes/${fb}`, `/mtgcanvas/${fb}`
  ];
}
