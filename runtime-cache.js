'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIRS = ['audio', 'jamendo', 'songs'];
const CACHE_FILES = ['artist-countries.json'];

function clearRuntimeCache(root, warn) {
  const report = typeof warn === 'function' ? warn : () => {};
  let removed = 0;

  for (const dir of CACHE_DIRS) {
    try {
      fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      removed++;
    } catch (error) {
      report(error);
    }
  }

  for (const file of CACHE_FILES) {
    try {
      fs.rmSync(path.join(root, file), { force: true });
      removed++;
    } catch (error) {
      report(error);
    }
  }

  // 地球图片属于运行时下载缓存，不触碰 config.json。
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^globe-.*\.png$/i.test(name)) continue;
      fs.rmSync(path.join(root, name), { force: true });
      removed++;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') report(error);
  }

  return removed;
}

module.exports = { clearRuntimeCache };
