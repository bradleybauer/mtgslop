import * as PIXI from 'pixi.js';
import { SelectionStore } from './state/selectionStore';

interface CardSprite extends PIXI.Graphics { __id:number; __baseZ:number; __groupId?:number; }

const GRID_SIZE = 20;
function snap(v:number) { return Math.round(v/GRID_SIZE)*GRID_SIZE; }

const app = new PIXI.Application();
(async () => {
  await app.init({ background: '#1e1e1e', resizeTo: window });
  document.body.appendChild(app.canvas);

  const world = new PIXI.Container();
  app.stage.addChild(world);
  // Expand interactive region so pointermove continues outside initial content bounds
  app.stage.eventMode = 'static';
  app.stage.hitArea = new PIXI.Rectangle(-50000, -50000, 100000, 100000);

  const sprites: CardSprite[] = [];
  let zCounter = 1;

  function createCard(id:number, x:number, y:number) {
    const g = new PIXI.Graphics() as CardSprite;
    g.__id = id; g.__baseZ = zCounter++;
    g.rect(0,0,100,140).fill({color:0xffffff}).stroke({color:0x000000,width:2});
    g.x = x; g.y = y; g.zIndex = g.__baseZ;
    g.eventMode = 'static';
    g.cursor = 'pointer';
    attachCardInteractions(g);
    world.addChild(g);
    sprites.push(g);
  }

  // Dummy in-memory seed (no DB) so we always see cards; align to grid (spacing = card size + grid)
  const SPACING_X = 100 + GRID_SIZE; // 120 (multiple of 20)
  const SPACING_Y = 140 + GRID_SIZE; // 160 (multiple of 20)
  for (let i=0;i<200;i++) createCard(i+1, (i%20)*SPACING_X, Math.floor(i/20)*SPACING_Y);

  // Groups container + visuals
  interface GroupVisual { id:number; gfx: PIXI.Graphics; items: Set<number>; w:number; h:number; handle: PIXI.Graphics; }
  const groupLayer = new PIXI.Container();
  const cardLayer = new PIXI.Container();
  world.addChild(groupLayer);
  world.addChild(cardLayer);
  sprites.forEach(s=> cardLayer.addChild(s));
  world.sortableChildren = true;
  groupLayer.zIndex = 0; cardLayer.zIndex = 10;
  const groups = new Map<number, GroupVisual>();

  function createGroupVisual(id:number, x:number, y:number, w=300, h=300) {
    const gfx = new PIXI.Graphics();
    gfx.x = x; gfx.y = y; gfx.zIndex = 1; gfx.eventMode='static'; gfx.cursor='pointer';
    const handle = new PIXI.Graphics(); handle.eventMode='static'; handle.cursor='nwse-resize';
    const gv: GroupVisual = { id, gfx, items: new Set(), w, h, handle };
    drawGroup(gv, false);
    groupLayer.addChild(gfx);
    gfx.addChild(handle);
    groups.set(id, gv);
    attachGroupInteractions(gv);
    attachResizeHandle(gv);
    return gv;
  }

  function drawGroup(gv: GroupVisual, selected:boolean) {
    const {gfx,w,h,handle} = gv;
    gfx.clear();
    gfx.roundRect(0,0,w,h,12).stroke({color: selected?0x33bbff:0x555555,width:selected?4:2}).fill({color:0x222222, alpha:0.25});
    handle.clear();
    handle.rect(0,0,14,14).fill({color:0xffffff}).stroke({color:selected?0x33bbff:0x555555,width:1});
    handle.x = w-14; handle.y = h-14;
    // (single layout mode: grid) optional indicator removed
  }

  function attachResizeHandle(gv: GroupVisual) {
    const h = gv.handle; let resizing=false; let startW=0; let startH=0; let anchorX=0; let anchorY=0;
    h.on('pointerdown', e=> { e.stopPropagation(); const local = world.toLocal(e.global); resizing = true; startW = gv.w; startH = gv.h; anchorX = local.x; anchorY = local.y; });
  app.stage.on('pointermove', e=> { if (!resizing) return; const local = world.toLocal(e.global); const dw = local.x - anchorX; const dh = local.y - anchorY; gv.w = Math.max(120, snap(startW + dw)); gv.h = Math.max(160, snap(startH + dh)); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); layoutGroup(gv); });
    function endResize() { if (resizing) resizing=false; }
    app.stage.on('pointerup', endResize); app.stage.on('pointerupoutside', endResize);
  }

  function attachGroupInteractions(gv: GroupVisual) {
    let drag=false; let dx=0; let dy=0; const g=gv.gfx; let memberOffsets: {sprite:CardSprite, ox:number, oy:number}[] = [];
    g.on('pointerdown', e=> {
      if (!e.shiftKey && !SelectionStore.state.groupIds.has(gv.id)) SelectionStore.selectOnlyGroup(gv.id); else if (e.shiftKey) SelectionStore.toggleGroup(gv.id);
      const local = world.toLocal(e.global);
      drag = true; dx = local.x - g.x; dy = local.y - g.y;
      memberOffsets = [...gv.items].map(id=> { const s = sprites.find(sp=> sp.__id===id); return s? {sprite:s, ox: s.x - g.x, oy: s.y - g.y}: null; }).filter(Boolean) as any;
    });
    app.stage.on('pointermove', e=> { if (!drag) return; const local = world.toLocal(e.global); g.x = local.x - dx; g.y = local.y - dy; memberOffsets.forEach(m=> { m.sprite.x = g.x + m.ox; m.sprite.y = g.y + m.oy; }); });
    app.stage.on('pointerup', ()=> { if (!drag) return; drag=false; g.x = snap(g.x); g.y = snap(g.y); memberOffsets.forEach(m=> { m.sprite.x = snap(m.sprite.x); m.sprite.y = snap(m.sprite.y); }); });
  }

  // Simple button: press G to create group around selection bounds
  function computeSelectionBounds() {
    const ids = SelectionStore.getCards();
    if (!ids.length) return null;
    const selectedSprites = sprites.filter(s=> ids.includes(s.__id));
    const minX = Math.min(...selectedSprites.map(s=> s.x));
    const minY = Math.min(...selectedSprites.map(s=> s.y));
    const maxX = Math.max(...selectedSprites.map(s=> s.x+100));
    const maxY = Math.max(...selectedSprites.map(s=> s.y+140));
    return {minX,minY,maxX,maxY};
  }

  window.addEventListener('keydown', e=> {
    if (e.key==='g' || e.key==='G') {
      const id = groups.size ? Math.max(...groups.keys())+1 : 1;
      const b = computeSelectionBounds();
      if (b) {
        const gv = createGroupVisual(id, b.minX-20, b.minY-20, (b.maxX-b.minX)+40, (b.maxY-b.minY)+40);
        gv.items = new Set(SelectionStore.getCards());
        gv.items.forEach(cid=> { const s = sprites.find(sp=> sp.__id===cid); if (s) s.__groupId = gv.id; });
        layoutGroup(gv);
        SelectionStore.clear(); SelectionStore.toggleGroup(id);
      } else {
        const center = new PIXI.Point(window.innerWidth/2, window.innerHeight/2);
        const worldCenter = world.toLocal(center);
        const gv = createGroupVisual(id, snap(worldCenter.x - 150), snap(worldCenter.y - 150), 300, 300);
        layoutGroup(gv);
        SelectionStore.clear(); SelectionStore.toggleGroup(id);
      }
    }
  // Removed layout mode toggle (only grid layout exists now)
    if (e.key==='Delete') {
      const cardIds = SelectionStore.getCards();
      const groupIds = SelectionStore.getGroups();
      if (cardIds.length) {
        const touchedGroups = new Set<number>();
        cardIds.forEach(id=> { const idx = sprites.findIndex(s=> s.__id===id); if (idx>=0) { const s = sprites[idx]; const gid = s.__groupId; if (gid) { const gv = groups.get(gid); gv && gv.items.delete(s.__id); touchedGroups.add(gid); } s.destroy(); sprites.splice(idx,1); } });
        touchedGroups.forEach(gid=> { const gv = groups.get(gid); if (gv) layoutGroup(gv); });
      }
      if (groupIds.length) {
        groupIds.forEach(id=> { const gv = groups.get(id); if (gv) { gv.gfx.destroy(); groups.delete(id);} });
      }
      SelectionStore.clear();
    }
  });

  world.sortableChildren = true;

  let dragState: null | {
    sprites: CardSprite[];
    offsets: {sprite:CardSprite, dx:number, dy:number}[];
  } = null;

  function attachCardInteractions(g: CardSprite) {
    g.on('pointerdown', (e)=>{
      if (!e.shiftKey && !SelectionStore.state.cardIds.has(g.__id)) SelectionStore.selectOnlyCard(g.__id); else if (e.shiftKey) SelectionStore.toggleCard(g.__id);
      const selectedIds = SelectionStore.getCards();
      const dragSprites = sprites.filter(s=> selectedIds.includes(s.__id));
      const startLocal = world.toLocal(e.global);
      dragState = { sprites: dragSprites, offsets: dragSprites.map(s=> ({sprite:s, dx: startLocal.x - s.x, dy: startLocal.y - s.y})) };
      dragSprites.forEach(s=> s.zIndex = 100000 + s.__baseZ);
    });
  }

  function endDrag(commit:boolean) {
    if (!dragState) return;
    // Restore z
    dragState.sprites.forEach(s=> s.zIndex = s.__baseZ);
  if (commit) { dragState.sprites.forEach(s=> { s.x = snap(s.x); s.y = snap(s.y); assignCardToGroupByPosition(s); }); }
    dragState=null;
  }

  app.stage.on('pointerup', ()=> endDrag(true));
  app.stage.on('pointerupoutside', ()=> endDrag(true));
  app.stage.on('pointermove', (e)=>{ if (!dragState) return; const local = world.toLocal(e.global); for (const off of dragState.offsets) { off.sprite.x = local.x - off.dx; off.sprite.y = local.y - off.dy; } });

  // Selection visualization (simple outline)
  SelectionStore.on(()=>{
    const ids = SelectionStore.getCards();
    const gsel = SelectionStore.getGroups();
    groups.forEach(gv=> drawGroup(gv, gsel.includes(gv.id)));
    sprites.forEach(s=> redrawCardSprite(s, ids.includes(s.__id)));
  });

  function redrawCardSprite(s:CardSprite, selected:boolean) {
    const inGroup = !!s.__groupId;
    s.clear();
    s.rect(0,0,100,140)
      .fill({color: inGroup?0xf7f7f7:0xffffff})
      .stroke({color: selected?0x00aaff:0x000000, width: selected?4:2});
  }

  function assignCardToGroupByPosition(s:CardSprite) {
    const cx = s.x + 50; const cy = s.y + 70;
    let target: GroupVisual | null = null;
    for (const gv of groups.values()) {
      if (cx >= gv.gfx.x && cx <= gv.gfx.x + gv.w && cy >= gv.gfx.y && cy <= gv.gfx.y + gv.h) { target = gv; break; }
    }
    if (target) {
      let layoutOld: GroupVisual | undefined;
      if (s.__groupId && s.__groupId !== target.id) { const old = groups.get(s.__groupId); if (old) { old.items.delete(s.__id); layoutOld = old; } }
      s.__groupId = target.id; target.items.add(s.__id); layoutGroup(target); if (layoutOld) layoutGroup(layoutOld);
    } else if (s.__groupId) {
      const old = groups.get(s.__groupId); old && old.items.delete(s.__id); s.__groupId = undefined; if (old) layoutGroup(old);
    }
  }

  // Layout helpers
  // Layout metrics aligned to grid so auto-layout preserves alignment
  const CARD_W = 100, CARD_H = 140; // already multiples of GRID_SIZE (20)
  const PAD = GRID_SIZE;            // 20
  const GAP_X = GRID_SIZE;          // 20
  const GAP_Y = GRID_SIZE;          // 20
  function layoutGroup(gv: GroupVisual) {
    const items = [...gv.items].map(id=> sprites.find(s=> s.__id===id)).filter(Boolean) as CardSprite[];
    if (!items.length) return;
    const usableW = Math.max(1, gv.w - PAD*2);
    const cols = Math.max(1, Math.floor((usableW + GAP_X) / (CARD_W + GAP_X)));
    items.forEach((s,i)=> {
      const col=i%cols; const row=Math.floor(i/cols);
      const tx = gv.gfx.x + PAD + col*(CARD_W+GAP_X);
      const ty = gv.gfx.y + PAD + row*(CARD_H+GAP_Y);
      // snap explicitly (should already be aligned, but defensive if group x isn't snapped yet)
      s.x = snap(tx);
      s.y = snap(ty);
    });
    const rows = Math.ceil(items.length/cols); const neededH = PAD*2 + rows*CARD_H + (rows-1)*GAP_Y; if (neededH>gv.h) { gv.h = neededH; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); }
    items.forEach(s=> redrawCardSprite(s, SelectionStore.state.cardIds.has(s.__id)));
  }

  // Unified marquee + drag/resize state handlers
  interface MarqueeState { start: PIXI.Point; rect: PIXI.Graphics; additive: boolean; }
  let marqueeState: MarqueeState | null = null;
  function startMarquee(globalPoint: PIXI.PointData, additive:boolean) {
    const worldStart = world.toLocal(globalPoint);
    const rect = new PIXI.Graphics();
    world.addChild(rect);
    marqueeState = { start: new PIXI.Point(worldStart.x, worldStart.y), rect, additive };
  }
  function updateMarquee(globalPoint: PIXI.PointData) {
    if (!marqueeState) return;
    const cur = world.toLocal(globalPoint);
    const x1 = marqueeState.start.x, y1 = marqueeState.start.y, x2 = cur.x, y2 = cur.y;
    const rx = Math.min(x1,x2), ry = Math.min(y1,y2), rw = Math.abs(x2-x1), rh = Math.abs(y2-y1);
    marqueeState.rect.clear();
  marqueeState.rect.rect(rx,ry,rw,rh).fill({color:0x0088ff, alpha:0.08}).stroke({color:0x00aaff,width:1,alpha:0.9});
  (marqueeState.rect as any).__lastRect = {x:rx,y:ry,w:rw,h:rh};
  }
  function finishMarquee() {
    if (!marqueeState) return;
    const g = marqueeState.rect; const additive = marqueeState.additive;
    // Reconstruct world-space rectangle using the graphics geometry we drew
    // Because we drew at rx,ry,rw,rh in world coordinates stored implicitly via commands,
    // we can approximate from its current transform: getBounds can be affected by scale; instead store last geometry.
    // We'll embed the last computed rect on marqueeState for accuracy.
    const data = (g as any).__lastRect as {x:number,y:number,w:number,h:number} | undefined;
    let rect;
    if (data) rect = data; else {
      const b = g.getBounds(); rect = {x:b.x, y:b.y, w:b.width, h:b.height};
    }
    g.destroy(); marqueeState=null;
    const selectedIds = sprites.filter(s=> (s.x+100)>=rect.x && s.x <= rect.x + rect.w && (s.y+140)>=rect.y && s.y <= rect.y + rect.h).map(s=> s.__id);
    if (additive) {
      const next = new Set(SelectionStore.getCards()); selectedIds.forEach(id=> next.add(id));
      SelectionStore.replace({ cardIds: next, groupIds: new Set(SelectionStore.getGroups()) });
    } else {
      SelectionStore.replace({ cardIds: new Set(selectedIds), groupIds: new Set() });
    }
  }

  app.stage.on('pointerdown', e => { if (panning) return; if (e.target === app.stage || e.target === world) startMarquee(e.global, e.shiftKey); });
  app.stage.on('pointermove', e => {
    if (marqueeState) { updateMarquee(e.global); }
  });
  app.stage.on('pointerup', () => { finishMarquee(); });
  app.stage.on('pointerupoutside', () => { finishMarquee(); });

  // (Old marquee code removed; unified handlers added later.)

  // Basic wheel zoom centered at pointer
  window.addEventListener('wheel', (e) => {
    const scaleFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const mousePos = new PIXI.Point(app.renderer.events.pointer.global.x, app.renderer.events.pointer.global.y);
    const worldPosBefore = world.toLocal(mousePos);
    world.scale.x *= scaleFactor; world.scale.y *= scaleFactor;
    const worldPosAfter = world.toLocal(mousePos);
    world.position.x += (worldPosAfter.x - worldPosBefore.x) * world.scale.x;
    world.position.y += (worldPosAfter.y - worldPosBefore.y) * world.scale.y;
  });

  // Space-drag to pan
  let panning = false; let lastX=0; let lastY=0;
  window.addEventListener('keydown', e => { if (e.code==='Space') { panning = true; document.body.style.cursor='grab'; }});
  window.addEventListener('keyup', e => { if (e.code==='Space') { panning = false; document.body.style.cursor='default'; }});
  app.stage.eventMode='static';
  app.stage.on('pointerdown', e => { if (panning) { lastX = e.global.x; lastY = e.global.y; }});
  app.stage.on('pointermove', e => { if (panning && e.buttons===1) { const dx = e.global.x - lastX; const dy = e.global.y - lastY; world.position.x += dx; world.position.y += dy; lastX = e.global.x; lastY = e.global.y; }});

  // Deselect when clicking empty space
  app.stage.on('pointerdown', e => {
    if (e.target === app.stage && !panning) SelectionStore.clear();
  });
})();
