import assert from 'node:assert/strict';
export const gameSites=[
  {id:'xtype',url:'https://phoboslab.org/xtype/',editor:true,timeout:60000},
  {id:'swooop',url:'https://playcanv.as/p/JtL2iqIH/',editor:true,timeout:90000}
];
export async function interactGame(page,proxy,site,{surface,read,wait}){
  if(site.id==='swooop'){
    await surface.locator('iframe').first().waitFor();
    surface=surface.frameLocator('iframe');
    const outerRead=read,outerWait=wait,child=source=>'document.querySelector("iframe").contentWindow.eval('+JSON.stringify(source)+')';
    read=(page,proxy,source)=>outerRead(page,proxy,child(source));
    wait=(page,proxy,source)=>outerWait(page,proxy,child(source));
    const game='pc.Application.getApplication().root.findByName("Game").script.game';
    await wait(page,proxy,'!!globalThis.pc?.Application?.getApplication()?.root.findByName("Game")?.script?.game?.player');
    // This engine samples key state once per frame; keep Enter down long enough
    // for its menu update to observe a real press before keyup.
    await surface.locator('#application-canvas').click({position:{x:20,y:20}});await page.keyboard.press('Enter',{delay:100});
    await wait(page,proxy,game+'.paused===false&&'+game+'.player.entity.enabled===true');
    const initial=await read(page,proxy,'(()=>{const game='+game+';return {fuel:game.fuel,position:Array.from(game.player.entity.getPosition().data)};})()');
    await page.keyboard.down('Space');try{
      await wait(page,proxy,game+'.player.fly===true&&'+game+'.fuel<'+JSON.stringify(initial.fuel));
      await wait(page,proxy,'Array.from('+game+'.player.entity.getPosition().data).some((value,index)=>Math.abs(value-'+JSON.stringify(initial.position)+'[index])>0.1)');
    }finally{await page.keyboard.up('Space');}
    await wait(page,proxy,game+'.player.fly===false');
    const webgl=await read(page,proxy,'(()=>{const gl=pc.Application.getApplication().graphicsDevice.gl;return !!gl&&!gl.isContextLost()&&gl.drawingBufferWidth>0&&gl.drawingBufferHeight>0;})()');assert.equal(webgl,true,'Game WebGL context is unavailable');
    return {started:true,flightInput:true,moved:true,consumedFuel:true,released:true,webgl};
  }
  // The loader starts the animation loop before its fade hands input to the
  // game. Wait for that handoff so a click cannot disappear during startup.
  await wait(page,proxy,'!!globalThis.ig?.system?.running&&ig.system.delegate===ig.game&&!!ig.game?.menu');
  const canvas=surface.locator('#canvas');
  const clickMenu=async text=>{
    const item=await read(page,proxy,'(()=>{const menu=ig.game.menu,index=menu.items.findIndex(item=>item.getText()==='+JSON.stringify(text)+');return {index,x:ig.system.width/2,y:menu.y+index*(menu.font.height+20)+menu.font.height/2,width:ig.system.width,height:ig.system.height};})()');
    assert.ok(item.index>=0,'Game menu item missing: '+text);const box=await canvas.boundingBox();assert.ok(box,'Game canvas is unavailable');await canvas.click({position:{x:item.x/item.width*box.width,y:item.y/item.height*box.height}});
  };
  await clickMenu('Start Game!');
  await wait(page,proxy,'ig.game.mode===1&&!ig.game.menu&&ig.game.player?.pos.y<ig.system.height-60');
  const before=await read(page,proxy,'ig.game.player.pos.x');
  await page.keyboard.down('ArrowRight');try{await wait(page,proxy,'ig.game.player.pos.x>'+JSON.stringify(before+15));}finally{await page.keyboard.up('ArrowRight');}
  const right=await read(page,proxy,'ig.game.player.pos.x');
  await page.keyboard.down('ArrowLeft');try{await wait(page,proxy,'ig.game.player.pos.x<'+JSON.stringify(right-15));}finally{await page.keyboard.up('ArrowLeft');}
  const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/4);await page.mouse.down();
  try{
    await wait(page,proxy,'ig.game.entities.some(entity=>entity instanceof EntityPlasma)');
    await wait(page,proxy,'ig.game.player.soundShoot.currentClip&&!ig.game.player.soundShoot.currentClip.paused');
  }finally{await page.mouse.up();}
  await page.keyboard.press('Escape');await wait(page,proxy,'!!ig.game.menu');
  const paused=await read(page,proxy,'({x:ig.game.player.pos.x,y:ig.game.player.pos.y})');
  await page.keyboard.down('ArrowRight');try{await page.waitForTimeout(200);assert.deepEqual(await read(page,proxy,'({x:ig.game.player.pos.x,y:ig.game.player.pos.y})'),paused,'Player moved while game was paused');}finally{await page.keyboard.up('ArrowRight');}
  await clickMenu('Resume');await wait(page,proxy,'!ig.game.menu&&ig.game.mode===1');
  return {started:true,movedRight:true,movedLeft:true,shot:true,audioPlayed:true,paused:true,resumed:true};
}
