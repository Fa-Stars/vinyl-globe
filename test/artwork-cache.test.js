'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createArtworkCache}=require('../web/artwork-cache');
const url='https://usercontent.jamendo.com/a.jpg';
test('artwork cache is bounded and coalesces concurrent requests',async()=>{
 let hits=0;const cache=createArtworkCache({maxBytes:8,maxItemBytes:8,maxEntries:2,fetch:async()=>{hits++;return new Response('1234',{headers:{'content-type':'image/jpeg'}});}});
 await Promise.all([cache.get(url),cache.get(url)]);assert.equal(hits,1);
 for(let i=0;i<5;i++)await cache.get(url+i);
 assert.ok(cache.stats().entries<=2);assert.ok(cache.stats().bytes<=8);
});
test('artwork rejects foreign URLs, private redirects and oversized chunked responses',async()=>{
 let hits=0;
 const cache=createArtworkCache({maxItemBytes:4,fetch:async()=>{hits++;return new Response('too-large',{headers:{'content-type':'image/jpeg'}});}});
 assert.equal(await cache.get('https://example.com/a'),null);assert.equal(hits,0);
 assert.equal(await cache.get(url),null);
 const redirect=createArtworkCache({fetch:async()=>{hits++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}});
 assert.equal(await redirect.get(url),null);assert.equal(hits,2);
});
test('expired artwork is fetched again and non-images use the local fallback',async()=>{
 let now=0,hits=0;const cache=createArtworkCache({now:()=>now,fetch:async()=>{hits++;return new Response('image',{headers:{'content-type':hits===1?'text/html':'image/png'}});}});
 assert.equal(await cache.get(url),null);assert.equal(await cache.get(url),null);assert.equal(hits,1);
 now+=60001;assert.ok(await cache.get(url));assert.equal(hits,2);
});
