import * as PIXI from 'pixi.js';
import { SelectionStore } from '../state/selectionStore';

// --- Card Sprite Implementation (Sprite + cached textures) ---
export interface CardSprite extends PIXI.Sprite { __id:number; __baseZ:number; __groupId?:number; __card?:any; __imgUrl?:string; __imgLoaded?:boolean; __imgLoading?:boolean; __outline?: PIXI.Graphics; __hiResUrl?:string; __hiResLoaded?:boolean; __hiResLoading?:boolean; __hiResAt?:number; }

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
  // Use default (linear) scaling for image clarity; we will supply higher-res textures when zoomed.
  return sp;
}

export function ensureCardImage(sprite: CardSprite) {
  if (sprite.__imgLoaded || sprite.__imgLoading) return;
  const card = sprite.__card; if (!card) return;
  // Support single or multi-faced cards
  const url = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal;
  if (!url) return;
  sprite.__imgUrl = url; sprite.__imgLoading = true;
  try {
    // Register asset if not already present to be able to set crossOrigin.
    if (!PIXI.Assets.cache.has(url)) {
      PIXI.Assets.add({ alias: url, src: url, crossorigin: 'anonymous' } as any);
    }
    PIXI.Assets.load(url).then((tex: PIXI.Texture)=> {
      if (!tex) { sprite.__imgLoading = false; return; }
      sprite.texture = tex; // Force desired card display size
      sprite.width = 100; sprite.height = 140;
      sprite.__imgLoaded = true; sprite.__imgLoading = false;
      // If currently selected, ensure outline is shown
      if (SelectionStore.state.cardIds.has(sprite.__id)) {
        updateCardSpriteAppearance(sprite, true);
      }
    }).catch(()=> { sprite.__imgLoading = false; });
  } catch { sprite.__imgLoading = false; }
}

// ---- High Resolution Upgrade Logic ----
const HI_RES_LIMIT = 250; // cap number of hi-res textures to bound memory
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

export function ensureCardHiRes(sprite: CardSprite) {
  if (!sprite.__imgLoaded) return; // need base first
  if (sprite.__hiResLoaded || sprite.__hiResLoading) return;
  const card = sprite.__card; if (!card) return;
  const url = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal;
  if (!url || url === sprite.__imgUrl) return; // already using normal as base
  sprite.__hiResLoading = true; sprite.__hiResUrl = url;
  try {
    if (!PIXI.Assets.cache.has(url)) PIXI.Assets.add({ alias:url, src:url, crossorigin:'anonymous' } as any);
    PIXI.Assets.load(url).then((tex:PIXI.Texture)=> {
      sprite.__hiResLoading = false;
      if (!tex) return;
      sprite.texture = tex; // maintain display size
      sprite.width = 100; sprite.height = 140;
      sprite.__hiResLoaded = true; sprite.__hiResAt = performance.now();
      hiResQueue.push(sprite); evictHiResIfNeeded();
      if (SelectionStore.state.cardIds.has(sprite.__id)) updateCardSpriteAppearance(sprite, true);
    }).catch(()=> { sprite.__hiResLoading = false; });
  } catch { sprite.__hiResLoading = false; }
}

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

export function attachCardInteractions(s: CardSprite, getAll: ()=>CardSprite[], world: PIXI.Container, stage: PIXI.Container, onCommit?: (moved: CardSprite[])=>void, isPanning?: ()=>boolean) {
  let dragState: null | { sprites: CardSprite[]; offsets: {sprite:CardSprite, dx:number, dy:number}[] } = null;
  s.on('pointerdown', (e:any)=> {
  if (isPanning && isPanning()) return; // ignore clicks while panning with space
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
  stage.on('pointermove', (e:any)=> { if (!dragState) return; const local = world.toLocal(e.global); for (const off of dragState.offsets) { off.sprite.x = local.x - off.dx; off.sprite.y = local.y - off.dy; } });
}

const GRID_SIZE = 20;
function snap(v:number) { return Math.round(v/GRID_SIZE)*GRID_SIZE; }
