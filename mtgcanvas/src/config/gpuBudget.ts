import { configureTextureSettings } from "./rendering";

export interface GpuInfo {
  api: "webgl" | "webgpu" | "unknown";
  vendor?: string;
  renderer?: string;
  deviceMemoryGB?: number;
}

function getDeviceMemoryGB(): number | undefined {
  try {
    const dm: any = (navigator as any).deviceMemory;
    if (typeof dm === "number" && dm > 0) return dm;
  } catch {}
  return undefined;
}

function getWebGLInfo(renderer: any): { vendor?: string; renderer?: string } {
  try {
    const gl: any = renderer?.gl || renderer?.context?.gl || undefined;
    if (!gl) return {};
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = gl.getParameter(dbg?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR);
    const rendererStr = gl.getParameter(
      dbg?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER,
    );
    return {
      vendor: typeof vendor === "string" ? vendor : undefined,
      renderer: typeof rendererStr === "string" ? rendererStr : undefined,
    };
  } catch {
    return {};
  }
}

export function detectGpuInfo(renderer: any): GpuInfo {
  const dm = getDeviceMemoryGB();
  const { vendor, renderer: r } = getWebGLInfo(renderer);
  const info: GpuInfo = {
    api: "webgl",
    vendor,
    renderer: r,
    deviceMemoryGB: dm,
  };
  try {
    (window as any).__gpuInfo = info;
  } catch {}
  return info;
}

export function estimateGpuBudgetMB(info: GpuInfo): number {
  const sysGB = info.deviceMemoryGB ?? 8;
  const ven = (info.vendor || "").toLowerCase();
  const ren = (info.renderer || "").toLowerCase();
  const isDiscrete = /(nvidia|geforce|rtx|gtx|amd|radeon|arc)/.test(
    ven + " " + ren,
  );
  // Start from a fraction of system memory to play nicely with UMA and shared setups.
  // Use ~1/3 of reported system memory as a safe upper bound for texture budget.
  let mb = Math.floor((sysGB * 1024) / 3);
  // Provide sensible floors by class, assuming WebGL works well on Macs and Intel too.
  if (isDiscrete) {
    const modernDiscrete = /(rtx|rx\s*[6-9]|arc)/.test(ren);
    mb = Math.max(mb, modernDiscrete ? 4096 : 3072);
  } else {
    // Integrated/UMA: scale with memory; avoid tiny caps on Macs/Intel.
    if (sysGB >= 16) mb = Math.max(mb, 2048);
    else if (sysGB >= 8) mb = Math.max(mb, 1536);
    else mb = Math.max(mb, 1024);
  }
  // Clamp to sane bounds; keep discrete a bit higher ceiling.
  const ceiling = isDiscrete ? 6144 : 4096;
  mb = Math.max(512, Math.min(mb, ceiling));
  return mb;
}

export function autoConfigureTextureBudget(renderer: any) {
  try {
    // Respect explicit user override
    const overrideStr =
      localStorage.getItem("gpuBudgetMB") ||
      localStorage.getItem("gpuBudgetMBOverride");
    const ov = overrideStr ? Number(overrideStr) : NaN;
    if (Number.isFinite(ov) && ov > 0) {
      configureTextureSettings({ gpuBudgetMB: Math.floor(ov) });
      return;
    }
  } catch {}
  const info = detectGpuInfo(renderer);
  const mb = estimateGpuBudgetMB(info);
  configureTextureSettings({ gpuBudgetMB: mb });
}
