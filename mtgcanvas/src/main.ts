import * as PIXI from 'pixi.js';
import { SelectionStore } from './state/selectionStore';
import { Camera } from './scene/camera';
import { createCardSprite, updateCardSpriteAppearance, attachCardInteractions, type CardSprite, ensureCardImage, updateCardTextureForScale, preloadCardQuality, getHiResQueueLength, getInflightTextureCount } from './scene/cardNode';
import { getImageCacheStats, hasCachedURL, getCacheUsage } from './services/imageCache';
import { createGroupVisual, drawGroup, layoutGroup, type GroupVisual, HEADER_HEIGHT, setGroupCollapsed, autoPackGroup, insertionIndexForPoint, addCardToGroupOrdered, removeCardFromGroup, updateGroupTextQuality, updateGroupMetrics } from './scene/groupNode';
import { SpatialIndex } from './scene/SpatialIndex';
import { MarqueeSystem } from './interaction/marquee';
import { initHelp } from './ui/helpPanel';
import { installModeToggle } from './ui/modeToggle';
import { UIState } from './state/uiState';
import { loadAll, queuePosition } from './services/persistenceService';
import { InstancesRepo } from './data/repositories';
import { fetchCardUniverse, spawnLargeSet } from './services/largeDataset';
import { DATASET_PREFERRED, DATASET_FALLBACK } from './config/dataset';
import { ensureThemeToggleButton, ensureThemeStyles } from './ui/theme';

// Phase 1 refactor: this file now bootstraps the Pixi application and delegates to scene modules.

const GRID_SIZE = 8;  // global grid size
// To align cards to the grid while keeping them as close as possible, we need (CARD + GAP) % GRID_SIZE === 0.
// Card width=100 -> 100 % 8 = 4, so choose GAP_X=4 (smallest non-zero making 100+4=104 divisible by 8).
// Card height=140 -> 140 % 8 = 4, so choose GAP_Y=4 (makes 140+4=144 divisible by 8).
const CARD_W_GLOBAL = 100, CARD_H_GLOBAL = 140;
const GAP_X_GLOBAL = 4, GAP_Y_GLOBAL = 4; // minimal gaps achieving grid alignment
const SPACING_X = CARD_W_GLOBAL + GAP_X_GLOBAL;
const SPACING_Y = CARD_H_GLOBAL + GAP_Y_GLOBAL;
function snap(v:number) { return Math.round(v/GRID_SIZE)*GRID_SIZE; }

const app = new PIXI.Application();
(async () => {
  await app.init({ background: '#1e1e1e', resizeTo: window, antialias: true, resolution: window.devicePixelRatio || 1 });
  document.body.appendChild(app.canvas);

  const world = new PIXI.Container();
  app.stage.addChild(world);
  app.stage.eventMode='static';
  app.stage.hitArea = new PIXI.Rectangle(-50000,-50000,100000,100000);

  // Camera abstraction
  const camera = new Camera({ world });
  const spatial = new SpatialIndex();

  // Card layer & data (persisted instances)
  const sprites: CardSprite[] = []; let zCounter=1;
  function createSpriteForInstance(inst:{id:number,x:number,y:number,z:number, card?:any}) {
    const s = createCardSprite({ id: inst.id, x: inst.x, y: inst.y, z: inst.z ?? zCounter++, renderer: app.renderer, card: inst.card });
    world.addChild(s); sprites.push(s);
    spatial.insert({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 });
  attachCardInteractions(s, ()=>sprites, world, app.stage, moved=> moved.forEach(ms=> {
      spatial.update({ id: ms.__id, minX:ms.x, minY:ms.y, maxX:ms.x+100, maxY:ms.y+140 });
      assignCardToGroupByPosition(ms);
      queuePosition(ms);
  }), ()=>panning, (global, additive)=> marquee.start(global, additive));
    return s;
  }
  const loaded = loadAll();
  if (!loaded.instances.length) {
    (async ()=> {
      const universe = await fetchCardUniverse();
      if (universe.length) {
  const TARGET = universe.length; // load entire provided dataset
  console.log(`[startup] spawning FULL dataset (${DATASET_PREFERRED} | fallback ${DATASET_FALLBACK}) count=`, TARGET);
  await spawnLargeSet(universe, inst=> { createSpriteForInstance(inst); }, { count: TARGET, batchSize: 800, onProgress:(done,total)=> { if (done===total) { console.log('[startup] full spawn complete'); fitAll(); } } });
      } else {
  console.warn(`[startup] dataset (${DATASET_PREFERRED}/${DATASET_FALLBACK}) not found or empty; falling back to 200 dummy cards`);
        for (let i=0;i<200;i++) { const x=(i%20)*SPACING_X, y=Math.floor(i/20)*SPACING_Y; const id = InstancesRepo.create(1, x, y); createSpriteForInstance({ id, x, y, z:zCounter++ }); }
        fitAll();
      }
    })();
  } else { loaded.instances.forEach((inst:any)=> createSpriteForInstance(inst)); }

  // Groups container + visuals
  const groups = new Map<number, GroupVisual>();
  world.sortableChildren = true;

  const help = initHelp(); help.ensureFab(); (window as any).__helpAPI = help; // debug access
  function toggleHelp() { help.toggle(); }

  // Inline group renaming (kept local for now)
  function startGroupRename(gv: GroupVisual) {
    // Avoid multiple editors
    if (document.getElementById(`group-rename-${gv.id}`)) return;
    const input = document.createElement('input');
    input.id = `group-rename-${gv.id}`;
    input.type = 'text';
    input.value = gv.name;
    input.maxLength = 64;
    // Position over header using screen coordinates
    const bounds = app.renderer.canvas.getBoundingClientRect();
    // Transform group header position to screen
    const global = new PIXI.Point(gv.gfx.x, gv.gfx.y);
    const pt = world.toGlobal(global);
    const scale = world.scale.x; // approximate uniform scale
  const headerHeight = HEADER_HEIGHT * scale; // retained for potential future use
    input.style.position = 'fixed';
    input.style.left = `${bounds.left + pt.x + 6}px`;
    input.style.top = `${bounds.top + pt.y + 4}px`;
    input.style.zIndex = '10000';
    input.style.padding = '3px 6px';
    input.style.font = '12px "Inter", system-ui, sans-serif';
    input.style.color = '#fff';
    input.style.background = '#1c2a33';
    input.style.border = '1px solid #3d6175';
    input.style.borderRadius = '4px';
    input.style.outline = 'none';
    input.style.width = `${Math.max(80, Math.min(240, gv.w * scale - 20))}px`;
    document.body.appendChild(input);
    input.select();
    function commit(save:boolean) {
      if (save) { const val = input.value.trim(); if (val) { gv.name = val; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); } }
      input.remove();
    }
    input.addEventListener('keydown', ev=> {
      if (ev.key==='Enter') { commit(true); }
      else if (ev.key==='Escape') { commit(false); }
    });
    input.addEventListener('blur', ()=> commit(true));
  }

  function attachResizeHandle(gv: GroupVisual) {
  const r = gv.resize; let resizing=false; let startW=0; let startH=0; let anchorX=0; let anchorY=0;
  r.on('pointerdown', e=> { if (gv.collapsed) return; e.stopPropagation(); const local = world.toLocal(e.global); resizing = true; startW = gv.w; startH = gv.h; anchorX = local.x; anchorY = local.y; });
  app.stage.on('pointermove', e=> { if (!resizing) return; const local = world.toLocal(e.global); const dw = local.x - anchorX; const dh = local.y - anchorY; gv.w = Math.max(160, snap(startW + dw)); gv.h = Math.max(HEADER_HEIGHT+80, snap(startH + dh)); gv._expandedH = gv.h; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.x+140 })); });
    const endResize=()=>{ if (resizing) resizing=false; };
    app.stage.on('pointerup', endResize); app.stage.on('pointerupoutside', endResize);
  }

  function attachGroupInteractions(gv: GroupVisual) {
    let drag=false; let dx=0; let dy=0; const g=gv.gfx; let memberOffsets: {sprite:CardSprite, ox:number, oy:number}[] = [];
    gv.header.eventMode='static'; gv.header.cursor='move';
  gv.header.on('pointerdown', (e:any)=> { e.stopPropagation(); if (e.button===2) return; // right-click handled separately
      if (!e.shiftKey && !SelectionStore.state.groupIds.has(gv.id)) SelectionStore.selectOnlyGroup(gv.id); else if (e.shiftKey) SelectionStore.toggleGroup(gv.id); const local = world.toLocal(e.global); drag=true; dx = local.x - g.x; dy = local.y - g.y; memberOffsets = [...gv.items].map(id=> { const s = sprites.find(sp=> sp.__id===id); return s? {sprite:s, ox:s.x - g.x, oy:s.y - g.y}: null; }).filter(Boolean) as any; });
    gv.header.on('pointertap', (e:any)=> { if (e.detail===2 && e.button!==2) startGroupRename(gv); });
    // Context menu (right-click)
    // Show context menu only if no significant right-drag (panning) occurred.
    gv.header.on('rightclick', (e:any)=> {
      e.stopPropagation();
      if (rightPanning) return; // if we dragged, skip menu
      showGroupContextMenu(gv, e.global);
    });
  // Group body interactions handled globally like canvas now.
  app.stage.on('pointermove', e=> { if (!drag) return; const local = world.toLocal(e.global); g.x = local.x - dx; g.y = local.y - dy; memberOffsets.forEach(m=> { m.sprite.x = g.x + m.ox; m.sprite.y = g.y + m.oy; }); });
  app.stage.on('pointerup', ()=> { if (!drag) return; drag=false; g.x = snap(g.x); g.y = snap(g.y); memberOffsets.forEach(m=> { m.sprite.x = snap(m.sprite.x); m.sprite.y = snap(m.sprite.y); spatial.update({ id:m.sprite.__id, minX:m.sprite.x, minY:m.sprite.y, maxX:m.sprite.x+100, maxY:m.sprite.y+140 }); }); });
  }

  // ---- Group context menu (Groups V2) ----
  let groupMenu: HTMLDivElement | null = null; let menuTarget: GroupVisual | null = null;
  const PALETTE = [0x2d3e53,0x444444,0x554433,0x224433,0x333355,0x553355,0x335555,0x4a284a,0x3c4a28,0x284a4a];
  function ensureGroupMenu(){
    if (groupMenu) return groupMenu; const el = document.createElement('div'); groupMenu = el;
  el.style.cssText='position:fixed;z-index:10001;background:#101820;border:1px solid #2d4652;border-radius:6px;min-width:200px;font:14px/1.5 "Inter",system-ui,sans-serif;color:#d0e7f1;box-shadow:0 4px 18px -4px #000c;padding:6px 6px 4px;';
    el.addEventListener('mousedown', ev=> ev.stopPropagation());
    document.body.appendChild(el); return el;
  }
  function hideGroupMenu(){ if (groupMenu){ groupMenu.style.display='none'; menuTarget=null; } }
  window.addEventListener('pointerdown', ()=> hideGroupMenu());
  function showGroupContextMenu(gv: GroupVisual, globalPt: PIXI.Point){
    const el = ensureGroupMenu(); menuTarget = gv; el.innerHTML='';
  function addItem(label:string, action:()=>void){ const it=document.createElement('div'); it.textContent=label; it.style.cssText='padding:6px 10px;cursor:pointer;border-radius:4px;'; it.onmouseenter=()=> it.style.background='#1d3440'; it.onmouseleave=()=> it.style.background='transparent'; it.onclick=()=> { action(); hideGroupMenu(); }; el.appendChild(it); }
  addItem(gv.collapsed? 'Expand':'Collapse', ()=> { if (gv.collapsed){ setGroupCollapsed(gv,false,sprites); layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); } else { setGroupCollapsed(gv,true,sprites); } });
  addItem('Auto-pack', ()=> { autoPackGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); });
    addItem('Rename', ()=> startGroupRename(gv));
  addItem('Recolor', ()=> { gv.color = PALETTE[Math.floor(Math.random()*PALETTE.length)]; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); });
    addItem('Delete', ()=> { const row = groups.get(gv.id); if (row){ row.gfx.destroy(); groups.delete(gv.id);} SelectionStore.clear(); });
    const sw=document.createElement('div'); sw.style.cssText='display:flex;gap:4px;padding:4px 6px 2px;flex-wrap:wrap;';
    PALETTE.forEach(c=> { const sq=document.createElement('div'); sq.style.cssText=`width:16px;height:16px;border-radius:4px;background:#${c.toString(16).padStart(6,'0')};cursor:pointer;border:1px solid #182830;`; sq.onclick=()=> { gv.color=c; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); hideGroupMenu(); }; sw.appendChild(sq); });
    el.appendChild(sw);
    const bounds = app.renderer.canvas.getBoundingClientRect();
    el.style.left = `${bounds.left + globalPt.x + 4}px`;
    el.style.top = `${bounds.top + globalPt.y + 4}px`;
    el.style.display='block';
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
  // (Alt previously disabled snapping; feature removed)
  if (e.key==='g' || e.key==='G') {
      const id = groups.size ? Math.max(...groups.keys())+1 : 1;
      const b = computeSelectionBounds();
      if (b) {
        const gv = createGroupVisual(id, b.minX-20, b.minY-20, (b.maxX-b.minX)+40, (b.maxY-b.minY)+40);
        const ids = SelectionStore.getCards();
        ids.forEach(cid=> { addCardToGroupOrdered(gv, cid, gv.order.length); const s = sprites.find(sp=> sp.__id===cid); if (s) s.__groupId = gv.id; });
  groups.set(id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv);
  layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, true);
        SelectionStore.clear(); SelectionStore.toggleGroup(id);
      } else {
        const center = new PIXI.Point(window.innerWidth/2, window.innerHeight/2);
        const worldCenter = world.toLocal(center);
        const gv = createGroupVisual(id, snap(worldCenter.x - 150), snap(worldCenter.y - 150), 300, 300);
  groups.set(id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv);
  layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, true);
        SelectionStore.clear(); SelectionStore.toggleGroup(id);
      }
    }
    // Stress test: Shift+G generate 1000 cards in spiral for perf profiling
    if ((e.key==='g' || e.key==='G') && e.shiftKey && e.altKey) {
      const base = sprites.length;
      const center = world.toLocal(new PIXI.Point(window.innerWidth/2, window.innerHeight/2));
      for (let i=0;i<1000;i++) {
        const angle = i * 0.35; const radius = 20 + i * 4;
        const x = snap(center.x + Math.cos(angle)*radius);
        const y = snap(center.y + Math.sin(angle)*radius);
        const id = InstancesRepo.create(1, x, y);
        createSpriteForInstance({ id, x, y, z:zCounter++ });
      }
      console.log('[stress] added 1000 cards. Total=', sprites.length, 'Added=', sprites.length-base);
    }
    // Removed layout mode toggle (only grid layout exists now)

    // Select all (Ctrl+A)
    if ((e.key==='a' || e.key==='A') && (e.ctrlKey||e.metaKey)) { e.preventDefault(); SelectionStore.replace({ cardIds: new Set(sprites.map(s=> s.__id)), groupIds: new Set() }); }
    // Clear selection (Esc)
    if (e.key==='Escape') { SelectionStore.clear(); }
  // Duplicate removed
    // Rename single selected group (F2) inline
    if (e.key==='F2') {
      const gids = SelectionStore.getGroups(); if (gids.length===1) { const gv = groups.get(gids[0]); if (gv) startGroupRename(gv); }
    }
    // Nudge selected cards by arrow keys (Shift = larger step)
    const ARROW_KEYS = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
  if (ARROW_KEYS.includes(e.key)) {
      const step = (e.shiftKey? GRID_SIZE*5 : GRID_SIZE);
      const dx = e.key==='ArrowLeft'? -step : e.key==='ArrowRight'? step : 0;
      const dy = e.key==='ArrowUp'? -step : e.key==='ArrowDown'? step : 0;
      if (dx||dy) {
        e.preventDefault();
  SelectionStore.getCards().forEach(id=> { const s = sprites.find(sp=> sp.__id===id); if (!s) return; s.x += dx; s.y += dy; spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 }); assignCardToGroupByPosition(s); });
      }
    }
    // Zoom shortcuts (+ / - / 0 reset, F fit all, Shift+F fit selection, Z fit selection)
    if ((e.key==='+' || e.key==='=' ) && (e.ctrlKey||e.metaKey)) { e.preventDefault(); keyboardZoom(1.1); }
    if (e.key==='-' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); keyboardZoom(0.9); }
    if (e.key==='0' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); resetZoom(); }
    if (e.key==='f' || e.key==='F') { if (e.shiftKey) fitSelection(); else fitAll(); }
    if (e.key==='z' || e.key==='Z') { fitSelection(); }
  // Large dataset load (Ctrl+Shift+L): progressive spawn using legal.json/all.json
    if ((e.key==='l' || e.key==='L') && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      console.log('[largeDataset] begin load');
      fetchCardUniverse().then(cards=> {
        if (!cards.length) { console.warn('[largeDataset] no cards loaded'); return; }
        const target = 3000; // adjustable
        const startCount = sprites.length;
        spawnLargeSet(cards, inst=> { createSpriteForInstance(inst); }, { count: target, batchSize: 400, onProgress:(done,total)=> {
          if (done===total) { console.log(`[largeDataset] spawned ${total} cards (total now ${sprites.length})`); }
          if ((done % 800)===0 || done===total) updatePerf(0);
        }}).then(()=> { console.log('[largeDataset] complete'); fitAll(); });
      });
    }
    // Collapse / expand selected groups (C)
    if (e.key==='c' || e.key==='C') {
      const gids = SelectionStore.getGroups();
      if (gids.length){
        e.preventDefault();
  gids.forEach(id=> { const gv = groups.get(id); if (!gv) return; const next = !gv.collapsed; if (next) { setGroupCollapsed(gv, true, sprites); } else { setGroupCollapsed(gv, false, sprites); layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); } });
      }
    }
    // Help overlay toggle (H or ?)
    if (e.key==='h' || e.key==='H' || e.key==='?') {
      if (e.repeat) return; // ignore auto-repeat
      (e as any).__helpHandled = true;
      toggleHelp();
    }
  // (Alt snap override removed)
    if (e.key==='Delete') {
      const cardIds = SelectionStore.getCards();
      const groupIds = SelectionStore.getGroups();
      if (cardIds.length) {
        const touchedGroups = new Set<number>();
        cardIds.forEach(id=> { const idx = sprites.findIndex(s=> s.__id===id); if (idx>=0) { const s = sprites[idx]; const gid = s.__groupId; if (gid) { const gv = groups.get(gid); gv && gv.items.delete(s.__id); touchedGroups.add(gid); } s.destroy(); sprites.splice(idx,1); } });
  touchedGroups.forEach(gid=> { const gv = groups.get(gid); if (gv) layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); });
      }
      if (groupIds.length) {
        groupIds.forEach(id=> { const gv = groups.get(id); if (gv) { gv.gfx.destroy(); groups.delete(id);} });
      }
      SelectionStore.clear();
    }
  });

  world.sortableChildren = true;

  // Card drag handled in cardNode module (local state per card set)

  // Selection visualization (simple outline)
  SelectionStore.on(()=> { const ids = SelectionStore.getCards(); const gsel = SelectionStore.getGroups(); groups.forEach(gv=> drawGroup(gv, gsel.includes(gv.id))); sprites.forEach(s=> updateCardSpriteAppearance(s, ids.includes(s.__id))); });

  function assignCardToGroupByPosition(s:CardSprite) {
    const cx = s.x + 50; const cy = s.y + 70; // card center
    let target: GroupVisual | null = null;
    for (const gv of groups.values()) {
      if (cx >= gv.gfx.x && cx <= gv.gfx.x + gv.w && cy >= gv.gfx.y && cy <= gv.gfx.y + gv.h) { target = gv; break; }
    }
    if (target) {
      // If moving between groups remove from old
      let layoutOld: GroupVisual | undefined;
      if (s.__groupId && s.__groupId !== target.id) { const old = groups.get(s.__groupId); if (old) { removeCardFromGroup(old, s.__id); layoutOld = old; } }
      if (!s.__groupId || s.__groupId !== target.id) {
        const insertIdx = insertionIndexForPoint(target, cx, cy);
        addCardToGroupOrdered(target, s.__id, insertIdx);
        s.__groupId = target.id;
      } else {
        // Reposition within same group if significant horizontal move
        const gv = groups.get(s.__groupId); if (gv){ const desired = insertionIndexForPoint(gv, cx, cy); const curIdx = gv.order.indexOf(s.__id); if (desired!==curIdx && desired>=0){ gv.order.splice(curIdx,1); gv.order.splice(Math.min(desired, gv.order.length),0,s.__id); } }
      }
  layoutGroup(target, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(target, sprites); if (layoutOld) { layoutGroup(layoutOld, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(layoutOld, sprites); drawGroup(layoutOld, SelectionStore.state.groupIds.has(layoutOld.id)); } drawGroup(target, SelectionStore.state.groupIds.has(target.id));
    } else if (s.__groupId) {
  const old = groups.get(s.__groupId); if (old){ removeCardFromGroup(old, s.__id); } s.__groupId = undefined; if (old) { layoutGroup(old, sprites, sc=> spatial.update({ id:sc.__id, minX:sc.x, minY:sc.y, maxX:sc.x+100, maxY:sc.y+140 })); updateGroupMetrics(old, sprites); drawGroup(old, SelectionStore.state.groupIds.has(old.id)); }
    }
  }

  // Layout constants removed from bootstrap (encapsulated in layout system)

  // Unified marquee + drag/resize state handlers
  const marquee = new MarqueeSystem(world, app.stage, ()=>sprites, rect=> {
    const found = spatial.search(rect.x, rect.y, rect.x+rect.w, rect.y+rect.h);
    const idSet = new Set(found.map(f=> f.id));
    const x1 = rect.x, y1 = rect.y, x2 = rect.x + rect.w, y2 = rect.y + rect.h;
    return sprites.filter(s=> {
      if (!idSet.has(s.__id)) return false;
      const cx = s.x + 50; const cy = s.y + 70; // center point
      return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
    });
  });

  app.stage.on('pointerdown', e => {
    if (panning || (e as any).button===2) return;
    const tgt:any = e.target;
    const groupBody = tgt && tgt.__groupBody;
    if (e.target === app.stage || e.target === world || groupBody) {
      // Clear selection unless additive
      if (!e.shiftKey) SelectionStore.clear();
      marquee.start(e.global, e.shiftKey);
    }
  });
  app.stage.on('pointermove', e => { if (marquee.isActive()) marquee.update(e.global); });
  app.stage.on('pointerup', () => { if (marquee.isActive()) marquee.finish(); });
  app.stage.on('pointerupoutside', () => { if (marquee.isActive()) marquee.finish(); });

  // (Old marquee code removed; unified handlers added later.)

  // Zoom helpers (declared early so keyboard shortcuts can reference)
  let applyZoom = (scaleFactor:number, centerGlobal: PIXI.Point) => { camera.zoomAt(scaleFactor, centerGlobal); };
  // Aggressive upgrade: after zoom adjust, request higher-quality textures for visible cards immediately
  function postZoomUpgrade(){ const scale = world.scale.x; for (const s of sprites){ if (s.visible && s.__imgLoaded) { updateCardTextureForScale(s, scale); } } }
  const origApplyZoom = applyZoom;
  // Wrap applyZoom to call postZoomUpgrade after next frame
  const wrappedZoom = (f:number, pt: PIXI.Point)=> { origApplyZoom(f, pt); queueMicrotask(()=> postZoomUpgrade()); };
  applyZoom = wrappedZoom;
  function keyboardZoom(f:number) { const center = new PIXI.Point(window.innerWidth/2, window.innerHeight/2); applyZoom(f, center); }
  function resetZoom() { const center = new PIXI.Point(window.innerWidth/2, window.innerHeight/2); world.scale.set(1); world.position.set(0,0); applyZoom(1, center); }
  function computeBoundsFromSprites(list:CardSprite[]) { if (!list.length) return null; const rects = list.map(s=> ({x:s.x,y:s.y,w:100,h:140})); return mergeRects(rects); }
  function mergeRects(rects:{x:number,y:number,w:number,h:number}[]) {
    const minX = Math.min(...rects.map(r=> r.x));
    const minY = Math.min(...rects.map(r=> r.y));
    const maxX = Math.max(...rects.map(r=> r.x + r.w));
    const maxY = Math.max(...rects.map(r=> r.y + r.h));
    return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};
  }
  function computeAllBounds() { return computeBoundsFromSprites(sprites); }
  function fitBounds(b:{x:number,y:number,w:number,h:number}|null) { camera.fitBounds(b, {w:window.innerWidth, h:window.innerHeight}); }
  function computeSelectionOrGroupsBounds() {
    const ids = SelectionStore.getCards();
    const gids = SelectionStore.getGroups();
    const cardSprites = sprites.filter(s=> ids.includes(s.__id));
    const groupSprites = gids.map(id=> groups.get(id)).filter(Boolean) as GroupVisual[];
    if (!cardSprites.length && !groupSprites.length) return null;
    const rects: {x:number,y:number,w:number,h:number}[] = [];
    cardSprites.forEach(s=> rects.push({x:s.x,y:s.y,w:100,h:140}));
    groupSprites.forEach(gv=> rects.push({x:gv.gfx.x,y:gv.gfx.y,w:gv.w,h:gv.h}));
    return mergeRects(rects);
  }
  function fitAll() { fitBounds(computeAllBounds()); }
  function fitSelection() { const b = computeSelectionOrGroupsBounds(); if (b) fitBounds(b); }
  window.addEventListener('wheel', (e) => { const mousePos = new PIXI.Point(app.renderer.events.pointer.global.x, app.renderer.events.pointer.global.y); applyZoom(e.deltaY < 0 ? 1.1 : 0.9, mousePos); }, { passive: true });

  // Pan modes: space+left, middle button, or right button drag (on empty canvas/world area)
  let panning = false;          // spacebar modifier for left button
  let rightPanning = false;     // active right-button pan
  let midPanning = false;       // active middle-button pan
  let lastX=0; let lastY=0;
  window.addEventListener('keydown', e => { if (e.code==='Space') { panning = true; document.body.style.cursor='grab'; }});
  window.addEventListener('keyup', e => { if (e.code==='Space') { panning = false; if (!rightPanning && !midPanning) document.body.style.cursor='default'; }});
  app.stage.eventMode='static';
  function beginPan(x:number,y:number){ lastX=x; lastY=y; document.body.style.cursor='grabbing'; }
  function applyPan(e:PIXI.FederatedPointerEvent){ const dx = e.global.x - lastX; const dy = e.global.y - lastY; world.position.x += dx; world.position.y += dy; lastX = e.global.x; lastY = e.global.y; }
  app.stage.on('pointerdown', e => {
    if (panning && e.button===0) beginPan(e.global.x, e.global.y);
    // Right button: allow panning start anywhere (cards, empty space); context menus still fire on rightclick if no movement
    if (e.button===2) { rightPanning = true; beginPan(e.global.x, e.global.y); }
  });
  app.stage.on('pointermove', e => {
    if ((panning && (e.buttons & 1)) || (rightPanning && (e.buttons & 2)) || (midPanning && (e.buttons & 4))) applyPan(e);
  });
  const endPan = (e:PIXI.FederatedPointerEvent) => {
    if (e.button===2 && rightPanning) { rightPanning=false; if (!panning && !midPanning) document.body.style.cursor='default'; }
  };
  app.stage.on('pointerup', endPan); app.stage.on('pointerupoutside', endPan);
  // Middle button (direct on canvas element)
  app.canvas.addEventListener('pointerdown', ev => { const pev=ev as PointerEvent; if (pev.button===1) { midPanning=true; beginPan(pev.clientX, pev.clientY); } });
  app.canvas.addEventListener('pointerup', ev => { const pev=ev as PointerEvent; if (pev.button===1) { midPanning=false; if (!panning && !rightPanning) document.body.style.cursor='default'; } });
  app.canvas.addEventListener('mouseleave', () => { if (midPanning || rightPanning) { midPanning=false; rightPanning=false; if (!panning) document.body.style.cursor='default'; } });
  app.canvas.addEventListener('contextmenu', ev => { ev.preventDefault(); });

  // Deselect when clicking empty space (ignore while panning via any mode)

  // Debug: log card count after seeding
  console.log('[mtgcanvas] Seeded cards:', sprites.length);

  // (Removed blocking hi-res preload progress bar; images now load lazily as needed.)

  // ---- Performance overlay ----
  ensureThemeStyles();
  // Remove theme toggle FAB if it exists (user requested removal)
  const oldThemeBtn = document.getElementById('theme-toggle-btn'); if (oldThemeBtn) oldThemeBtn.remove();
  const perfEl = document.createElement('div'); perfEl.id='perf-overlay';
  // Use shared panel theme (ensure fixed positioning & stacking above canvas)
  perfEl.className='ui-panel perf-grid';
  perfEl.style.position='fixed';
  perfEl.style.left='6px';
  perfEl.style.top='6px';
  perfEl.style.zIndex='10002';
  perfEl.style.minWidth='260px';
  perfEl.style.padding='10px 12px';
  perfEl.style.pointerEvents='none';
  document.body.appendChild(perfEl);
  (window as any).__perfOverlay = perfEl;
  let frameCount=0; let lastFpsTime=performance.now(); let fps=0;
  let lastMemSample = 0; let jsHeapLine='JS ?'; let texLine='Tex ?';
  let texResLine='Res ?'; let hiResPendingLine='GlobalPending ?'; let qualLine='Qual ?'; let queueLine='Q ?';
  function sampleMemory(){
    // JS heap (Chrome only):
    const anyPerf: any = performance as any;
    if (anyPerf && anyPerf.memory) {
      const used = anyPerf.memory.usedJSHeapSize; const mb = used/1048576; jsHeapLine = `JS ${(mb).toFixed(1)} MB`; }
    else jsHeapLine = 'JS n/a';
    // Rough texture memory estimate (unique baseTextures)
    const seen = new Set<any>(); let bytes=0;
    let hi=0, med=0, low=0, pending=0; let q0=0,q1=0,q2=0,loading=0;
  for (const s of sprites){ const tex:any = s.texture; const bt = tex?.baseTexture || tex?.source?.baseTexture || tex?.source; if (!bt) continue; if (!seen.has(bt)) { seen.add(bt); const w = bt.width || bt.realWidth || bt.resource?.width; const h = bt.height || bt.realHeight || bt.resource?.height; if (w&&h) bytes += w*h*4; if (h>=1000) hi++; else if (h>=500) med++; else low++; } }
  // Global pending (ignores visibility)
  for (const s of sprites){ if (s.__imgLoaded && s.__qualityLevel !== 2) pending++; const q = s.__qualityLevel; if (q===0) q0++; else if (q===1) q1++; else if (q===2) q2++; if (s.__hiResLoading||s.__imgLoading) loading++; }
  texResLine = `TexRes low:${low} med:${med} hi:${hi}`; hiResPendingLine = `GlobalPending ${pending}`;
    qualLine = `Qual q0:${q0} q1:${q1} q2:${q2} load:${loading}`;
    queueLine = `HiQ len:${getHiResQueueLength()} inflight:${getInflightTextureCount()}`;
    texLine = `Tex ~${(bytes/1048576).toFixed(1)} MB`;
  }
  function updatePerf(dt:number){ frameCount++; const now=performance.now(); if (now-lastFpsTime>500){ fps = Math.round(frameCount*1000/(now-lastFpsTime)); frameCount=0; lastFpsTime=now; }
    if (now - lastMemSample > 1000){ sampleMemory(); lastMemSample = now; }
    const stats = getImageCacheStats();
    if ((now & 0x3ff) === 0) { // periodic usage refresh
      getCacheUsage().then(u=> { (perfEl as any).__usage = u; });
    }
    const usage = (perfEl as any).__usage;
  perfEl.textContent = 
    `Status / Performance\n`+
    ` FPS: ${fps}\n`+
    ` Zoom: ${world.scale.x.toFixed(2)}x\n`+
    ` JS Heap: ${jsHeapLine.replace('JS ','')}\n`+
    `\nCards\n`+
    ` Total Cards: ${sprites.length}\n`+
    `\nImages / Textures\n`+
    ` GPU Tex Mem: ${texLine.replace('Tex ','')}\n`+
    ` Unique Tex Res: ${texResLine.replace('TexRes ','')}\n`+
    ` Hi-Res Pending: ${hiResPendingLine.replace('GlobalPending ','')}\n`+
    ` Quality Levels: ${qualLine.replace('Qual ','').replace(/q0:/,'small:').replace(/q1:/,'mid:').replace(/q2:/,'hi:').replace('load:','loading:')}\n`+
    ` Hi-Res Queue Len: ${getHiResQueueLength()}\n`+
    ` In-Flight Decodes: ${getInflightTextureCount()}\n`+
    `\nCache Layers\n`+
    ` Session Hits: ${stats.sessionHits}  IDB Hits: ${stats.idbHits}  Canonical Hits: ${stats.canonicalHits}\n`+
    `\nNetwork\n`+
    ` Fetches: ${stats.netFetches}  Data: ${(stats.netBytes/1048576).toFixed(1)} MB\n`+
    ` Errors: ${stats.netErrors}  Resource Exhaust: ${stats.resourceErrors}\n`+
    ` Active Fetches: ${stats.activeFetches}  Queued: ${stats.queuedFetches}\n`+
    ` Last Fetch Duration: ${stats.lastNetMs.toFixed(1)} ms\n`+
    `\nStorage\n`+
    (usage? ` IDB Usage: ${(usage.bytes/1048576).toFixed(1)} / ${(usage.budget/1048576).toFixed(0)} MB (${usage.count} objects)${usage.over? '  OVER BUDGET (evicting on new writes)':''}` : ' IDB Usage: pending...'); }

  // Explicit hi-res upgrade pass: ensure visible cards promote quickly (not limited by LOAD_PER_FRAME small image loader)
  let hiResCursor = 0;
  function upgradeVisibleHiRes(){
    const scale = world.scale.x; const visibles = sprites.filter(s=> s.visible && s.__imgLoaded);
    if (!visibles.length) return;
    // Scale throughput with zoom level (more aggressive when fully zoomed) and cap by visible count
    let perFrame = 40;
    if (scale > 5) perFrame = 120;
    if (scale > 8) perFrame = 200;
    if (scale > 10) perFrame = 400;
    perFrame = Math.min(perFrame, visibles.length);
    let processed=0;
    for (let i=0; i<visibles.length && processed<perFrame; i++){
      hiResCursor = (hiResCursor + 1) % visibles.length; const s = visibles[hiResCursor];
      if (s.__qualityLevel !== 2) { updateCardTextureForScale(s, scale); processed++; }
    }
  }

  // Hotkey: press 'U' to force immediate hi-res request for all visible cards
  window.addEventListener('keydown', e=> {
    if (e.key==='u' || e.key==='U') {
      const scale = world.scale.x;
      sprites.forEach(s=> { if (s.visible && s.__imgLoaded) updateCardTextureForScale(s, scale); });
    }
  });

  installModeToggle();

  // Table mode stub container
  const tableEl = document.createElement('div');
  tableEl.id='table-mode';
  tableEl.style.cssText='position:fixed;inset:0;display:none;background:#0d1419;color:#d5d5d5;font:12px/1.4 "Inter",system-ui,monospace;padding:10px;z-index:60;overflow:auto;';
  tableEl.innerHTML = '<h2 style="margin:4px 0 12px;font-size:14px;">Table Mode (Phase 1 Stub)</h2><p>Press Tab to return to canvas.</p>';
  document.body.appendChild(tableEl);
  UIState.on(()=> { const canvasMode = UIState.state.mode==='canvas'; app.canvas.style.display = canvasMode? 'block':'none'; tableEl.style.display = canvasMode? 'none':'block'; });

  // Camera animation update loop (no animations scheduled yet; placeholder for future animateTo usage)
  let last = performance.now();
  // Basic culling (placeholder): hide sprites far outside viewport (>2x viewport bounds)
  function runCulling(){
    const vw = window.innerWidth; const vh = window.innerHeight;
    const margin = 200; // allow some slack
    const invScale = 1 / world.scale.x;
    const left = (-world.position.x) * invScale - margin;
    const top = (-world.position.y) * invScale - margin;
    const right = left + vw * invScale + margin*2;
    const bottom = top + vh * invScale + margin*2;
    for (const s of sprites){
      const vis = s.x+100 >= left && s.x <= right && s.y+140 >= top && s.y <= bottom;
      s.renderable = vis; s.visible = vis; // toggle both for safety
    }
  }

  // Lazy image loader: load some visible card images each frame
  let imgCursor = 0; const LOAD_PER_FRAME = 70; // higher prefetch budget
  function loadVisibleImages(){
    const len = sprites.length; if (!len) return; let loaded=0; let attempts=0;
    const scale = world.scale.x;
    // Compute an expanded culling rect to prefetch just-outside cards
    const vw = window.innerWidth; const vh = window.innerHeight;
    const inv = 1/scale; const pad = 300; // prefetch margin
    const left = (-world.position.x)*inv - pad;
    const top = (-world.position.y)*inv - pad;
    const right = left + vw*inv + pad*2;
    const bottom = top + vh*inv + pad*2;
    while (loaded < LOAD_PER_FRAME && attempts < len) {
      imgCursor = (imgCursor + 1) % len; attempts++;
      const s = sprites[imgCursor];
      if (!s.__card) continue;
      // Prefetch if in expanded bounds
      const inPrefetch = (s.x+100 >= left && s.x <= right && s.y+140 >= top && s.y <= bottom);
      if (!inPrefetch) continue;
      if (!s.__imgLoaded) { ensureCardImage(s); loaded++; }
      else { updateCardTextureForScale(s, scale); }
    }
  }

  app.ticker.add(()=> { const now = performance.now(); const dt = now - last; last = now; camera.update(dt); runCulling(); loadVisibleImages(); upgradeVisibleHiRes(); groups.forEach(gv=> updateGroupTextQuality(gv, world.scale.x)); updatePerf(dt); });

  // Fallback global hotkey listener (capture) to ensure Help toggles even if earlier handler failed.
  window.addEventListener('keydown', (e)=> {
    if (e.key==='h' || e.key==='H' || e.key==='?') {
      if ((e as any).__helpHandled) return; // primary handler already ran
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName==='INPUT' || target.tagName==='TEXTAREA' || target.isContentEditable)) return;
      if ((window as any).__helpAPI) { console.log('[help] fallback listener toggle'); (window as any).__helpAPI.toggle(); }
    }
  }, {capture:true});
})();
