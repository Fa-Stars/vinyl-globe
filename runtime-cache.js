'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIRS = ['audio', 'jamendo', 'songs'];
const CACHE_FILES = ['artist-countries.json'];

function containedPath(root, name) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, name);
  return resolved !== resolvedRoot && resolved.startsWith(resolvedRoot + path.sep)
    ? resolved
    : null;
}

function removeContained(root, name, report) {
  const target = containedPath(root, name);
  if (!target) {
    report(new Error('refusing to remove path outside runtime root: ' + name));
    return 0;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return 1;
  } catch (error) {
    report(error);
    return 0;
  }
}

// Startup only clears artifacts that could otherwise make an old session look
// restorable.  Configuration, the numeric catalog boundary, and artist
// country evidence deliberately remain intact.
function clearLegacyRuntimeCache(root, warn) {
  const report = typeof warn === 'function' ? warn : () => {};
  let removed = 0;
  for (const dir of CACHE_DIRS) removed += removeContained(root, dir, report);
  return removed;
}

function clearRuntimeCache(root, warn) {
  const report = typeof warn === 'function' ? warn : () => {};
  let removed = 0;

  removed += clearLegacyRuntimeCache(root, report);

  for (const file of CACHE_FILES) {
    removed += removeContained(root, file, report);
  }

  // 地球图片属于运行时下载缓存，不触碰 config.json。
  try {
    for (const name of fs.readdirSync(root)) {
      if (!/^globe-.*\.png$/i.test(name)) continue;
      removed += removeContained(root, name, report);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') report(error);
  }

  return removed;
}

module.exports = { clearLegacyRuntimeCache, clearRuntimeCache };
