const path = require('path');
const fse = require('fs-extra');
const crypto = require('crypto');
const undo = require('./undoManager');

function uid() { return crypto.randomBytes(6).toString('hex'); }

module.exports = async function deleteItems(payload) {
  const { items, scope = 'selected', selectedPaths = [] } = payload || {};
  if (!Array.isArray(items) || !items.length) return { ok:false, error:'No items'};
  if (scope !== 'selected' || !selectedPaths.length) return { ok:false, error:'No selected items'};

  const sel = new Set(selectedPaths);
  const targets = items.filter(it => sel.has(it.imagePath));
  if (!targets.length) return { ok:false, error:'Nothing matched selection' };

  // group by dir → each dir has its own .ldp_trash
  const work = targets.map(it => {
    const dir = path.dirname(it.imagePath);
    return { dir, it };
  });

  const snap = { type:'delete', restores: [] }; // {trashImg, finalImg, trashTag?, finalTag?}

  for (const { dir, it } of work) {
    const trashDir = path.join(dir, '.ldp_trash');
    await fse.ensureDir(trashDir);

    const imgExt = path.extname(it.imagePath);
    const trashImg = path.join(trashDir, `img_${uid()}${imgExt}`);
    await fse.move(it.imagePath, trashImg);
    const entry = { trashImg, finalImg: it.imagePath };

    if (it.tagPath) {
      const trashTag = path.join(trashDir, `tag_${uid()}.txt`);
      await fse.move(it.tagPath, trashTag);
      entry.trashTag = trashTag;
      entry.finalTag = it.tagPath;
    }
    snap.restores.push(entry);
  }

  undo.push(snap);
  return { ok:true, deleted: targets.length };
};
