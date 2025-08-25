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
  interface GroupVisual { id:number; gfx: PIXI.Graphics; items: Set<number>; w:number; h:number; handle: PIXI.Graphics; header: PIXI.Graphics; label: PIXI.Text; name: string; }
  const groupLayer = new PIXI.Container();
  const cardLayer = new PIXI.Container();
  world.addChild(groupLayer);
  world.addChild(cardLayer);
  sprites.forEach(s=> cardLayer.addChild(s));
  world.sortableChildren = true;
  groupLayer.zIndex = 0; cardLayer.zIndex = 10;
  const groups = new Map<number, GroupVisual>();

  // Forward declarations for help overlay (defined later)
  let helpEl: HTMLDivElement | null = null; let helpVisible=false;
  const HELP_SECTIONS = [
    { title:'Navigation', items:[
      ['Pan','Space + Drag / Middle Mouse Drag'],
      ['Zoom','Wheel (cursor focus)'],
      ['Zoom In / Out','Ctrl + (+ / -)'],
      ['Fit All','F'],
      ['Fit Selection','Shift+F or Z'],
      ['Reset Zoom','Ctrl+0']
    ]},
    { title:'Selection', items:[
      ['Single','Click'],
      ['Add / Toggle','Shift+Click'],
      ['Marquee','Drag empty space (Shift = additive)'],
      ['Select All / Clear','Ctrl+A / Esc']
    ]},
    { title:'Cards', items:[
      ['Move','Drag'],
      ['Nudge','Arrow Keys (Shift = 5×)']
    ]},
    { title:'Groups', items:[
      ['Create','G (around selection) or empty at center'],
      ['Move','Drag header'],
      ['Resize','Drag bottom-right handle'],
      ['Rename','Double-click header or F2'],
      ['Delete','Del (cards or groups)'],
      ['Layout','Grid auto-layout']
    ]},
    { title:'Help & Misc', items:[
      ['Toggle Help','H or ?'],
      ['Help FAB','Hover / click “?” bottom-right'],
      ['Recover View','Press F if you get lost']
    ]}
  ];
  function buildHelpHTML(){
    return `<div class="help-root">${HELP_SECTIONS.map(sec=> `
      <section><h2>${sec.title}</h2><ul>${sec.items.map(i=> `<li><b>${i[0]}:</b> <span>${i[1]}</span></li>`).join('')}</ul></section>`).join('')}
      <section class="tips"><h2>Tips</h2><ul><li>Alt disables snapping temporarily.</li><li>Shift while marquee adds to selection.</li><li>Use Fit Selection (Z) to zoom to current work.</li></ul></section>
    </div>`;
  }
  function ensureHelpStyles(){ if (document.getElementById('help-style')) return; const style=document.createElement('style'); style.id='help-style'; style.textContent=`.help-root{font:12px/1.5 "Inter",system-ui,monospace;padding:2px 0;} .help-root h2{margin:12px 0 4px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#6fb9ff;} .help-root section:first-of-type h2{margin-top:0;} .help-root ul{list-style:none;margin:0;padding:0;} .help-root li{margin:0 0 4px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.06);} .help-root li:last-child{border-bottom:none;} .help-root b{color:#fff;font-weight:600;} .help-root span{color:#ddd;} .help-root section{margin-bottom:6px;} .help-root .tips ul li{border-bottom:none;} #help-fab-panel .help-root{padding:0;} #help-fab-panel{scrollbar-width:thin;} #help-fab-panel::-webkit-scrollbar{width:8px;} #help-fab-panel::-webkit-scrollbar-track{background:#141b22;} #help-fab-panel::-webkit-scrollbar-thumb{background:#2f4f62;border-radius:4px;} `; document.head.appendChild(style); }
  function toggleHelp() { if (!helpEl) createHelp(); helpVisible=!helpVisible; if (helpEl) helpEl.style.display = helpVisible? 'block':'none'; }
  function createHelp() { ensureHelpStyles(); helpEl = document.createElement('div'); helpEl.style.cssText='position:fixed;top:10px;right:10px;width:460px;max-height:70vh;background:#111c;padding:16px 18px;font:12px/1.5 "Inter",system-ui,monospace;color:#eee;border:1px solid #235;border-radius:10px;z-index:9998;overflow:auto;box-shadow:0 4px 14px rgba(0,0,0,0.55);'; helpEl.innerHTML = buildHelpHTML(); document.body.appendChild(helpEl); }

  // Floating help fab (bottom-right hover to expand)
  function initHelpFab() {
    const fab = document.createElement('div');
    fab.id='help-fab';
    fab.style.cssText='position:fixed;bottom:14px;right:14px;width:44px;height:44px;border-radius:50%;background:#264b66;color:#fff;font:24px/44px sans-serif;text-align:center;cursor:help;user-select:none;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,0.4);';
    fab.textContent='?';
    fab.title='Help';
    const panel = document.createElement('div');
    panel.id='help-fab-panel';
  panel.style.cssText='position:absolute;bottom:52px;right:0;width:460px;max-height:60vh;display:none;background:#111c;padding:16px 18px;font:12px/1.5 "Inter",system-ui,monospace;color:#eee;border:1px solid #235;border-radius:10px;overflow:auto;box-shadow:0 4px 14px rgba(0,0,0,0.55);';
    ensureHelpStyles(); panel.innerHTML = buildHelpHTML();
    fab.appendChild(panel);
    let hover=false; let hideTimer:any=null;
    function show(){ panel.style.display='block'; }
    function scheduleHide(){ if (hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(()=> { if(!hover) panel.style.display='none'; }, 250); }
    fab.addEventListener('mouseenter', ()=> { hover=true; show(); });
    fab.addEventListener('mouseleave', ()=> { hover=false; scheduleHide(); });
    panel.addEventListener('mouseenter', ()=> { hover=true; show(); });
    panel.addEventListener('mouseleave', ()=> { hover=false; scheduleHide(); });
    // Click toggles pin
    let pinned=false;
    fab.addEventListener('click', (e)=> { e.stopPropagation(); pinned=!pinned; if (pinned) { show(); panel.style.display='block'; } else { hover=false; scheduleHide(); } });
    document.body.appendChild(fab);
  }
  initHelpFab();

  const HEADER_H = 28;
  function createGroupVisual(id:number, x:number, y:number, w=300, h=300) {
  const gfx = new PIXI.Graphics();
  gfx.x = x; gfx.y = y; gfx.zIndex = 1; gfx.eventMode='static'; // body interactive to allow marquee start
    const header = new PIXI.Graphics(); header.eventMode='static'; header.cursor='move';
    const handle = new PIXI.Graphics(); handle.eventMode='static'; handle.cursor='nwse-resize';
  const label = new PIXI.Text({ text: `Group ${id}`, style: { fill: 0xffffff, fontSize: 14 } });
  label.eventMode = 'none'; // let header receive the events
    const gv: GroupVisual = { id, gfx, items: new Set(), w, h, handle, header, label, name: `Group ${id}` };
    drawGroup(gv, false);
    groupLayer.addChild(gfx);
    gfx.addChild(handle);
    gfx.addChild(header);
    gfx.addChild(label);
    groups.set(id, gv);
    attachGroupInteractions(gv);
    attachResizeHandle(gv);
    return gv;
  }

  function drawGroup(gv: GroupVisual, selected:boolean) {
    const {gfx,w,h,handle,header,label} = gv;
    gfx.clear();
    gfx.roundRect(0,0,w,h,12).stroke({color: selected?0x33bbff:0x555555,width:selected?4:2}).fill({color:0x222222, alpha:0.25});
    handle.clear();
    handle.rect(0,0,14,14).fill({color:0xffffff}).stroke({color:selected?0x33bbff:0x555555,width:1});
    handle.x = w-14; handle.y = h-14;
    // header band
    header.clear();
  header.clear();
  header.rect(0,0,w,HEADER_H).fill({color: selected?0x226688:0x333333}).stroke({color: selected?0x33bbff:0x555555,width:1});
    header.x = 0; header.y = 0;
  // ensure hitArea covers full header (esp. after resize)
  header.hitArea = new PIXI.Rectangle(0,0,w,HEADER_H);
    label.text = gv.name;
    label.x = 8; label.y = 6; // within header
  }

  // Inline group renaming
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
    const headerHeight = HEADER_H * scale;
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
    const h = gv.handle; let resizing=false; let startW=0; let startH=0; let anchorX=0; let anchorY=0;
    h.on('pointerdown', e=> { e.stopPropagation(); const local = world.toLocal(e.global); resizing = true; startW = gv.w; startH = gv.h; anchorX = local.x; anchorY = local.y; });
  app.stage.on('pointermove', e=> { if (!resizing) return; const local = world.toLocal(e.global); const dw = local.x - anchorX; const dh = local.y - anchorY; gv.w = Math.max(120, snap(startW + dw)); gv.h = Math.max(160, snap(startH + dh)); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); layoutGroup(gv); });
    function endResize() { if (resizing) resizing=false; }
    app.stage.on('pointerup', endResize); app.stage.on('pointerupoutside', endResize);
  }

  function attachGroupInteractions(gv: GroupVisual) {
    let drag=false; let dx=0; let dy=0; const g=gv.gfx; let memberOffsets: {sprite:CardSprite, ox:number, oy:number}[] = [];
  gv.header.eventMode = 'static';
  gv.header.cursor = 'move';
    gv.header.on('pointerdown', e=> {
      e.stopPropagation(); // prevent body/stage marquee
      if (!e.shiftKey && !SelectionStore.state.groupIds.has(gv.id)) SelectionStore.selectOnlyGroup(gv.id); else if (e.shiftKey) SelectionStore.toggleGroup(gv.id);
      const local = world.toLocal(e.global);
      drag = true; dx = local.x - g.x; dy = local.y - g.y;
      memberOffsets = [...gv.items].map(id=> { const s = sprites.find(sp=> sp.__id===id); return s? {sprite:s, ox: s.x - g.x, oy: s.y - g.y}: null; }).filter(Boolean) as any;
    });
    gv.header.on('pointertap', (e:any)=> { if (e.detail===2) { // double click
      startGroupRename(gv);
    }});
    // Body pointerdown (only if not clicking a card) should start marquee selection.
    g.on('pointerdown', e=> {
      // If clicking header, header handler already ran (with stopPropagation). If clicking a card, card handler will run first and we can ignore here because selection store changes.
      // Start marquee only if click is on empty body area (no card hit). We approximate by checking e.target === g.
      if (e.target !== g) return;
      if (drag) return; // header already initiating drag
      startMarquee(e.global, e.shiftKey);
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
  // (Alt previously disabled snapping; feature removed)
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
        SelectionStore.getCards().forEach(id=> { const s = sprites.find(sp=> sp.__id===id); if (!s) return; s.x += dx; s.y += dy; assignCardToGroupByPosition(s); });
      }
    }
    // Zoom shortcuts (+ / - / 0 reset, F fit all, Shift+F fit selection, Z fit selection)
    if ((e.key==='+' || e.key==='=' ) && (e.ctrlKey||e.metaKey)) { e.preventDefault(); keyboardZoom(1.1); }
    if (e.key==='-' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); keyboardZoom(0.9); }
    if (e.key==='0' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); resetZoom(); }
    if (e.key==='f' || e.key==='F') { if (e.shiftKey) fitSelection(); else fitAll(); }
    if (e.key==='z' || e.key==='Z') { fitSelection(); }
    // Help overlay toggle (H or ?)
    if (e.key==='h' || e.key==='H' || e.key==='?') { toggleHelp(); }
  // (Alt snap override removed)
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
  const ty = gv.gfx.y + HEADER_H + PAD + row*(CARD_H+GAP_Y);
      // snap explicitly (should already be aligned, but defensive if group x isn't snapped yet)
      s.x = snap(tx);
      s.y = snap(ty);
    });
  const rows = Math.ceil(items.length/cols); const neededH = HEADER_H + PAD*2 + rows*CARD_H + (rows-1)*GAP_Y; if (neededH>gv.h) { gv.h = neededH; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); }
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

  // Zoom helpers (declared early so keyboard shortcuts can reference)
  function applyZoom(scaleFactor:number, centerGlobal: PIXI.Point) {
    const prevScale = world.scale.x;
    let newScale = prevScale * scaleFactor; newScale = Math.min(5, Math.max(0.1, newScale));
    scaleFactor = newScale / prevScale;
    const before = world.toLocal(centerGlobal);
    world.scale.set(newScale);
    const after = world.toLocal(centerGlobal);
    world.position.x += (after.x - before.x) * world.scale.x;
    world.position.y += (after.y - before.y) * world.scale.y;
  }
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
  function fitBounds(b:{x:number,y:number,w:number,h:number}|null) { if (!b) return; const margin = 40; const vw = window.innerWidth - margin*2; const vh = window.innerHeight - margin*2; const sx = vw / b.w; const sy = vh / b.h; const s = Math.min(5, Math.max(0.05, Math.min(sx, sy))); world.scale.set(s); world.position.x = (window.innerWidth/2) - (b.x + b.w/2)*s; world.position.y = (window.innerHeight/2) - (b.y + b.h/2)*s; }
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

  // Space-drag to pan
  let panning = false; let lastX=0; let lastY=0;
  window.addEventListener('keydown', e => { if (e.code==='Space') { panning = true; document.body.style.cursor='grab'; }});
  window.addEventListener('keyup', e => { if (e.code==='Space') { panning = false; document.body.style.cursor='default'; }});
  app.stage.eventMode='static';
  app.stage.on('pointerdown', e => { if (panning) { lastX = e.global.x; lastY = e.global.y; }});
  app.stage.on('pointermove', e => { if (panning && e.buttons===1) { const dx = e.global.x - lastX; const dy = e.global.y - lastY; world.position.x += dx; world.position.y += dy; lastX = e.global.x; lastY = e.global.y; }});
  // Middle mouse drag pan support (one-time listeners)
  app.canvas.addEventListener('pointerdown', ev => { if ((ev as PointerEvent).button===1) { panning = true; lastX = ev.clientX; lastY = ev.clientY; document.body.style.cursor='grabbing'; } });
  app.canvas.addEventListener('pointerup', ev => { if ((ev as PointerEvent).button===1) { panning = false; document.body.style.cursor='default'; } });
  app.canvas.addEventListener('contextmenu', ev => { ev.preventDefault(); });

  // Deselect when clicking empty space
  app.stage.on('pointerdown', e => { if (e.target === app.stage && !panning) SelectionStore.clear(); });

  // Debug: log card count after seeding
  console.log('[mtgcanvas] Seeded cards:', sprites.length);
})();
