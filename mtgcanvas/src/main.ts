import * as PIXI from 'pixi.js';
import { SelectionStore } from './state/selectionStore';
import { Camera } from './scene/camera';
import { createCardSprite, updateCardSpriteAppearance, attachCardInteractions, type CardSprite, ensureCardImage, updateCardTextureForScale, preloadCardQuality, getHiResQueueLength, getInflightTextureCount } from './scene/cardNode';
import { getImageCacheStats, hasCachedURL, getCacheUsage } from './services/imageCache';
import { createGroupVisual, drawGroup, layoutGroup, type GroupVisual, HEADER_HEIGHT, /* setGroupCollapsed removed */ autoPackGroup, insertionIndexForPoint, addCardToGroupOrdered, removeCardFromGroup, updateGroupTextQuality, updateGroupMetrics, updateGroupZoomPresentation } from './scene/groupNode';
import { SpatialIndex } from './scene/SpatialIndex';
import { MarqueeSystem } from './interaction/marquee';
import { initHelp } from './ui/helpPanel';
import { installModeToggle } from './ui/modeToggle';
import { UIState } from './state/uiState';
import { loadAll, queuePosition, persistGroupTransform, /* persistGroupCollapsed removed */ persistGroupRename } from './services/persistenceService';
import { InstancesRepo, GroupsRepo, hasRealDb } from './data/repositories';
import { fetchCardUniverse, spawnLargeSet } from './services/largeDataset';
import { DATASET_PREFERRED, DATASET_FALLBACK } from './config/dataset';
import { ensureThemeToggleButton, ensureThemeStyles, registerThemeListener } from './ui/theme';
import { installSearchPalette } from './ui/searchPalette';

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
  function applyCanvasBg(){
    try {
      const css = getComputedStyle(document.documentElement);
      const bg = css.getPropertyValue('--canvas-bg').trim();
      if (bg){ const hex = (PIXI as any).utils?.string2hex ? (PIXI as any).utils.string2hex(bg) : Number('0x'+bg.replace('#','')); app.renderer.background.color = hex; }
    } catch {}
  }
  registerThemeListener(()=> applyCanvasBg());
  // Will run once theme styles ensured below; calling here just in case dark default already present.
  applyCanvasBg();
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
  function createSpriteForInstance(inst:{id:number,x:number,y:number,z:number, group_id?:number|null, card?:any}) {
    const s = createCardSprite({ id: inst.id, x: inst.x, y: inst.y, z: inst.z ?? zCounter++, renderer: app.renderer, card: inst.card });
    if (inst.group_id) (s as any).__groupId = inst.group_id;
  // Flag for context / pan logic
  (s as any).__cardSprite = true;
    world.addChild(s); sprites.push(s);
    spatial.insert({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 });
  attachCardInteractions(s, ()=>sprites, world, app.stage, moved=> moved.forEach(ms=> {
      spatial.update({ id: ms.__id, minX:ms.x, minY:ms.y, maxX:ms.x+100, maxY:ms.y+140 });
      assignCardToGroupByPosition(ms);
  queuePosition(ms);
  if (PERSIST_MODE==='memory') scheduleLocalSave();
  }), ()=>panning, (global, additive)=> marquee.start(global, additive));
  // Ensure context menu listener
  try { (ensureCardContextListeners as any)(); } catch {}
    return s;
  }
  const loaded = loadAll();
  const PERSIST_MODE = hasRealDb()? 'sqlite' : 'memory';
  const LS_KEY = 'mtgcanvas_positions_v1';
  const LS_GROUPS_KEY = 'mtgcanvas_groups_v1';
  let memoryGroupsData:any=null; let groupsRestored=false;
  if (PERSIST_MODE==='memory') { try { const raw = localStorage.getItem(LS_GROUPS_KEY); if (raw) memoryGroupsData = JSON.parse(raw); } catch {} }
  // Pre-parse stored layout (memory mode) so we can spawn at correct positions without flicker
  let storedLayoutByIndex: {x:number,y:number}[] | null = null;
  if (PERSIST_MODE==='memory') {
    try { const raw = localStorage.getItem(LS_KEY); if (raw){ const obj = JSON.parse(raw); if (obj && Array.isArray(obj.byIndex)) storedLayoutByIndex = obj.byIndex; } } catch {}
  }
  function applyStoredPositionsMemory(){
    if (PERSIST_MODE!=='memory') return; try {
      const raw = localStorage.getItem(LS_KEY); if (!raw) return; const obj = JSON.parse(raw);
      if (!obj) return;
      // Primary: id-based
      if (Array.isArray(obj.instances)) {
        const map = new Map<number,{x:number,y:number}>(); obj.instances.forEach((r:any)=> { if (typeof r.id==='number') map.set(r.id,{x:r.x,y:r.y}); });
        let matched = 0;
  sprites.forEach(s=> { const p = map.get(s.__id); if (p){ s.x = p.x; s.y = p.y; matched++; } });
        // Fallback: index-based if few matched (likely ephemeral ids changed)
        if (matched < sprites.length * 0.5 && Array.isArray(obj.byIndex)) {
          obj.byIndex.forEach((p:any, idx:number)=> { const s = sprites[idx]; if (s && p && typeof p.x==='number' && typeof p.y==='number'){ s.x = p.x; s.y = p.y; } });
        }
        // Refresh spatial index bounds after applying new positions
        sprites.forEach(s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 }));
      }
    } catch {}
  }
  if (PERSIST_MODE==='memory') {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && Array.isArray(obj.instances)) {
          obj.instances.forEach((r:any)=> { const inst = loaded.instances.find(i=> i.id===r.id); if (inst){ inst.x = r.x; inst.y = r.y; } });
        }
      }
    } catch {}
  }
  if (!loaded.instances.length) {
    (async ()=> {
      const universe = await fetchCardUniverse();
      if (universe.length) {
  const TARGET = universe.length; // load entire provided dataset
  console.log(`[startup] spawning FULL dataset (${DATASET_PREFERRED} | fallback ${DATASET_FALLBACK}) count=`, TARGET);
  await spawnLargeSet(universe, inst=> {
    if (storedLayoutByIndex && storedLayoutByIndex[inst.z]) { const p = storedLayoutByIndex[inst.z]; inst.x = p.x; inst.y = p.y; }
    createSpriteForInstance(inst);
  }, { count: TARGET, batchSize: 800, onProgress:(done,total)=> { if (done===total) { console.log('[startup] full spawn complete'); if (!storedLayoutByIndex) applyStoredPositionsMemory(); if (PERSIST_MODE==='memory') restoreMemoryGroups(); fitAll(); } } });
      } else {
  console.warn(`[startup] dataset (${DATASET_PREFERRED}/${DATASET_FALLBACK}) not found or empty; falling back to 200 dummy cards`);
  for (let i=0;i<200;i++) { const x=(i%20)*SPACING_X, y=Math.floor(i/20)*SPACING_Y; const id = InstancesRepo.create(1, x, y); const pos = storedLayoutByIndex && storedLayoutByIndex[i]; createSpriteForInstance({ id, x: pos?pos.x:x, y: pos?pos.y:y, z:zCounter++ }); }
  if (!storedLayoutByIndex) applyStoredPositionsMemory(); if (PERSIST_MODE==='memory') restoreMemoryGroups();
  fitAll();
      }
    })();
  } else { loaded.instances.forEach((inst:any)=> createSpriteForInstance(inst)); applyStoredPositionsMemory(); }

  // Groups container + visuals
  const groups = new Map<number, GroupVisual>();
  // Unified group deletion: reset member cards and remove the group
  function deleteGroupById(id: number){
    const gv = groups.get(id); if (!gv) return;
    const ids = [...gv.items];
    const updates: { id:number; group_id: null }[] = [];
    ids.forEach(cid=> {
      const sp = sprites.find(s=> s.__id===cid);
      if (sp){
        (sp as any).__groupId = undefined;
        (sp as any).__groupOverlayActive = false;
        (sp as any).eventMode = 'static';
        sp.cursor = 'pointer';
        sp.alpha = 1; sp.visible = true; sp.renderable = true;
        updateCardSpriteAppearance(sp, SelectionStore.state.cardIds.has(sp.__id));
      }
      updates.push({ id: cid, group_id: null });
    });
    try { if (updates.length) InstancesRepo.updateMany(updates as any); } catch {}
    try { gv.gfx.destroy(); } catch {}
    groups.delete(id);
  }
  // Memory mode group persistence helpers
  let lsGroupsTimer:any=null; function scheduleGroupSave(){ if (PERSIST_MODE!=='memory') return; if (lsGroupsTimer) return; lsGroupsTimer = setTimeout(persistLocalGroups, 400); }
  function persistLocalGroups(){ lsGroupsTimer=null; try { const data = { groups: [...groups.values()].map(gv=> ({ id: gv.id, x: gv.gfx.x, y: gv.gfx.y, w: gv.w, h: gv.h, name: gv.name, collapsed: gv.collapsed, color: gv.color, membersById: gv.order.slice(), membersByIndex: gv.order.map(cid=> sprites.findIndex(s=> s.__id===cid)).filter(i=> i>=0) })) }; localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(data)); } catch {} }
  function restoreMemoryGroups(){ if (groupsRestored) return; groupsRestored=true; if (PERSIST_MODE!=='memory') return; if (!memoryGroupsData || !Array.isArray(memoryGroupsData.groups)) return; memoryGroupsData.groups.forEach((gr:any)=> { const gv = createGroupVisual(gr.id, gr.x??0, gr.y??0, gr.w??300, gr.h??300); if (gr.name) gv.name=gr.name; if (gr.collapsed) gv.collapsed=!!gr.collapsed; if (gr.color) gv.color=gr.color; groups.set(gv.id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv); }); memoryGroupsData.groups.forEach((gr:any)=> { const gv=groups.get(gr.id); if (!gv) return; let matched=0; if (Array.isArray(gr.membersById)) gr.membersById.forEach((cid:number)=> { const s = sprites.find(sp=> sp.__id===cid); if (s) { addCardToGroupOrdered(gv, s.__id, gv.order.length); (s as any).__groupId = gv.id; matched++; } }); if (matched<1 && Array.isArray(gr.membersByIndex)) gr.membersByIndex.forEach((idx:number)=> { const s = sprites[idx]; if (s) { addCardToGroupOrdered(gv, s.__id, gv.order.length); (s as any).__groupId = gv.id; } }); }); groups.forEach(gv=> { layoutGroup(gv, sprites, sc=> spatial.update({ id:sc.__id, minX:sc.x, minY:sc.y, maxX:sc.x+100, maxY:sc.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, false); }); scheduleGroupSave(); }
  // Rehydrate persisted groups
  if (loaded.groups && (loaded as any).groups.length) {
    (loaded as any).groups.forEach((gr:any)=> {
      const t = gr.transform;
      if (!t) return; const gv = createGroupVisual(gr.id, t.x ?? 0, t.y ?? 0, t.w ?? 300, t.h ?? 300);
      gv.name = gr.name || gv.name;
      if (gr.collapsed) gv.collapsed = !!gr.collapsed;
      groups.set(gr.id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv); drawGroup(gv, false);
    });
    // After groups exist, attach any sprites with stored group_id
    sprites.forEach(s=> { const gid = (s as any).__groupId; if (gid && groups.has(gid)) { const gv = groups.get(gid)!; gv.items.add(s.__id); gv.order.push(s.__id); } });
    // Layout groups with their members
    groups.forEach(gv=> { layoutGroup(gv, sprites, sc=> spatial.update({ id:sc.__id, minX:sc.x, minY:sc.y, maxX:sc.x+100, maxY:sc.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, false); });
  } else if (PERSIST_MODE==='memory') {
    if (loaded.instances.length) restoreMemoryGroups();
  }
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
  if (save) { const val = input.value.trim(); if (val) { gv.name = val; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); persistGroupRename(gv.id, val); scheduleGroupSave(); } }
      input.remove();
    }
    input.addEventListener('keydown', ev=> {
      if (ev.key==='Enter') { commit(true); }
      else if (ev.key==='Escape') { commit(false); }
    });
    input.addEventListener('blur', ()=> commit(true));
  }

  // ---- Inline rename affordance (non-modal design) ----
  const renameButtons = new Map<number, HTMLButtonElement>();
  function ensureRenameButton(gv: GroupVisual){
    let btn = renameButtons.get(gv.id);
    if (!btn){
      btn = document.createElement('button');
      btn.type='button';
      btn.textContent='✎';
      btn.title='Rename group (R)';
  btn.style.cssText='position:fixed;z-index:10000;padding:0 4px;min-width:20px;height:18px;font:11px var(--panel-font);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0.85;';
  btn.className='ui-btn'; btn.style.fontSize='11px'; btn.style.lineHeight='16px';
      btn.onmouseenter=()=> btn!.style.opacity='1';
      btn.onmouseleave=()=> btn!.style.opacity='0.85';
      btn.onclick=(e)=> { e.stopPropagation(); startGroupRename(gv); };
      document.body.appendChild(btn);
      renameButtons.set(gv.id, btn);
    }
    return btn;
  }
  function removeRenameButton(id:number){ const btn = renameButtons.get(id); if (btn){ btn.remove(); renameButtons.delete(id); } }
  function updateRenameButtonsVisibility(){
    const selected = new Set(SelectionStore.getGroups());
    // Remove buttons for unselected
    [...renameButtons.keys()].forEach(id=> { if (!selected.has(id)) removeRenameButton(id); });
    selected.forEach(id=> { const gv = groups.get(id); if (gv) ensureRenameButton(gv); });
  }
  function repositionRenameButtons(){ if (!renameButtons.size) return; const bounds = app.renderer.canvas.getBoundingClientRect(); renameButtons.forEach((btn, id)=> { const gv = groups.get(id); if (!gv) { btn.remove(); renameButtons.delete(id); return; } const px = gv.gfx.x + gv.w - 24; const py = gv.gfx.y + 4; const global = world.toGlobal(new PIXI.Point(px, py)); btn.style.left = `${bounds.left + global.x}px`; btn.style.top = `${bounds.top + global.y}px`; }); }

  // ---- Side Group Info Panel (replaces floating rename buttons) ----
  let groupInfoPanel: HTMLDivElement | null = null;
  let groupInfoNameInput: HTMLInputElement | null = null;
  function ensureGroupInfoPanel(){
    if (groupInfoPanel) return groupInfoPanel;
    const el = document.createElement('div');
    el.id = 'group-info-panel';
  // Bottom anchored slim bar replacing side panel
  el.style.cssText='position:fixed;left:0;right:0;bottom:0;height:120px;z-index:10020;display:flex;flex-direction:row;align-items:flex-start;padding:10px 14px;gap:16px;';
  el.className='ui-panel';
  el.innerHTML = '<div style="font-size:22px;font-weight:600;letter-spacing:.55px;text-transform:uppercase;color:var(--panel-accent);">Group</div>';
  el.style.fontSize='16px';
    // Name editor
    const nameWrap = document.createElement('div'); nameWrap.style.display='flex'; nameWrap.style.flexDirection='column'; nameWrap.style.gap='4px';
    const nameLabel = document.createElement('label'); nameLabel.textContent='Name'; nameLabel.style.fontSize='11px'; nameLabel.style.opacity='0.75'; nameWrap.appendChild(nameLabel);
  const nameInput = document.createElement('input'); groupInfoNameInput = nameInput; nameInput.type='text'; nameInput.maxLength=64; nameInput.className='ui-input'; nameInput.style.fontSize='16px'; nameInput.style.padding='8px 10px'; nameWrap.appendChild(nameInput);
    el.appendChild(nameWrap);
    // Metrics
  const metrics = document.createElement('div'); metrics.id='group-info-metrics'; metrics.style.cssText='display:grid;grid-template-columns:auto 1fr;column-gap:12px;row-gap:4px;font-size:16px;min-width:140px;'; el.appendChild(metrics);
    // Actions
  const actions = document.createElement('div'); actions.style.cssText='display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;';
  function makeBtn(label:string, handler:()=>void){ const b=document.createElement('button'); b.textContent=label; b.type='button'; b.className='ui-btn'; b.style.fontSize='15px'; b.style.padding='8px 12px'; b.onclick=handler; return b; }
  const autoBtn = makeBtn('Auto-pack', ()=> { const gv = currentPanelGroup(); if (!gv) return; autoPackGroup(gv, sprites, s=> spatial.update({ id:s.__id,minX:s.x,minY:s.y,maxX:s.x+100,maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave(); updateGroupInfoPanel(); });
    const recolorBtn = makeBtn('Recolor', ()=> { const gv = currentPanelGroup(); if (!gv) return; gv.color = (Math.random()*0xffffff)|0; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave(); updateGroupInfoPanel(); });
  const deleteBtn = makeBtn('Delete', ()=> { const gv = currentPanelGroup(); if (!gv) return; deleteGroupById(gv.id); SelectionStore.clear(); scheduleGroupSave(); updateGroupInfoPanel(); }); deleteBtn.classList.add('danger');
  actions.append(autoBtn, recolorBtn, deleteBtn); el.appendChild(actions);
    // Color palette strip
    const paletteStrip = document.createElement('div'); paletteStrip.style.cssText='display:flex;flex-wrap:wrap;gap:4px;';
  for (let i=0;i<10;i++){ const sq=document.createElement('div'); const col = (i*0x222222 + 0x334455) & 0xffffff; sq.style.cssText='width:18px;height:18px;border-radius:4px;cursor:pointer;border:1px solid var(--panel-border);'; sq.style.background = '#'+col.toString(16).padStart(6,'0'); sq.onclick=()=> { const gv = currentPanelGroup(); if (!gv) return; gv.color = col; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave(); updateGroupInfoPanel(); }; paletteStrip.appendChild(sq); }
    el.appendChild(paletteStrip);
  // Member list removed per requirements
    // Close button (optional)
  const closeBtn = document.createElement('button'); closeBtn.textContent='×'; closeBtn.title='Clear selection'; closeBtn.className='ui-btn'; closeBtn.style.cssText += 'position:absolute;top:6px;right:6px;width:40px;height:40px;font-size:22px;line-height:22px;padding:0;'; closeBtn.onclick=()=> { SelectionStore.clear(); updateGroupInfoPanel(); }; el.appendChild(closeBtn);
    // Name input commit
    nameInput.addEventListener('keydown', ev=> { if (ev.key==='Enter'){ commitName(); nameInput.blur(); } });
    nameInput.addEventListener('blur', ()=> commitName());
    function commitName(){ const gv = currentPanelGroup(); if (!gv) return; const v = nameInput.value.trim(); if (v && v!==gv.name){ gv.name = v; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); persistGroupRename(gv.id, v); scheduleGroupSave(); updateGroupInfoPanel(); } }
    document.body.appendChild(el);
    groupInfoPanel = el; return el;
  }
  function currentPanelGroup(): GroupVisual | null { const gids = SelectionStore.getGroups(); if (gids.length!==1) return null; const gv = groups.get(gids[0]) || null; return gv; }
  function updateGroupInfoPanel(){
    const panel = ensureGroupInfoPanel();
    const gv = currentPanelGroup();
  if (!gv){ panel.style.display='none'; return; }
    panel.style.display='flex';
    if (groupInfoNameInput) groupInfoNameInput.value = gv.name;
    // Update metrics grid
  const metrics = panel.querySelector('#group-info-metrics') as HTMLDivElement | null; if (metrics){ metrics.innerHTML=''; const addRow=(k:string,v:string)=> { const kEl=document.createElement('div'); kEl.textContent=k; kEl.style.opacity='0.65'; const vEl=document.createElement('div'); vEl.textContent=v; metrics.append(kEl,vEl); }; updateGroupMetrics(gv, sprites); addRow('Cards', gv.items.size.toString()); addRow('Price', `$${gv.totalPrice.toFixed(2)}`); }
  }

  // ---- Card Info Side Pane ----
  let cardInfoPanel: HTMLDivElement | null = null;
  function ensureCardInfoPanel(){
    if (cardInfoPanel) return cardInfoPanel;
    const el = document.createElement('div'); cardInfoPanel = el;
    el.id='card-info-panel';
  el.style.cssText='position:fixed;top:0;right:0;bottom:0;width:420px;max-width:45vw;z-index:10015;display:flex;flex-direction:column;pointer-events:auto;font-size:16px;';
  el.className='ui-panel';
  el.innerHTML = '<div id="cip-header" style="padding:10px 14px 6px;font-size:14px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--panel-accent);display:flex;align-items:center;gap:8px;">Card</div>'+
      '<div id="cip-scroll" style="overflow:auto;padding:0 14px 18px;display:flex;flex-direction:column;gap:14px;">'+
        '<div id="cip-empty" style="opacity:.55;padding:14px 4px;font-size:14px;">No card selected</div>'+
        '<div id="cip-content" style="display:none;flex-direction:column;gap:28px;">'+
          '<div id="cip-name" style="font-size:32px;font-weight:600;line-height:1.2;"></div>'+
          '<div id="cip-meta" style="display:flex;flex-direction:column;gap:8px;font-size:18px;line-height:1.5;opacity:.9;"></div>'+
          '<div id="cip-type" style="font-size:18px;opacity:.8;"></div>'+
          '<div id="cip-oracle" class="ui-input" style="white-space:pre-wrap;font-size:18px;line-height:1.6;padding:16px 18px;min-height:160px;"></div>'+
        '</div>'+
      '</div>';
    document.body.appendChild(el);
    return el;
  }
  function hideCardInfoPanel(){ if (cardInfoPanel) cardInfoPanel.style.display='none'; }
  function showCardInfoPanel(){ const el=ensureCardInfoPanel(); el.style.display='flex'; }
  function updateCardInfoPanel(){
    const ids = SelectionStore.getCards();
    // Only show when exactly 1 card is selected (ignore when groups selected or multi-selection)
    if (ids.length!==1){ hideCardInfoPanel(); return; }
    const sprite = sprites.find(s=> s.__id===ids[0]); if (!sprite || !sprite.__card){ hideCardInfoPanel(); return; }
    const card = sprite.__card;
    showCardInfoPanel();
    const panel = ensureCardInfoPanel();
    const empty = panel.querySelector('#cip-empty') as HTMLElement|null;
    const content = panel.querySelector('#cip-content') as HTMLElement|null;
    if (empty) empty.style.display='none'; if (content) content.style.display='flex';
    const nameEl = panel.querySelector('#cip-name') as HTMLElement|null; if (nameEl) nameEl.textContent = card.name || '(Unnamed)';
    const typeEl = panel.querySelector('#cip-type') as HTMLElement|null; if (typeEl) typeEl.textContent = card.type_line || '';
    const oracleEl = panel.querySelector('#cip-oracle') as HTMLElement|null; if (oracleEl) oracleEl.textContent = card.oracle_text || '';
    const metaEl = panel.querySelector('#cip-meta') as HTMLElement|null;
    if (metaEl){
      const parts: string[] = [];
      if (card.mana_cost) parts.push(`<span style="font-weight:600;">Cost:</span> ${escapeHtml(card.mana_cost)}`);
      if (card.cmc!==undefined) parts.push(`<span style="font-weight:600;">CMC:</span> ${card.cmc}`);
      if (card.power!==undefined && card.toughness!==undefined) parts.push(`<span style="font-weight:600;">P/T:</span> ${card.power}/${card.toughness}`);
      if (Array.isArray(card.color_identity) && card.color_identity.length) parts.push(`<span style="font-weight:600;">CI:</span> ${card.color_identity.join('')}`);
      if (card.rarity) parts.push(`<span style="font-weight:600;">Rarity:</span> ${escapeHtml(card.rarity)}`);
      if (card.set) parts.push(`<span style="font-weight:600;">Set:</span> ${escapeHtml(card.set.toUpperCase())}`);
      if (card.lang && card.lang!=='en') parts.push(`<span style="font-weight:600;">Lang:</span> ${escapeHtml(card.lang)}`);
      metaEl.innerHTML = parts.map(p=> `<div>${p}</div>`).join('');
    }
    // Image: use existing sprite texture (copy into a canvas for crispness) if loaded; else trigger ensureCardImage then copy later
  // Image removed per user request.
  }
  function escapeHtml(s:string){ return s.replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'} as any)[c] || c); }
  SelectionStore.on(()=> { updateGroupInfoPanel(); updateCardInfoPanel(); });

  function attachResizeHandle(gv: GroupVisual) {
  const r = gv.resize; let resizing=false; let startW=0; let startH=0; let anchorX=0; let anchorY=0; let startX=0; let startY=0; let resizeMode:''| 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw' = '';
  const MIN_W = 160; const MIN_H = HEADER_HEIGHT + 80; const EDGE_PX = 16; // edge handle thickness in screen pixels

  // Debug overlay to visualize interactive edge bands (screen-relative)
  if ((window as any).__debugResizeTargets === undefined) (window as any).__debugResizeTargets = false; // default OFF
  function ensureDebugG(){
    let dbg: PIXI.Graphics = (gv.gfx as any).__resizeDbg;
    if (!dbg){ dbg = new PIXI.Graphics(); (gv.gfx as any).__resizeDbg = dbg; dbg.eventMode='none'; dbg.zIndex = 999999; gv.gfx.addChild(dbg); }
    return dbg;
  }
  function updateResizeDebug(){
    const enabled = !!(window as any).__debugResizeTargets;
    const dbg = ensureDebugG(); dbg.visible = enabled; if (!enabled) { dbg.clear(); return; }
    const edgeWorld = EDGE_PX / (world.scale.x || 1);
    dbg.clear();
    // Top (blue)
    dbg.rect(0, 0, gv.w, edgeWorld).fill({ color: 0x3355ff, alpha: 0.25 });
    // Bottom (blue)
    dbg.rect(0, gv.h - edgeWorld, gv.w, edgeWorld).fill({ color: 0x3355ff, alpha: 0.25 });
    // Left (green)
    dbg.rect(0, 0, edgeWorld, gv.h).fill({ color: 0x33cc66, alpha: 0.25 });
    // Right (green)
    dbg.rect(gv.w - edgeWorld, 0, edgeWorld, gv.h).fill({ color: 0x33cc66, alpha: 0.25 });
    // Corners (red) overdraw so they stand out
    dbg.rect(0, 0, edgeWorld, edgeWorld).fill({ color: 0xff3366, alpha: 0.35 }); // NW
    dbg.rect(gv.w - edgeWorld, 0, edgeWorld, edgeWorld).fill({ color: 0xff3366, alpha: 0.35 }); // NE
    dbg.rect(0, gv.h - edgeWorld, edgeWorld, edgeWorld).fill({ color: 0xff3366, alpha: 0.35 }); // SW
    dbg.rect(gv.w - edgeWorld, gv.h - edgeWorld, edgeWorld, edgeWorld).fill({ color: 0xff3366, alpha: 0.35 }); // SE
  }

  function modeFromPoint(localX:number, localY:number, edgeWorld:number): typeof resizeMode {
    const w = gv.w, h = gv.h; const left = localX <= edgeWorld; const right = localX >= w - edgeWorld; const top = localY <= edgeWorld; const bottom = localY >= h - edgeWorld;
    if (top && left) return 'nw'; if (top && right) return 'ne'; if (bottom && left) return 'sw'; if (bottom && right) return 'se';
    if (top) return 'n'; if (bottom) return 's'; if (left) return 'w'; if (right) return 'e';
    return '';
  }
  function cursorFor(mode: typeof resizeMode) {
    switch(mode){
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'nw': case 'se': return 'nwse-resize';
      default: return 'default';
    }
  }

  // Existing bottom-right triangle -> always se resize
  r.on('pointerdown', e=> { if (gv.collapsed) return; e.stopPropagation(); const local = world.toLocal(e.global); resizing = true; resizeMode='se'; startW = gv.w; startH = gv.h; startX = gv.gfx.x; startY = gv.gfx.y; anchorX = local.x; anchorY = local.y; });

  // Edge / corner resize via frame body
  gv.frame.on('pointermove', (e:any)=> { if (resizing || gv.collapsed) return; const local = world.toLocal(e.global); const lx = local.x - gv.gfx.x; const ly = local.y - gv.gfx.y; const edgeWorld = EDGE_PX / (world.scale.x || 1); const mode = modeFromPoint(lx, ly, edgeWorld); gv.frame.cursor = cursorFor(mode); updateResizeDebug(); });
  gv.frame.on('pointerout', ()=> { if (!resizing && gv.frame.cursor!=='default') gv.frame.cursor='default'; });
  gv.frame.on('pointerdown', (e:any)=> {
    if (gv.collapsed) return; if (e.button!==0) return; // only left button
    const local = world.toLocal(e.global); const lx = local.x - gv.gfx.x; const ly = local.y - gv.gfx.y; const edgeWorld = EDGE_PX / (world.scale.x || 1); const mode = modeFromPoint(lx, ly, edgeWorld);
    if (!mode) return; // not on edge -> allow other handlers (drag / marquee)
    e.stopPropagation(); resizing=true; resizeMode = mode; startW = gv.w; startH = gv.h; startX = gv.gfx.x; startY = gv.gfx.y; anchorX = local.x; anchorY = local.y;
    updateResizeDebug();
  });

  // Header resize support for top/left/right edges (screen-relative thickness)
  gv.header.on('pointermove', (e:any)=> {
    if (resizing || gv.collapsed) return;
    const local = world.toLocal(e.global); const lx = local.x - gv.gfx.x; const ly = local.y - gv.gfx.y; const edgeWorld = EDGE_PX / (world.scale.x || 1);
    const w = gv.w; const left = lx <= edgeWorld; const right = lx >= w - edgeWorld; const top = ly <= edgeWorld;
    let mode: typeof resizeMode = '';
    if (top && left) mode = 'nw';
    else if (top && right) mode = 'ne';
    else if (left) mode = 'w';
    else if (right) mode = 'e';
    else if (top) mode = 'n';
    gv.header.cursor = cursorFor(mode) || 'move';
    updateResizeDebug();
  });
  gv.header.on('pointerout', ()=> { if (!resizing) gv.header.cursor='move'; });
  gv.header.on('pointerdown', (e:any)=> {
    if (gv.collapsed) return; if (e.button!==0) return; // left only
    const local = world.toLocal(e.global); const lx = local.x - gv.gfx.x; const ly = local.y - gv.gfx.y; const edgeWorld = EDGE_PX / (world.scale.x || 1);
    const w = gv.w; const left = lx <= edgeWorld; const right = lx >= w - edgeWorld; const top = ly <= edgeWorld;
    let mode: typeof resizeMode = '';
    if (top && left) mode = 'nw';
    else if (top && right) mode = 'ne';
    else if (left) mode = 'w';
    else if (right) mode = 'e';
    else if (top) mode = 'n';
    if (!mode) return; // not near top edge -> let normal drag logic run
    e.stopPropagation(); // prevent header drag
    resizing = true; resizeMode = mode; startW = gv.w; startH = gv.h; startX = gv.gfx.x; startY = gv.gfx.y; anchorX = local.x; anchorY = local.y;
    updateResizeDebug();
  });

  app.stage.on('pointermove', e=> {
    if (!resizing) return; const local = world.toLocal(e.global); const dx = local.x - anchorX; const dy = local.y - anchorY; const rightEdge = startX + startW; const bottomEdge = startY + startH; let newW = startW; let newH = startH; let newX = startX; let newY = startY;
    // Horizontal adjustments
    if (resizeMode.includes('e')) { newW = startW + dx; }
    if (resizeMode.includes('w')) { newW = startW - dx; /* keep right edge fixed */ }
    // Vertical adjustments
    if (resizeMode.includes('s')) { newH = startH + dy; }
    if (resizeMode.includes('n')) { newH = startH - dy; }
    // Clamp & snap
    if (resizeMode.includes('w')) { newW = Math.max(MIN_W, newW); newW = snap(newW); newX = rightEdge - newW; }
    else if (resizeMode.includes('e')) { newW = Math.max(MIN_W, newW); newW = snap(newW); }
    if (resizeMode.includes('n')) { newH = Math.max(MIN_H, newH); newH = snap(newH); newY = bottomEdge - newH; }
    else if (resizeMode.includes('s')) { newH = Math.max(MIN_H, newH); newH = snap(newH); }
    // Apply
    gv.w = newW; gv.h = newH; gv.gfx.x = newX; gv.gfx.y = newY; gv._expandedH = gv.h;
    drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 }));
    updateResizeDebug();
  });
  const endResize=()=>{ if (resizing) { resizing=false; resizeMode=''; gv.frame.cursor='default'; } };
  app.stage.on('pointerup', endResize); app.stage.on('pointerupoutside', endResize);
  // Initial draw
  updateResizeDebug();
  }

  function attachGroupInteractions(gv: GroupVisual) {
    let drag=false; let dx=0; let dy=0; const g=gv.gfx; let memberOffsets: {sprite:CardSprite, ox:number, oy:number}[] = [];
    gv.header.eventMode='static'; gv.header.cursor='move';
  gv.header.on('pointerdown', (e:any)=> { e.stopPropagation(); if (e.button===2) return; // right-click handled separately
      // If near resize edges, do not start drag (resize handler will take over)
      try {
        const local = world.toLocal(e.global); const lx = local.x - gv.gfx.x; const ly = local.y - gv.gfx.y; const edgeWorld = 16 / (world.scale.x || 1);
        const w = gv.w; const nearLeft = lx <= edgeWorld; const nearRight = lx >= w - edgeWorld; const nearTop = ly <= edgeWorld;
        if (nearLeft || nearRight || nearTop) return; // let resize path handle
      } catch {}
      if (!e.shiftKey && !SelectionStore.state.groupIds.has(gv.id)) SelectionStore.selectOnlyGroup(gv.id); else if (e.shiftKey) SelectionStore.toggleGroup(gv.id); const local = world.toLocal(e.global); drag=true; dx = local.x - g.x; dy = local.y - g.y; memberOffsets = [...gv.items].map(id=> { const s = sprites.find(sp=> sp.__id===id); return s? {sprite:s, ox:s.x - g.x, oy:s.y - g.y}: null; }).filter(Boolean) as any; });
    gv.header.on('pointertap', (e:any)=> { if (e.detail===2 && e.button!==2) startGroupRename(gv); });
    // Overlay drag surface (when zoomed out). Acts like header.
    if ((gv as any)._overlayDrag) {
      const ds:any = (gv as any)._overlayDrag;
      ds.on('pointerdown', (e:any)=> { if (e.button!==0) return; if (!ds.visible) return; e.stopPropagation(); if (!SelectionStore.state.groupIds.has(gv.id)) SelectionStore.selectOnlyGroup(gv.id); const local = world.toLocal(e.global); drag=true; dx = local.x - g.x; dy = local.y - g.y; memberOffsets = [...gv.items].map(id=> { const s = sprites.find(sp=> sp.__id===id); return s? {sprite:s, ox:s.x - g.x, oy:s.y - g.y}: null; }).filter(Boolean) as any; });
    }
    // When zoom overlay active (cards hidden / faded) allow dragging from the whole body area.
    // Reuse same drag logic; only trigger if overlay phase recently > 0 (tracked via _lastZoomPhase).
    gv.frame.cursor = 'default'; gv.frame.eventMode='static';
    gv.frame.on('pointerdown', (e:any)=> {
      if (e.button!==0) return;
      // Only consider using the frame as a drag surface if overlay is active AND there's no dedicated drag surface.
      if (!gv._lastZoomPhase || gv._lastZoomPhase < 0.05) return; // overlay not active enough
      if ((gv as any)._overlayDrag) return; // defer to overlay drag surface to avoid conflicts with resize
      // Fallback: avoid starting drag when near edges so resize can take precedence
      try {
        const local = world.toLocal(e.global); const lx = local.x - gv.gfx.x; const ly = local.y - gv.gfx.y; const edgeWorld = 16 / (world.scale.x || 1);
        const w = gv.w; const nearEdge = (lx <= edgeWorld) || (lx >= w - edgeWorld) || (ly <= edgeWorld) || (ly >= gv.h - edgeWorld);
        if (nearEdge) return; // let resize path handle
      } catch {}
      // Avoid starting drag when clicking resize triangle
      const hit = e.target; if (hit === gv.resize) return;
      e.stopPropagation();
      if (!SelectionStore.state.groupIds.has(gv.id)) SelectionStore.selectOnlyGroup(gv.id);
      const local = world.toLocal(e.global);
      drag = true; dx = local.x - g.x; dy = local.y - g.y;
      memberOffsets = [...gv.items].map(id=> { const s = sprites.find(sp=> sp.__id===id); return s? {sprite:s, ox:s.x - g.x, oy:s.y - g.y}: null; }).filter(Boolean) as any;
    });
    // Context menu (right-click)
    // Show context menu only if no significant right-drag (panning) occurred.
    gv.header.on('rightclick', (e:any)=> {
      e.stopPropagation();
      if (rightPanning) return; // if we dragged, skip menu
      showGroupContextMenu(gv, e.global);
    });
  // Group body interactions handled globally like canvas now.
  app.stage.on('pointermove', e=> { if (!drag) return; const local = world.toLocal(e.global); g.x = local.x - dx; g.y = local.y - dy; memberOffsets.forEach(m=> { m.sprite.x = g.x + m.ox; m.sprite.y = g.y + m.oy; }); });
  app.stage.on('pointerup', ()=> { if (!drag) return; drag=false; g.x = snap(g.x); g.y = snap(g.y); memberOffsets.forEach(m=> { m.sprite.x = snap(m.sprite.x); m.sprite.y = snap(m.sprite.y); spatial.update({ id:m.sprite.__id, minX:m.sprite.x, minY:m.sprite.y, maxX:m.sprite.x+100, maxY:m.sprite.y+140 }); }); persistGroupTransform(gv.id,{x:g.x,y:g.y,w:gv.w,h:gv.h}); scheduleGroupSave(); });
  }

  // ---- Group context menu (Groups V2) ----
  let groupMenu: HTMLDivElement | null = null; let menuTarget: GroupVisual | null = null;
  const PALETTE = [0x2d3e53,0x444444,0x554433,0x224433,0x333355,0x553355,0x335555,0x4a284a,0x3c4a28,0x284a4a];
  function ensureGroupMenu(){
    if (groupMenu) return groupMenu; const el = document.createElement('div'); groupMenu = el;
  el.style.cssText='position:fixed;z-index:10001;min-width:200px;'; el.className='ui-menu';
  // Prevent both mouse and pointer events from bubbling (so global pointerdown doesn't instantly hide menu)
  el.addEventListener('mousedown', ev=> ev.stopPropagation());
  el.addEventListener('pointerdown', ev=> ev.stopPropagation());
    document.body.appendChild(el); return el;
  }
  function hideGroupMenu(){ if (groupMenu){ groupMenu.style.display='none'; menuTarget=null; } }
  window.addEventListener('pointerdown', (e)=> {
    const tgt = e.target as Node | null;
    if (groupMenu && tgt && groupMenu.contains(tgt)) return; // inside menu
    hideGroupMenu();
  });
  function showGroupContextMenu(gv: GroupVisual, globalPt: PIXI.Point){
    const el = ensureGroupMenu(); menuTarget = gv; el.innerHTML='';
  function addItem(label:string, action:()=>void){ const it=document.createElement('div'); it.textContent=label; it.className='ui-menu-item'; it.onclick=()=> { action(); hideGroupMenu(); }; el.appendChild(it); }
  // Collapse feature removed
  addItem('Auto-pack', ()=> { autoPackGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave(); });
    addItem('Rename', ()=> startGroupRename(gv));
  addItem('Recolor', ()=> { gv.color = PALETTE[Math.floor(Math.random()*PALETTE.length)]; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave(); });
  addItem('Delete', ()=> { deleteGroupById(gv.id); SelectionStore.clear(); scheduleGroupSave(); });
    const sw=document.createElement('div'); sw.style.cssText='display:flex;gap:4px;padding:4px 6px 2px;flex-wrap:wrap;';
  PALETTE.forEach(c=> { const sq=document.createElement('div'); sq.style.cssText=`width:16px;height:16px;border-radius:4px;background:#${c.toString(16).padStart(6,'0')};cursor:pointer;border:1px solid #182830;`; sq.onclick=()=> { gv.color=c; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave(); hideGroupMenu(); }; sw.appendChild(sq); });
    el.appendChild(sw);
    const bounds = app.renderer.canvas.getBoundingClientRect();
    el.style.left = `${bounds.left + globalPt.x + 4}px`;
    el.style.top = `${bounds.top + globalPt.y + 4}px`;
    el.style.display='block';
  }

  // ---- Card context menu (Add to open group) ----
  let cardMenu: HTMLDivElement | null = null; let cardMenuTarget: CardSprite | null = null;
  function ensureCardMenu(){
    if (cardMenu) return cardMenu; const el = document.createElement('div'); cardMenu = el;
  el.style.cssText='position:fixed;z-index:10001;min-width:220px;'; el.className='ui-menu';
  el.addEventListener('mousedown', ev=> ev.stopPropagation());
  el.addEventListener('pointerdown', ev=> ev.stopPropagation());
    document.body.appendChild(el); return el;
  }
  function hideCardMenu(){ if (cardMenu){ cardMenu.style.display='none'; cardMenuTarget=null; } }
  window.addEventListener('pointerdown', (e)=> { const tgt = e.target as Node | null; if (cardMenu && tgt && cardMenu.contains(tgt)) return; hideCardMenu(); });
  function showCardContextMenu(card: CardSprite, globalPt: PIXI.Point){
    const el = ensureCardMenu(); cardMenuTarget = card; el.innerHTML='';
    const header = document.createElement('div'); header.textContent = 'Add to Group'; header.style.cssText='font-size:22px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;opacity:.7;padding:4px 6px 10px;'; el.appendChild(header);
  // All groups considered open (collapse removed)
  const openGroups = [...groups.values()];
    function addItem(label:string, action:()=>void, disabled=false){ const it=document.createElement('div'); it.textContent=label; it.className='ui-menu-item'; it.style.display='flex'; it.style.alignItems='center'; it.style.gap='6px'; if (disabled){ it.classList.add('disabled'); } else { it.onclick=()=> { action(); hideCardMenu(); }; }
      el.appendChild(it); return it; }
    if (!openGroups.length){ addItem('(No open groups)', ()=>{}, true); }
    else {
      openGroups.sort((a,b)=> a.id - b.id).forEach(gv=> { const already = !!card.__groupId && card.__groupId===gv.id; const it = addItem(gv.name || `Group ${gv.id}`, ()=> {
        if (already) return; // no-op
        // Remove from previous group if any
        if (card.__groupId){ const old = groups.get(card.__groupId); if (old){ removeCardFromGroup(old, card.__id); layoutGroup(old, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(old, sprites); drawGroup(old, SelectionStore.state.groupIds.has(old.id)); } }
  console.log('[cardMenu] add card', card.__id, 'to group', gv.id);
  addCardToGroupOrdered(gv, card.__id, gv.order.length); card.__groupId = gv.id; try { InstancesRepo.updateMany([{ id: card.__id, group_id: gv.id }]); } catch {}
        const prevX = card.x, prevY = card.y;
        layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); scheduleGroupSave();
        // Fallback: if card stayed in same place (layout maybe bailed), manually place at end position inside group.
        if (card.x===prevX && card.y===prevY){
          const idx = gv.order.indexOf(card.__id);
          if (idx>=0){
            const usableW = Math.max(1, gv.w - 16*2);
            const cols = Math.max(1, Math.floor((usableW + 3) / (100 + 3)));
            const col = idx % cols; const row = Math.floor(idx / cols);
            card.x = gv.gfx.x + 16 + col * (100 + 3);
            card.y = gv.gfx.y + HEADER_HEIGHT + 12 + row * (140 + 3);
            spatial.update({ id:card.__id, minX:card.x, minY:card.y, maxX:card.x+100, maxY:card.y+140 });
          }
        }
        // Update appearance for membership (non-image placeholder style) & selection outline
        updateCardSpriteAppearance(card, SelectionStore.state.cardIds.has(card.__id));
  }); if (already){ it.style.opacity='0.8'; const badge=document.createElement('span'); badge.textContent='✓'; badge.style.cssText='margin-left:auto;color:#5fcba4;font-size:24px;'; it.appendChild(badge); } });
    }
    if (card.__groupId){
      const divider=document.createElement('div'); divider.style.cssText='height:1px;background:#1e323d;margin:6px 4px;'; el.appendChild(divider);
      addItem('Remove from current group', ()=> {
        const old = card.__groupId? groups.get(card.__groupId): null;
  if (old){ console.log('[cardMenu] remove card', card.__id, 'from group', old.id); removeCardFromGroup(old, card.__id); card.__groupId=undefined; try { InstancesRepo.updateMany([{ id: card.__id, group_id: null }]); } catch {} layoutGroup(old, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(old, sprites); drawGroup(old, SelectionStore.state.groupIds.has(old.id)); scheduleGroupSave(); updateCardSpriteAppearance(card, SelectionStore.state.cardIds.has(card.__id)); }
      });
    }
    const bounds = app.renderer.canvas.getBoundingClientRect();
    el.style.left = `${bounds.left + globalPt.x + 4}px`;
    el.style.top = `${bounds.top + globalPt.y + 4}px`;
    el.style.display='block';
  }
  // Attach right-click listeners to existing cards once (after menu helpers defined)
  // Right-click gesture logic: open on button release if not dragged beyond threshold.
  const RIGHT_THRESHOLD_PX = 6; // screen-space threshold
  const rightPresses = new Map<number,{x:number,y:number,sprite:CardSprite,moved:boolean}>();
  function ensureCardContextListeners(){
    sprites.forEach(s=> {
      const anyS:any = s as any; if (anyS.__ctxAttached) return; anyS.__ctxAttached = true;
      s.on('pointerdown', (e:any)=> {
        if (e.button===2) {
          rightPresses.set(e.pointerId, { x: e.global.x, y: e.global.y, sprite: s, moved:false });
        }
      });
    });
  }
  // Global move/up handling
  app.stage.on('pointermove', (e:any)=> {
    const rp = rightPresses.get(e.pointerId); if (!rp) return;
    if (!rp.moved) {
      const dx = e.global.x - rp.x; const dy = e.global.y - rp.y;
      if (dx*dx + dy*dy > RIGHT_THRESHOLD_PX*RIGHT_THRESHOLD_PX) {
        rp.moved = true;
        // Start a right-button pan if not already panning
        if (!rightPanning) {
          rightPanning = true;
          beginPan(e.global.x, e.global.y);
        }
      }
    }
  });
  function handleRightPointerUp(e:any){
    if (e.button!==2) return; const rp = rightPresses.get(e.pointerId); if (!rp) return;
    const sprite = rp.sprite; const moved = rp.moved; rightPresses.delete(e.pointerId);
    if (!moved) {
      // Open menu at release point
      showCardContextMenu(sprite, e.global);
    }
  }
  app.stage.on('pointerup', handleRightPointerUp);
  app.stage.on('pointerupoutside', handleRightPointerUp);
  // We'll call ensureCardContextListeners after sprite creation.

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
  // If focus is in a text-editing element, don't run canvas shortcuts (allows Ctrl+A, arrows, etc.)
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.isContentEditable)) {
    // Allow Ctrl+F to reopen search, Esc handled elsewhere; block canvas fits (F / Shift+F) and others.
    if ((e.key==='f' || e.key==='F') && (e.ctrlKey||e.metaKey)) {
      // handled later by global search palette section
    } else {
      return; // swallow other canvas shortcuts while editing text
    }
  }
  // (Alt previously disabled snapping; feature removed)
  if (e.key==='g' || e.key==='G') {
      let id = groups.size ? Math.max(...groups.keys())+1 : 1;
      const b = computeSelectionBounds();
      if (b) {
  const w = (b.maxX-b.minX)+40; const h = (b.maxY-b.minY)+40;
  const gx = b.minX-20; const gy = b.minY-20;
  try { id = (GroupsRepo as any).create ? (GroupsRepo as any).create(null, null, gx, gy, w, h) : id; } catch {}
  const gv = createGroupVisual(id, gx, gy, w, h);
  const ids = SelectionStore.getCards();
  const membershipBatch: {id:number,group_id:number}[] = [];
  ids.forEach(cid=> { addCardToGroupOrdered(gv, cid, gv.order.length); const s = sprites.find(sp=> sp.__id===cid); if (s) { s.__groupId = gv.id; membershipBatch.push({id: cid, group_id: gv.id}); } });
  if (membershipBatch.length) { try { InstancesRepo.updateMany(membershipBatch); } catch {} }
  groups.set(id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv);
  layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, true); scheduleGroupSave();
        SelectionStore.clear(); SelectionStore.toggleGroup(id);
      } else {
        const center = new PIXI.Point(window.innerWidth/2, window.innerHeight/2);
        const worldCenter = world.toLocal(center);
  const gx = snap(worldCenter.x - 150); const gy = snap(worldCenter.y - 150);
  try { id = (GroupsRepo as any).create ? (GroupsRepo as any).create(null, null, gx, gy, 300, 300) : id; } catch {}
  const gv = createGroupVisual(id, gx, gy, 300, 300);
  groups.set(id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv);
  layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(gv, sprites); drawGroup(gv, true); scheduleGroupSave();
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
    // Quick rename (R) if exactly one group selected and not typing in an input
    if ((e.key==='r' || e.key==='R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName==='INPUT' || active.tagName==='TEXTAREA' || active.isContentEditable)) {
        // ignore while typing
      } else {
        const gids = SelectionStore.getGroups(); if (gids.length===1) { const gv = groups.get(gids[0]); if (gv) { e.preventDefault(); startGroupRename(gv); } }
      }
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
  // Zoom / fit shortcuts (+ / - / 0 reset, F fit all (no modifier), Shift+F fit selection, Z fit selection)
  if ((e.key==='+' || e.key==='=' ) && (e.ctrlKey||e.metaKey)) { e.preventDefault(); keyboardZoom(1.1); }
  if (e.key==='-' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); keyboardZoom(0.9); }
  if (e.key==='0' && (e.ctrlKey||e.metaKey)) { e.preventDefault(); resetZoom(); }
  // Guard: don't treat Ctrl+F / Cmd+F as fitAll so browser / custom search palette can use it
  if (!e.ctrlKey && !e.metaKey && (e.key==='f' || e.key==='F')) { if (e.shiftKey) fitSelection(); else fitAll(); }
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
  // (Collapse hotkey removed)
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
  touchedGroups.forEach(gid=> { const gv = groups.get(gid); if (gv) layoutGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); }); if (touchedGroups.size) scheduleGroupSave();
      }
  if (groupIds.length) { groupIds.forEach(id=> deleteGroupById(id)); scheduleGroupSave(); }
      SelectionStore.clear();
    }
  });

  world.sortableChildren = true;

  // Card drag handled in cardNode module (local state per card set)

  // Selection visualization (simple outline)
  SelectionStore.on(()=> { const ids = SelectionStore.getCards(); const gsel = SelectionStore.getGroups(); groups.forEach(gv=> drawGroup(gv, gsel.includes(gv.id))); sprites.forEach(s=> updateCardSpriteAppearance(s, ids.includes(s.__id))); updateGroupInfoPanel(); });

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
    // Persist membership change
    try { InstancesRepo.updateMany([{ id: s.__id, group_id: target.id }]); } catch {}
    scheduleGroupSave();
      } else {
        // Reposition within same group if significant horizontal move
        const gv = groups.get(s.__groupId); if (gv){ const desired = insertionIndexForPoint(gv, cx, cy); const curIdx = gv.order.indexOf(s.__id); if (desired!==curIdx && desired>=0){ gv.order.splice(curIdx,1); gv.order.splice(Math.min(desired, gv.order.length),0,s.__id); } }
      }
  layoutGroup(target, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(target, sprites); if (layoutOld) { layoutGroup(layoutOld, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 })); updateGroupMetrics(layoutOld, sprites); drawGroup(layoutOld, SelectionStore.state.groupIds.has(layoutOld.id)); } drawGroup(target, SelectionStore.state.groupIds.has(target.id));
    } else if (s.__groupId) {
  const old = groups.get(s.__groupId); if (old){ removeCardFromGroup(old, s.__id); } s.__groupId = undefined; if (old) { layoutGroup(old, sprites, sc=> spatial.update({ id:sc.__id, minX:sc.x, minY:sc.y, maxX:sc.x+100, maxY:sc.y+140 })); updateGroupMetrics(old, sprites); drawGroup(old, SelectionStore.state.groupIds.has(old.id)); scheduleGroupSave(); }
  // Persist removal
  try { InstancesRepo.updateMany([{ id: s.__id, group_id: null }]); } catch {}
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
    const tgt: any = e.target;
    if (panning && e.button===0) beginPan(e.global.x, e.global.y);
    if (e.button===2) {
      // If right-clicked directly on a card sprite, DON'T start a pan so we can show context menu.
      if (tgt && tgt.__cardSprite) {
        // Stop propagation so stage-level pan suppression doesn't interfere
        // (We still rely on sprite's own rightclick handler.)
        return; // skip initiating rightPanning
      }
      rightPanning = true; beginPan(e.global.x, e.global.y);
    }
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
  // Ensure modern day/night toggle (flat pill)
  try { ensureThemeToggleButton(); } catch {}
  const perfEl = document.createElement('div'); perfEl.id='perf-overlay';
  // Use shared panel theme (ensure fixed positioning & stacking above canvas)
  perfEl.className='ui-panel perf-grid';
  perfEl.style.position='fixed';
  perfEl.style.left='6px';
  perfEl.style.top='6px';
  perfEl.style.zIndex='10002';
  perfEl.style.minWidth='280px';
  perfEl.style.padding='14px 16px';
  perfEl.style.fontSize='15px';
  perfEl.style.pointerEvents='none';
  document.body.appendChild(perfEl);
  (window as any).__perfOverlay = perfEl;
  let frameCount=0; let lastFpsTime=performance.now(); let fps=0;
  let lsTimer:any=null; function scheduleLocalSave(){ if (PERSIST_MODE!=='memory') return; if (lsTimer) return; lsTimer = setTimeout(persistLocalPositions, 350); }
  function persistLocalPositions(){ lsTimer=null; try { const data = { instances: sprites.map(s=> ({id:s.__id,x:s.x,y:s.y})), byIndex: sprites.map(s=> ({x:s.x,y:s.y})) }; localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {} }
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
  ` Persist: ${PERSIST_MODE}\n`+
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

    // ---- Debug Panel (layout & grouping resets) ----
    function ensureDebugPanel(){
      let el = document.getElementById('debug-panel'); if (el) return el as HTMLDivElement;
  el = document.createElement('div'); el.id='debug-panel';
  // Base styling; precise position continuously synced below perf overlay each frame
  el.style.cssText='position:fixed;left:6px;top:300px;z-index:10005;display:flex;flex-direction:column;gap:6px;min-width:220px;transition:top .08s linear;';
  el.className='ui-panel';
  el.innerHTML = '<div style="font-weight:600;font-size:20px;margin-bottom:6px;color:var(--panel-accent);">Debug</div>';
  function addBtn(label:string, handler:()=>void){ const b=document.createElement('button'); b.textContent=label; b.className='ui-btn'; b.style.fontSize='16px'; b.style.padding='10px 14px'; b.onclick=handler; el!.appendChild(b); }
  addBtn('Grid Ungrouped Cards', ()=> { gridUngroupedCards(); });
  addBtn('Full Reset (Clear + Grid All)', ()=> { clearGroupsOnly(); resetLayout(true); });
      document.body.appendChild(el);
      // Continuous sync each frame so it's always directly below perf overlay regardless of dynamic height changes
      const syncDebugPosition = ()=> {
        const perf = document.getElementById('perf-overlay');
        if (!perf) return;
        const r = perf.getBoundingClientRect();
        const desiredLeft = r.left;
        const desiredTop = r.bottom + 10; // margin
        if (el!.style.left !== desiredLeft + 'px') el!.style.left = desiredLeft + 'px';
        if (el!.style.top !== desiredTop + 'px') el!.style.top = desiredTop + 'px';
      };
      // Hook into PIXI ticker (defined earlier). If unavailable, fallback to rAF.
      try { (app.ticker as any).add(syncDebugPosition); } catch { requestAnimationFrame(function loop(){ syncDebugPosition(); requestAnimationFrame(loop); }); }
      syncDebugPosition();
      return el;
    }
    function clearGroupsOnly(){
      // Remove membership on sprites
      const updates: {id:number,group_id:null}[] = [];
      sprites.forEach(s=> { if ((s as any).__groupId){ (s as any).__groupId = undefined; updates.push({id:s.__id, group_id:null}); } });
      if (updates.length) { try { InstancesRepo.updateMany(updates); } catch {} }
      // Destroy visuals
      const ids = [...groups.keys()]; ids.forEach(id=> { const gv = groups.get(id); if (gv){ gv.gfx.destroy(); } });
      if (ids.length) { try { GroupsRepo.deleteMany(ids); } catch {} }
      groups.clear();
  // Clear persisted group transforms (memory mode) so they don't rehydrate
  if (PERSIST_MODE==='memory') { try { localStorage.removeItem(LS_GROUPS_KEY); } catch {} }
    }
    function resetLayout(alreadyCleared:boolean){
      // Assign default grid positions based on current sprite order
      const cols = Math.ceil(Math.sqrt(sprites.length || 1));
      const batch: {id:number,x:number,y:number}[] = [];
      sprites.forEach((s, idx)=> { const col = idx % cols; const row = Math.floor(idx/cols); const x = col * (CARD_W_GLOBAL + GAP_X_GLOBAL); const y = row * (CARD_H_GLOBAL + GAP_Y_GLOBAL); s.x = x; s.y = y; spatial.update({ id:s.__id, minX:x, minY:y, maxX:x+100, maxY:y+140 }); batch.push({id:s.__id,x,y}); });
      if (batch.length) { try { InstancesRepo.updatePositions(batch); } catch {} }
      if (PERSIST_MODE==='memory') { try { const data = { instances: sprites.map(s=> ({id:s.__id,x:s.x,y:s.y})), byIndex: sprites.map(s=> ({x:s.x,y:s.y})) }; localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {} }
      if (!alreadyCleared) clearGroupsOnly();
    }
    function gridUngroupedCards(){
      const ungrouped = sprites.filter(s=> !(s as any).__groupId);
      if (!ungrouped.length) return;
      // Compute vertical placement just below all existing groups
      let maxBottom = 0; let hasGroup=false;
      groups.forEach(gv=> { hasGroup=true; const b = gv.gfx.y + gv.h; if (b>maxBottom) maxBottom = b; });
      const startY = hasGroup ? snap(maxBottom + 80) : 0;
      // Simple grid width heuristic
      const cols = Math.ceil(Math.sqrt(ungrouped.length));
      const batch: {id:number,x:number,y:number}[] = [];
      ungrouped.forEach((s, idx)=> { const col = idx % cols; const row = Math.floor(idx/cols); const x = col * (CARD_W_GLOBAL + GAP_X_GLOBAL); const y = startY + row * (CARD_H_GLOBAL + GAP_Y_GLOBAL); s.x = x; s.y = y; spatial.update({ id:s.__id, minX:x, minY:y, maxX:x+100, maxY:y+140 }); batch.push({id:s.__id,x,y}); });
      if (batch.length) { try { InstancesRepo.updatePositions(batch); } catch {} }
      if (PERSIST_MODE==='memory') { try { const data = { instances: sprites.map(s=> ({id:s.__id,x:s.x,y:s.y})), byIndex: sprites.map(s=> ({x:s.x,y:s.y})) }; localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {} }
    }
    ensureDebugPanel();

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
    // If typing in an input/textarea/contentEditable, allow native editing keys (arrows, Ctrl+A, etc.)
    const active = document.activeElement as HTMLElement | null;
    const editing = active && (active.tagName==='INPUT' || active.tagName==='TEXTAREA' || active.isContentEditable);
    // Skip global handlers that would conflict with text editing
    if (editing) {
      // Allow palette-specific Esc (handled elsewhere) and Enter (handled in palette) to bubble.
      // Prevent canvas-wide shortcuts below from firing while editing.
      // Exceptions: Ctrl+F still opens new search (avoid recursion) so if already in search input ignore.
      if ((e.key==='a' || e.key==='A') && (e.ctrlKey||e.metaKey)) return; // let browser select-all
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return; // let caret move
      if ((e.key==='g' || e.key==='G') && !e.ctrlKey && !e.metaKey && !e.altKey) return; // prevent accidental group creation
      if ((e.key==='f' || e.key==='F') && (e.ctrlKey||e.metaKey)) return; // rely on browser find when inside other inputs (search palette already overrides inside itself)
    }
    // Search palette open shortcuts
    // Ctrl/Cmd+F: open search (override default find) when not in another input
    if ((e.key==='f' || e.key==='F') && (e.ctrlKey||e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      searchUI.show('');
      return; // prevent falling through to fit logic below
    }
    // '/' quick open (common in web apps). Ignore if typing inside an editable element.
    if (e.key==='/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement | null;
      const editingTarget = target && (target.tagName==='INPUT' || target.tagName==='TEXTAREA' || target.isContentEditable);
      if (!editingTarget) {
        e.preventDefault();
        searchUI.show('');
        return;
      }
    }
    if (e.key==='u' || e.key==='U') {
      const scale = world.scale.x;
      sprites.forEach(s=> { if (s.visible && s.__imgLoaded) updateCardTextureForScale(s, scale); });
    }
  });

  installModeToggle();
  // Search palette setup
  const searchUI = installSearchPalette({
    getSprites: ()=> sprites,
    createGroupForSprites: (ids:number[], name:string)=> {
      let id = groups.size ? Math.max(...groups.keys())+1 : 1;
      try { id = (GroupsRepo as any).create ? (GroupsRepo as any).create(name, null, 0, 0, 300, 300) : id; } catch {}
      const gv = createGroupVisual(id, 0, 0, 300, 300);
      gv.name = name;
      groups.set(id, gv); world.addChild(gv.gfx); attachResizeHandle(gv); attachGroupInteractions(gv);
      ids.forEach(cid=> { addCardToGroupOrdered(gv, cid, gv.order.length); const s = sprites.find(sp=> sp.__id===cid); if (s) { (s as any).__groupId = gv.id; } });
      try { InstancesRepo.updateMany(ids.map(cid=> ({id: cid, group_id: gv.id}))); } catch {}
      // Auto-pack to minimize height (balanced grid close to square)
      autoPackGroup(gv, sprites, s=> spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 }));
      updateGroupMetrics(gv, sprites); drawGroup(gv, false);
      // --- Non-overlapping placement ---
      (function placeGroup(){
        const pad = 16; // extra spacing from other objects
        const searchCols = 40; const searchRows = 40; // safety bounds
        const invScale = 1 / world.scale.x;
        const viewLeft = (-world.position.x) * invScale;
        const viewTop = (-world.position.y) * invScale;
        const startX = snap(viewLeft + 40);
        const startY = snap(viewTop + 40);
        function collides(x:number,y:number): boolean {
          const gx1 = x - pad, gy1 = y - pad, gx2 = x + gv.w + pad, gy2 = y + gv.h + pad;
          // Existing groups
            for (const eg of groups.values()) {
              if (eg.id===gv.id) continue; // skip self
              const x1 = eg.gfx.x - pad, y1 = eg.gfx.y - pad, x2 = eg.gfx.x + eg.w + pad, y2 = eg.gfx.y + eg.h + pad;
              if (gx1 < x2 && gx2 > x1 && gy1 < y2 && gy2 > y1) return true;
            }
          // Existing cards (ignore cards in this new group since they will move with it)
          for (const s of sprites){
            if ((s as any).__groupId === gv.id) continue;
            const x1 = s.x - 4, y1 = s.y - 4, x2 = s.x + 100 + 4, y2 = s.y + 140 + 4;
            if (gx1 < x2 && gx2 > x1 && gy1 < y2 && gy2 > y1) return true;
          }
          return false;
        }
        let found=false; let bestX=gv.gfx.x, bestY=gv.gfx.y;
        outer: for (let row=0; row<searchRows; row++) {
          for (let col=0; col<searchCols; col++) {
            const x = snap(startX + col * (gv.w + 60));
            const y = snap(startY + row * (gv.h + 60));
            if (!collides(x,y)) { bestX=x; bestY=y; found=true; break outer; }
          }
        }
        if (!found) {
          // Fallback: place to the far right of current max extent
          let maxX=0, minY=0; let initialized=false;
          sprites.forEach(s=> { if (!initialized){ maxX=s.x+100; minY=s.y; initialized=true; } else { if (s.x+100>maxX) maxX=s.x+100; if (s.y<minY) minY=s.y; } });
          groups.forEach(eg=> { if (eg.id===gv.id) return; if (eg.gfx.x+eg.w>maxX) maxX=eg.gfx.x+eg.w; if (eg.gfx.y<minY) minY=eg.gfx.y; });
          bestX = snap(maxX + 120); bestY = snap(minY);
        }
        const dx = bestX - gv.gfx.x; const dy = bestY - gv.gfx.y;
        if (dx || dy) {
          gv.gfx.x = bestX; gv.gfx.y = bestY;
          // Shift member cards
          for (const cid of gv.order){ const s = sprites.find(sp=> sp.__id===cid); if (s){ s.x += dx; s.y += dy; spatial.update({ id:s.__id, minX:s.x, minY:s.y, maxX:s.x+100, maxY:s.y+140 }); } }
        }
      })();
      scheduleGroupSave();
      // Fit new group into view
      const b = { x: gv.gfx.x, y: gv.gfx.y, w: gv.w, h: gv.h };
      camera.fitBounds(b, { w: window.innerWidth, h: window.innerHeight });
      try { persistGroupTransform(gv.id,{x:gv.gfx.x,y:gv.gfx.y,w:gv.w,h:gv.h}); } catch {}
    },
    focusSprite: (id:number)=> {
      const s = sprites.find(sp=> sp.__id===id); if (!s) return;
      // Center camera on sprite without changing zoom drastically.
      const target = { x: s.x, y: s.y, w: 100, h: 140 };
  camera.fitBounds(target, { w: window.innerWidth, h: window.innerHeight });
    }
  });

  // Table mode stub container
  const tableEl = document.createElement('div');
  tableEl.id='table-mode';
  tableEl.style.cssText='position:fixed;inset:0;display:none;background:#0d1419;color:#d5d5d5;font:12px/1.4 "Inter",system-ui,monospace;padding:10px;z-index:60;overflow:auto;';
  tableEl.innerHTML = '<h2 style="margin:8px 0 18px;font-size:28px;">Table Mode (Phase 1 Stub)</h2><p style="font-size:24px;">Press Tab to return to canvas.</p>';
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

  app.ticker.add(()=> { const now = performance.now(); const dt = now - last; last = now; camera.update(dt); runCulling(); loadVisibleImages(); upgradeVisibleHiRes(); groups.forEach(gv=> { updateGroupTextQuality(gv, world.scale.x); updateGroupZoomPresentation(gv, world.scale.x, sprites); }); updatePerf(dt); });
  // Periodically ensure any new sprites have context listeners
  setInterval(()=> { try { ensureCardContextListeners(); } catch {} }, 2000);
  if (PERSIST_MODE==='memory') {
    window.addEventListener('beforeunload', ()=> {
      try { persistLocalPositions(); } catch {}
      try { // flush any pending group save immediately
        const anyWin:any = window; if (anyWin.lsGroupsTimer) { clearTimeout(anyWin.lsGroupsTimer); }
        // direct call ensures groups saved even if debounce pending
        (function(){ try { const data = { groups: [...groups.values()].map(gv=> ({ id: gv.id, x: gv.gfx.x, y: gv.gfx.y, w: gv.w, h: gv.h, name: gv.name, collapsed: gv.collapsed, color: gv.color, membersById: gv.order.slice(), membersByIndex: gv.order.map(cid=> sprites.findIndex(s=> s.__id===cid)).filter(i=> i>=0) })) }; localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(data)); } catch {} })();
      } catch {}
    });
  }

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
