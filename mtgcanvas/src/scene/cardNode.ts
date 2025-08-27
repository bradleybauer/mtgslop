import * as PIXI from 'pixi.js';
import { SelectionStore } from '../state/selectionStore';
import { getCachedObjectURL } from '../services/imageCache';

// --- Fast in-memory texture cache & loaders ---
interface TexCacheEntry { tex: PIXI.Texture; level: number; }
const textureCache = new Map<string, TexCacheEntry>(); // url -> texture
const inflightTex = new Map<string, Promise<PIXI.Texture>>();

export async function loadTextureFromCachedURL(url:string): Promise<PIXI.Texture> {
  if (textureCache.has(url)) return textureCache.get(url)!.tex;
  if (inflightTex.has(url)) return inflightTex.get(url)!;
  const p = (async ()=> {
    const objUrl = await getCachedObjectURL(url);
    // Use createImageBitmap if available for off-main-thread decode
    try {
      const resp = await fetch(objUrl);
      const blob = await resp.blob();
  const canBitmap = typeof (window as any).createImageBitmap === 'function';
  const bmp = await (canBitmap ? (window as any).createImageBitmap(blob) : new Promise<ImageBitmap>((res,rej)=>{
        const img=new Image(); img.onload=()=>{ try { (res as any)(img as any); } catch(e){rej(e);} }; img.onerror=()=>rej(new Error('img error')); img.src=objUrl; }));
      const tex = PIXI.Texture.from(bmp as any);
      const bt:any = tex.baseTexture as any; if (bt?.style){ bt.style.mipmap='on'; bt.style.scaleMode='linear'; bt.style.anisotropicLevel=8; }
      textureCache.set(url, { tex, level: 0 });
      return tex;
    } catch {
      // Fallback: traditional Image path
      const tex = await new Promise<PIXI.Texture>((resolve, reject)=> {
        const img = new Image(); img.crossOrigin='anonymous';
        img.onload = ()=> { try { const t = PIXI.Texture.from(img); const bt:any = t.baseTexture as any; if (bt?.style){ bt.style.mipmap='on'; bt.style.scaleMode='linear'; } resolve(t);} catch(e){ reject(e);} };
        img.onerror = ()=> reject(new Error('img load error'));
        img.src = objUrl;
      });
      textureCache.set(url, { tex, level: 0 });
      return tex;
    }
  })();
  inflightTex.set(url, p);
  try { const tex = await p; return tex; } finally { inflightTex.delete(url); }
}

// --- Card Sprite Implementation (Sprite + cached textures) ---
export interface CardSprite extends PIXI.Sprite { __id:number; __baseZ:number; __groupId?:number; __card?:any; __imgUrl?:string; __imgLoaded?:boolean; __imgLoading?:boolean; __outline?: PIXI.Graphics; __hiResUrl?:string; __hiResLoaded?:boolean; __hiResLoading?:boolean; __hiResAt?:number; __qualityLevel?: number; __doubleBadge?: PIXI.Container; __faceIndex?: number; }

export interface CardVisualOptions { id:number; x:number; y:number; z:number; renderer: PIXI.Renderer; card?: any; }

interface CardTextures { base: PIXI.Texture; selected: PIXI.Texture; inGroup: PIXI.Texture; inGroupSelected: PIXI.Texture; }
let cachedTextures: CardTextures | null = null;

function buildTexture(renderer: PIXI.Renderer, opts:{w:number;h:number;fill:number; stroke:number; strokeW:number}) {
  const g = new PIXI.Graphics();
  g.rect(0,0,opts.w,opts.h).fill({color:opts.fill}).stroke({color:opts.stroke,width:opts.strokeW});
  const tex = renderer.generateTexture(g);
  g.destroy();
  return tex;
}

function ensureCardTextures(renderer: PIXI.Renderer) {
  if (cachedTextures) return cachedTextures;
  const w=100,h=140;
  cachedTextures = {
    base: buildTexture(renderer,{w,h,fill:0xffffff, stroke:0x000000, strokeW:2}),
    selected: buildTexture(renderer,{w,h,fill:0xffffff, stroke:0x00aaff, strokeW:4}),
    inGroup: buildTexture(renderer,{w,h,fill:0xf7f7f7, stroke:0x000000, strokeW:2}),
    inGroupSelected: buildTexture(renderer,{w,h,fill:0xf7f7f7, stroke:0x00aaff, strokeW:4})
  };
  return cachedTextures;
}

export function createCardSprite(opts: CardVisualOptions) {
  const textures = ensureCardTextures(opts.renderer);
  const sp = new PIXI.Sprite(textures.base) as CardSprite;
  sp.__id = opts.id; sp.__baseZ = opts.z; sp.__card = opts.card || null;
  sp.x = opts.x; sp.y = opts.y; sp.zIndex = sp.__baseZ;
  sp.eventMode='static'; sp.cursor='pointer';
  // If card already provided and double sided, initialize face index + badge
  if (sp.__card && isDoubleSided(sp.__card)) { sp.__faceIndex = 0; ensureDoubleSidedBadge(sp); }
  // Use default (linear) scaling for image clarity; we will supply higher-res textures when zoomed.
  return sp;
}

export function ensureCardImage(sprite: CardSprite) {
  if (sprite.__imgLoaded || sprite.__imgLoading) return;
  const card = sprite.__card; if (!card) return;
  const faceIdx = sprite.__faceIndex || 0;
  const face = (card.card_faces && card.card_faces[faceIdx]) || null;
  const url = face?.image_uris?.small || card.image_uris?.small || face?.image_uris?.normal || card.image_uris?.normal;
  if (!url) return;
  sprite.__imgUrl = url; sprite.__imgLoading = true;
  loadTextureFromCachedURL(url).then(tex=> {
    if (!tex) { sprite.__imgLoading=false; return; }
    sprite.texture = tex; sprite.width = 100; sprite.height = 140;
    sprite.__imgLoaded = true; sprite.__imgLoading=false;
    if (sprite.__qualityLevel===undefined) sprite.__qualityLevel = 0;
    if (SelectionStore.state.cardIds.has(sprite.__id)) updateCardSpriteAppearance(sprite, true);
    if (isDoubleSided(card)) ensureDoubleSidedBadge(sprite, true);
  }).catch(()=> { sprite.__imgLoading=false; });
}

// ---- High Resolution Upgrade Logic ----
// Relaxed hi-res cache: allow more upgraded textures to stay resident before eviction.
// (Adjustable if memory pressure observed; tuned upward per user request.)
const HI_RES_LIMIT = 800; // previous: 250
const hiResQueue: CardSprite[] = []; // oldest at index 0

function evictHiResIfNeeded() {
  while (hiResQueue.length > HI_RES_LIMIT) {
    const victim = hiResQueue.shift();
    if (victim && victim.__hiResLoaded) {
      // Downgrade: keep small texture? We don't re-store it; assume still cached.
      victim.__hiResLoaded = false; victim.__hiResUrl = undefined; victim.__hiResAt = undefined;
      // No explicit destroy of texture to allow cache reuse; could add manual destroy here if memory pressure observed.
    }
  }
}

// Multi-tier quality loader: 0=small,1=normal/large,2=png (highest)
export function updateCardTextureForScale(sprite: CardSprite, scale:number) {
  if (!sprite.__card) return;
  // Estimate on-screen pixel height
  const deviceRatio = (globalThis.devicePixelRatio||1);
  const pxHeight = 140 * scale * deviceRatio;
  let desired = 0;
  // Lower thresholds so we promote quality sooner (helps moderate zoom levels remain crisp)
  if (pxHeight > 140) desired = 2; // promote to png at lower on-screen size
  else if (pxHeight > 90) desired = 1; // switch to normal sooner
  // Avoid downgrade churn
  if (sprite.__qualityLevel !== undefined && desired <= sprite.__qualityLevel) return;
  // Already loading something higher
  if (sprite.__hiResLoading) return;
  const card = sprite.__card;
  const faceIdx = sprite.__faceIndex || 0;
  const face = (card.card_faces && card.card_faces[faceIdx]) || null;
  let url: string | undefined;
  if (desired === 2) {
    url = face?.image_uris?.png || card.image_uris?.png || face?.image_uris?.large || card.image_uris?.large;
  } else if (desired === 1) {
    url = face?.image_uris?.normal || card.image_uris?.normal || face?.image_uris?.large || card.image_uris?.large;
  }
  if (!url) return;
  // If already at this URL skip
  if (sprite.texture?.baseTexture?.resource?.url === url || sprite.__hiResUrl === url) { sprite.__qualityLevel = desired; return; }
  sprite.__hiResLoading = true; sprite.__hiResUrl = url;
  loadTextureFromCachedURL(url)
  .then(tex=> { sprite.__hiResLoading=false; if (!tex) return; sprite.texture=tex; sprite.width=100; sprite.height=140; sprite.__qualityLevel=desired; if (desired>=1){ sprite.__hiResLoaded=true; sprite.__hiResAt=performance.now(); hiResQueue.push(sprite); evictHiResIfNeeded(); } if (SelectionStore.state.cardIds.has(sprite.__id)) updateCardSpriteAppearance(sprite, true); if (sprite.__card && isDoubleSided(sprite.__card)) ensureDoubleSidedBadge(sprite, true); else if (sprite.__doubleBadge) { sprite.__doubleBadge.destroy(); sprite.__doubleBadge = undefined; } })
    .catch(()=> { sprite.__hiResLoading=false; });
}

// Helper: derive image URL for a given quality tier (0 small,1 normal,2 png)
export function getCardImageUrlForLevel(card:any, level:number): string | undefined {
  if (level===2) return card.image_uris?.png || card.card_faces?.[0]?.image_uris?.png || card.image_uris?.large || card.card_faces?.[0]?.image_uris?.large;
  if (level===1) return card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || card.image_uris?.large || card.card_faces?.[0]?.image_uris?.large;
  return card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal;
}

// Preload a specific quality level regardless of current zoom thresholds; optionally apply resulting texture.
export function preloadCardQuality(sprite: CardSprite, level:number, apply:boolean=true): Promise<void> {
  if (!sprite.__card) return Promise.resolve();
  const url = getCardImageUrlForLevel(sprite.__card, level); if (!url) return Promise.resolve();
  return loadTextureFromCachedURL(url).then(tex=> {
    if (apply) {
      sprite.texture = tex; sprite.width=100; sprite.height=140;
      sprite.__imgLoaded = true; // ensure marked loaded for metrics / logic
      sprite.__qualityLevel = level;
      if (level>=1){ sprite.__hiResLoaded = true; sprite.__hiResAt = performance.now(); }
    }
  }).catch(()=>{});
}

// --- Monitoring helpers ---
export function getHiResQueueLength(){ return hiResQueue.length; }
export function getInflightTextureCount(){ return inflightTex.size; }

export function updateCardSpriteAppearance(s: CardSprite, selected:boolean) {
  if (!cachedTextures) return; // should exist after first card
  if (s.__imgLoaded) {
    // Maintain image texture; toggle outline overlay for selection.
    if (!s.__outline) {
      const g = new PIXI.Graphics();
      const tex: any = s.texture;
      const ow = tex?.orig?.width || tex?.baseTexture?.width || 100;
      const oh = tex?.orig?.height || tex?.baseTexture?.height || 140;
      g.rect(0,0,ow,oh).stroke({color:0x00aaff,width:4});
      g.visible = false;
      s.addChild(g);
      s.__outline = g;
    }
    else if (selected) {
      // Ensure outline matches current texture intrinsic size
      const tex: any = s.texture; const g = s.__outline;
      const ow = tex?.orig?.width || tex?.baseTexture?.width || 100;
      const oh = tex?.orig?.height || tex?.baseTexture?.height || 140;
      if ((g as any).__ow !== ow || (g as any).__oh !== oh) {
        g.clear(); g.rect(0,0,ow,oh).stroke({color:0x00aaff,width:4});
        (g as any).__ow = ow; (g as any).__oh = oh;
      }
    }
    if (s.__outline) s.__outline.visible = selected;
    return;
  }
  const inGroup = !!s.__groupId;
  s.texture = inGroup ? (selected? cachedTextures.inGroupSelected : cachedTextures.inGroup) : (selected? cachedTextures.selected : cachedTextures.base);
}

// --- Double-sided (Reversible) Badge ---
// Only treat true double-faced transform style cards as reversible for UI badge.
// Exclude adventure, split, aftermath, flip etc. which have multiple faces in data but not a reversible back face.
const TRUE_DFC_LAYOUTS = new Set(['transform','modal_dfc','double_faced_token','battle','meld']);
function isDoubleSided(card:any): boolean {
  if (!card) return false;
  const layout = (card.layout || '').toLowerCase();
  if (TRUE_DFC_LAYOUTS.has(layout)) return true;
  // Fallback: exactly two fully imaged faces, and not in excluded layouts
  if (Array.isArray(card.card_faces) && card.card_faces.length === 2 && card.card_faces.every((f:any)=>f.image_uris)) {
    if (/^(adventure|split|aftermath|flip|prototype)$/.test(layout)) return false;
    return true;
  }
  return false;
}

function ensureDoubleSidedBadge(sprite: CardSprite, repositionOnly=false){
  if (!isDoubleSided(sprite.__card)) {
    if (sprite.__doubleBadge) { sprite.__doubleBadge.destroy(); sprite.__doubleBadge = undefined; }
    return;
  }
  const displayW = 100;
  // Quarter the previous linear size: radius 18 -> ~4.5 (round to 5)
  const targetRadius = 5;
  const margin = 4;
  const verticalOffset = 12; // push badge lower from top edge
  if (!sprite.__doubleBadge){
    const wrap = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.circle(0,0,targetRadius).fill({color:0x0a1a22, alpha:0.9}).stroke({color:0x48cfff,width:2});
    // Smaller arrows scaled to new radius
    g.moveTo(-2,-1).lineTo(0,-5).lineTo(2,-1).stroke({color:0x8ae9ff,width:2});
    g.moveTo(2,1).lineTo(0,5).lineTo(-2,1).stroke({color:0x8ae9ff,width:2});
    wrap.addChild(g);
    wrap.eventMode='static'; wrap.cursor='pointer'; wrap.alpha=0.4;
    wrap.on('pointerdown', (e:any)=> { e.stopPropagation(); flipCardFace(sprite); });
    wrap.on('mouseenter', ()=> { wrap.alpha=0.9; });
    wrap.on('mouseleave', ()=> { wrap.alpha=0.4; });
    sprite.__doubleBadge = wrap;
    sprite.addChild(wrap);
  }
  const badge = sprite.__doubleBadge!;
  // Neutralize parent scaling so badge appears fixed relative to card's 100x140 logical size.
  const sx = sprite.scale.x || 1; const sy = sprite.scale.y || 1;
  badge.scale.set(1/sx, 1/sy);
  // Desired displayed position (top-right)
  const desiredX = displayW - (targetRadius + margin);
  const desiredY = targetRadius + margin + verticalOffset;
  badge.x = desiredX / sx;
  badge.y = desiredY / sy;
  badge.zIndex = 1000000;
  if (sprite.__outline) sprite.__outline.zIndex = 999999;
  (sprite as any).sortableChildren = true;
}

// Maintain roughly screen-constant badge size: call every frame with world scale
// (Badge now scales with card; no inverse scaling function needed.)

function flipCardFace(sprite: CardSprite){
  const card = sprite.__card; if (!card || !isDoubleSided(card)) return;
  const faces = card.card_faces; if (!Array.isArray(faces) || faces.length < 2) return;
  sprite.__faceIndex = sprite.__faceIndex ? 0 : 1;
  // Reset state so fresh load occurs (ephemeral; no persistence)
  sprite.__hiResLoaded=false; sprite.__hiResUrl=undefined; sprite.__qualityLevel=0; sprite.__imgLoaded=false; sprite.__imgUrl=undefined;
  ensureCardImage(sprite);
  // After initial small loads, attempt hi-res for current zoom next frame
  requestAnimationFrame(()=> { try { const scale = (sprite.parent?.parent as any)?.scale?.x || 1; updateCardTextureForScale(sprite, scale); } catch {} });
  ensureDoubleSidedBadge(sprite, true); // reposition after flip
}

export function attachCardInteractions(s: CardSprite, getAll: ()=>CardSprite[], world: PIXI.Container, stage: PIXI.Container, onCommit?: (moved: CardSprite[])=>void, isPanning?: ()=>boolean, startMarquee?: (global: PIXI.Point, additive:boolean)=>void) {
  let dragState: null | { sprites: CardSprite[]; offsets: {sprite:CardSprite, dx:number, dy:number}[] } = null;
  s.on('pointerdown', (e:any)=> {
  if (e.button!==0) return; // only left button selects / drags
  if (isPanning && isPanning()) return; // ignore clicks while panning with space
    // If Shift held, allow marquee instead of starting a card drag (when user intends multi-select)
    if (e.shiftKey && startMarquee) {
      startMarquee(new PIXI.Point(e.global.x, e.global.y), true);
      return; // don't initiate drag
    }
    if (!e.shiftKey && !SelectionStore.state.cardIds.has(s.__id)) SelectionStore.selectOnlyCard(s.__id); else if (e.shiftKey) SelectionStore.toggleCard(s.__id);
    const ids = SelectionStore.getCards();
    const all = getAll();
    const dragSprites = all.filter(c=> ids.includes(c.__id));
    const startLocal = world.toLocal(e.global);
    dragState = { sprites: dragSprites, offsets: dragSprites.map(cs=> ({sprite:cs, dx: startLocal.x - cs.x, dy: startLocal.y - cs.y})) };
    dragSprites.forEach(cs=> cs.zIndex = 100000 + cs.__baseZ);
  });
  const endDrag=(commit:boolean)=>{
    if (!dragState) return;
    dragState.sprites.forEach(cs=> cs.zIndex = cs.__baseZ);
    if (commit) { dragState.sprites.forEach(cs=> { cs.x = snap(cs.x); cs.y = snap(cs.y); }); onCommit && onCommit(dragState.sprites); }
    dragState=null;
  };
  stage.on('pointerup', ()=> endDrag(true));
  stage.on('pointerupoutside', ()=> endDrag(true));
  stage.on('pointermove', (e:any)=> { if (!dragState) return; const local = world.toLocal(e.global); let moved=false; for (const off of dragState.offsets) { const nx = local.x - off.dx; const ny = local.y - off.dy; if (off.sprite.x!==nx || off.sprite.y!==ny) { off.sprite.x = nx; off.sprite.y = ny; moved=true; } } if (moved && onCommit) onCommit(dragState.sprites); });
}

const GRID_SIZE = 8; // match global grid (was 20)
function snap(v:number) { return Math.round(v/GRID_SIZE)*GRID_SIZE; }
