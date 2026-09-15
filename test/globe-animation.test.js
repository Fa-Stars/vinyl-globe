'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

// An empty map keeps this a timing test; the real app still runs its animation loop.
const mapData = { w: 1, h: 1, grid: '', names: {}, aliases: {} };

test('globe rendering is bounded and its speed is independent of display refresh rate', async () => {
  const rotations = [];
  for (const hz of [30, 60, 120, 144]) {
    const player = await createPlayer({ mapData });
    for (let i = 0; i <= hz * 2; i++) player.frame(i * 1000 / hz);
    assert.ok(player.renderedFrames >= 59 && player.renderedFrames <= 61,
      hz + 'Hz display rendered ' + player.renderedFrames + ' frames in two seconds');
    rotations.push(player.globeRotation);
  }
  for (const rotation of rotations) assert.ok(Math.abs(rotation - 7.2) < 0.01);
});

test('a hidden page does not render and resuming does not jump the globe forward', async () => {
  const player = await createPlayer({ mapData });
  player.frame(0);
  player.frame(1000 / 30);
  const rotation = player.globeRotation;
  const frames = player.renderedFrames;
  player.frame(1000, true);
  player.frame(60000, true);
  assert.equal(player.renderedFrames, frames);
  player.frame(60001);
  assert.equal(player.globeRotation, rotation);
  player.frame(60001 + 1000 / 30);
  assert.ok(player.globeRotation > rotation);
  assert.ok(player.globeRotation - rotation < 0.13);
});
