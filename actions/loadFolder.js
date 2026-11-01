const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { IMAGE_EXTENSIONS, stem, captionPath } = require('./paths');
const filenameOrder = new Intl.Collator('en', { numeric: true });
module.exports = async function loadFolder(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter(e => e.isFile()).map(e => e.name);
  const captions = new Map();
  const imageStems = new Map();
  for (const name of files) {
    const key = stem(name).toLowerCase();
    if (path.extname(name).toLowerCase() === '.txt') captions.set(key, [...(captions.get(key) || []), name]);
    if (IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) imageStems.set(key, (imageStems.get(key) || 0) + 1);
  }
  const items = files.filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort(filenameOrder.compare).map(filename => {
      const imagePath = path.join(dir, filename);
      const key = stem(filename).toLowerCase();
      const matches = captions.get(key) || [];
      const ambiguous = imageStems.get(key) > 1 || matches.length > 1;
      return { filename, imagePath, imageUrl: pathToFileURL(imagePath).href,
        tagPath: matches.length === 1 ? path.join(dir, matches[0]) : null,
        captionPath: matches.length === 1 ? path.join(dir, matches[0]) : captionPath(imagePath), ambiguous };
    });
  return { items, warnings: items.filter(i => i.ambiguous).map(i => `Ambiguous image/caption stem: ${i.filename}`) };
};
