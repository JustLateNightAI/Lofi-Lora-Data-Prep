const fg = require('fast-glob');
const path = require('path');
const fs = require('fs');

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

module.exports = function loadFolder(dir) {
  if (!dir) return { items: [] };
  const entries = fg.sync(['*'], { cwd: dir, onlyFiles: true });
  const items = [];

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (!IMG_EXT.has(ext)) continue;
    const base = path.basename(name, ext);
    const imgPath = path.join(dir, name);

    const txtPath = path.join(dir, `${base}.txt`);
    const hasTxt = fs.existsSync(txtPath);

    items.push({
      imagePath: imgPath,
      tagPath: hasTxt ? txtPath : null,
      filename: name
    });
  }

  return { items };
};
