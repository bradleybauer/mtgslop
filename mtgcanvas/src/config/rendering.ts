// Centralized rendering/texture settings. Single source of truth.

export interface TextureSettings {
  gpuBudgetMB: number; // Max GPU memory budget for cached textures
  disablePngTier: boolean; // If true, cap at 'normal' tier (skip PNG)
  allowEvict: boolean; // If true, allow LRU eviction of unused textures
  decodeParallelLimit: number; // Max parallel image decodes
  hiResLimit: number; // Max number of hi-res-upgraded sprites to keep
}

// Defaults are conservative; can be tuned at runtime via configureTextureSettings()
export const textureSettings: TextureSettings = {
  gpuBudgetMB: 4000, // 2 GB default budget to reduce pressure on typical GPUs
  disablePngTier: true,
  allowEvict: true,
  decodeParallelLimit: 32,
  hiResLimit: 2000, // unlimited; rely on GPU budget for eviction
};

export function configureTextureSettings(p: Partial<TextureSettings>) {
  if (typeof p.gpuBudgetMB === "number" && p.gpuBudgetMB > 0)
    textureSettings.gpuBudgetMB = p.gpuBudgetMB;
  if (typeof p.disablePngTier === "boolean")
    textureSettings.disablePngTier = p.disablePngTier;
  if (typeof p.allowEvict === "boolean")
    textureSettings.allowEvict = p.allowEvict;
  if (typeof p.decodeParallelLimit === "number" && p.decodeParallelLimit >= 1) {
    textureSettings.decodeParallelLimit = Math.min(
      64,
      Math.max(1, Math.floor(p.decodeParallelLimit)),
    );
  }
  if (typeof p.hiResLimit === "number" && p.hiResLimit >= 0) {
    textureSettings.hiResLimit = Math.floor(p.hiResLimit);
  }
}
