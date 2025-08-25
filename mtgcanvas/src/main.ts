import * as PIXI from 'pixi.js';

const app = new PIXI.Application();
(async () => {
  await app.init({ background: '#1e1e1e', resizeTo: window });
  document.body.appendChild(app.canvas);

  const world = new PIXI.Container();
  app.stage.addChild(world);

  // Simple mock card rectangles for now
  for (let i=0;i<200;i++) {
    const g = new PIXI.Graphics();
    g.rect(0,0,100,140).fill({color:0xffffff}).stroke({color:0x000000,width:2});
    g.x = (i%20)*110;
    g.y = Math.floor(i/20)*150;
    g.eventMode = 'static';
    g.cursor = 'pointer';
    let dragging = false; let offsetX=0; let offsetY=0;
    g.on('pointerdown', (e)=>{ dragging = true; const global = e.global; offsetX = global.x - g.x; offsetY = global.y - g.y; });
    app.stage.on('pointerup', ()=> dragging=false);
    app.stage.on('pointerupoutside', ()=> dragging=false);
    app.stage.on('pointermove', (e)=>{ if (!dragging) return; const global=e.global; g.x = global.x - offsetX; g.y = global.y - offsetY; });
    world.addChild(g);
  }

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
})();
