'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createPlayer}=require('../test-support/player.cjs');
const mapData=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/public/map.json'),'utf8'));
const capitals=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/public/capitals.json'),'utf8'));
const player=options=>createPlayer({mapData,capitalsResponse:r=>r(capitals),
  infoResponse:r=>r({mode:'setup-required',configured:false}),...options});

test('ripples animate large and tiny countries without moving their geographic marker',async()=>{
  const p=await player();
  for(const code of ['CN','JP','FR','MT','RU','BR']) {
    const initial=p.focusCountry(code,0),before=p.lastFrame.data;
    const pin=p.element('globe-pin');
    const position={left:pin.style.left,top:pin.style.top};
    assert.ok(Math.abs(parseFloat(position.left)-160)<1e-6);
    assert.ok(Math.abs(parseFloat(position.top)-160)<1e-6);
    assert.ok(initial.zoom>=1 && initial.zoom<=1.14,'keep the globe visible for tiny countries');
    p.focusCountry(code,600);
    assert.notDeepEqual(p.lastFrame.data,before,code+' must have moving light');
    assert.deepEqual({left:pin.style.left,top:pin.style.top},position,code+' marker must stay anchored');
    assert.equal(pin.classList.contains('is-visible'),true);
  }
});

test('a hidden page freezes ripple phase and resumes without a large animation jump',async()=>{
  const p=await player();p.focusCountry('JP',0);p.frame(0);p.frame(40);
  const before=p.lastFrame.data,frames=p.renderedFrames;
  p.frame(2000,true);p.frame(60000,true);assert.equal(p.renderedFrames,frames);
  p.frame(60001);assert.deepEqual(p.lastFrame.data,before);
  p.frame(60041);assert.notDeepEqual(p.lastFrame.data,before);
});

test('reduced motion preserves a fixed location and can be changed while the page is open',async()=>{
  const p=await player({reducedMotion:true});p.focusCountry('MT',0);p.frame(0);
  const fixed=p.lastFrame.data;p.frame(500);p.frame(1000);
  assert.deepEqual(p.lastFrame.data,fixed);
  await p.reduceMotion(false);p.frame(1100);p.frame(1140);
  assert.notDeepEqual(p.lastFrame.data,fixed);
  await p.reduceMotion(true);p.frame(1200);const stopped=p.lastFrame.data;p.frame(1700);
  assert.deepEqual(p.lastFrame.data,stopped);
});
