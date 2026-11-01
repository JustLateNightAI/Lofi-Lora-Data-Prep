const path = require('node:path');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const stem = file => path.basename(file, path.extname(file));
const captionPath = file => path.join(path.dirname(file), `${stem(file)}.txt`);
function portableName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 ||
      /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value === '.' || value === '..') {
    throw new Error('Use a filename valid on Linux and Windows (no slashes, reserved names, or trailing dots/spaces).');
  }
  return value;
}
function pickTargets(items, scope = 'all', selectedPaths = []) {
  if (!['all', 'selected'].includes(scope)) throw new Error('Invalid selection scope.');
  const selected = new Set(selectedPaths);
  return items.filter(item => scope === 'all' || selected.has(item.imagePath));
}
module.exports = { IMAGE_EXTENSIONS, stem, captionPath, portableName, pickTargets };
