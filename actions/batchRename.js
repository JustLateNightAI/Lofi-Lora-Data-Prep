// actions/batchRename.js
// payload: {
//   items: Array<{ imagePath: string, tagPath?: string|null }>,   // full scan list
//   outDir: string|null,                                          // if set -> copy to outDir; else rename in place
//   baseName: string,                                             // e.g., "cortanaLora"
//   pad: number,                                                  // e.g., 4 -> 0001
//   start: number,                                                // starting index (default 0)
//   scope: "all"|"selected",
//   selectedPaths?: string[]                                      // imagePath keys when scope==="selected"
// }

const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const crypto = require('crypto');
const undoManager = require('./undoManager');

function zpad(n, width) {
  const s = String(n);
  if (s.length >= width) return s;
  return '0'.repeat(width - s.length) + s;
}

function pickTargets(items, scope, selected) {
  if (scope === 'selected' && selected && selected.length) {
    const set = new Set(selected);
    return items.filter(it => set.has(it.imagePath));
  }
  return items.slice();
}

function uniqueTmpName(dir, ext) {
  const id = crypto.randomBytes(6).toString('hex'); // 12 hex chars
  return path.join(dir, `__LDP_TMP__${id}${ext}`);
}

module.exports = async function batchRename(payload) {
  const {
    items, outDir = null, baseName, pad = 4, start = 0,
    scope = 'all', selectedPaths = []
  } = payload || {};

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'No items provided.' };
  }
  if (!baseName || typeof baseName !== 'string') {
    return { ok: false, error: 'baseName is required.' };
  }
  if (outDir) {
    await fse.ensureDir(outDir);
  }

  const targets = pickTargets(items, scope, selectedPaths);
  if (targets.length === 0) {
    return { ok: false, error: 'No items match selection.' };
  }

  // Build final filenames upfront (deterministic)
  const plan = [];
  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    const ext = path.extname(it.imagePath).toLowerCase(); // keep original image extension
    const idx = start + i;
    const stem = `${baseName}_${zpad(idx, pad)}`;
    const toImage = outDir
      ? path.join(outDir, `${stem}${ext}`)
      : path.join(path.dirname(it.imagePath), `${stem}${ext}`);
    const toTag = it.tagPath
      ? (outDir
          ? path.join(outDir, `${stem}.txt`)
          : path.join(path.dirname(it.tagPath), `${stem}.txt`))
      : null;

    plan.push({
      fromImage: it.imagePath,
      fromTag: it.tagPath || null,
      toImage,
      toTag
    });
  }

  // Guard: avoid accidental overwrite when copying to outDir
  if (outDir) {
    for (const p of plan) {
      if (await fse.pathExists(p.toImage)) {
        return { ok: false, error: `Target exists: ${p.toImage}` };
      }
      if (p.toTag && await fse.pathExists(p.toTag)) {
        return { ok: false, error: `Target exists: ${p.toTag}` };
      }
    }
  }

  const changes = [];
  const undoSnap = {
    type: 'batchRename',
    created: [],         // for copy mode (outDir) — files we create so undo can delete them
    renames: [],         // for in-place mode — [{from, to}] so undo can reverse
    tagCreated: [],      // created .txt files (copy mode)
    tagRenames: []       // in-place .txt renames
  };

  if (outDir) {
    // COPY MODE — originals untouched
    for (const p of plan) {
      await fse.copy(p.fromImage, p.toImage);
      undoSnap.created.push(p.toImage);
      if (p.fromTag && p.toTag) {
        await fse.copy(p.fromTag, p.toTag);
        undoSnap.tagCreated.push(p.toTag);
      }
      changes.push({ from: p.fromImage, to: p.toImage });
      if (p.fromTag && p.toTag) {
        changes.push({ from: p.fromTag, to: p.toTag });
      }
    }
  } else {
    // IN-PLACE RENAME — two-phase to avoid collisions
    // Phase 1: move all to unique temp names
    const temps = [];
    try {
      for (const p of plan) {
        const srcDir = path.dirname(p.fromImage);
        const imgExt = path.extname(p.fromImage);
        const tmpImg = uniqueTmpName(srcDir, imgExt);
        await fse.move(p.fromImage, tmpImg);
        temps.push({ tmpImg, finalImg: p.toImage, origImg: p.fromImage });
        undoSnap.renames.push({ from: tmpImg, to: p.fromImage }); // to reverse phase 1 if needed

        if (p.fromTag) {
          const tmpTag = uniqueTmpName(srcDir, '.txt');
          await fse.move(p.fromTag, tmpTag);
          temps[temps.length - 1].tmpTag = tmpTag;
          temps[temps.length - 1].finalTag = p.toTag;
          temps[temps.length - 1].origTag = p.fromTag;
          undoSnap.tagRenames.push({ from: tmpTag, to: p.fromTag });
        }
      }

      // Phase 2: move temps to final names
      for (const t of temps) {
        await fse.move(t.tmpImg, t.finalImg);
        // update undo mapping: to reverse fully, we need final->orig
        undoSnap.renames.push({ from: t.finalImg, to: t.origImg });
        changes.push({ from: t.origImg, to: t.finalImg });

        if (t.tmpTag && t.finalTag) {
          await fse.move(t.tmpTag, t.finalTag);
          undoSnap.tagRenames.push({ from: t.finalTag, to: t.origTag });
          changes.push({ from: t.origTag, to: t.finalTag });
        }
      }
    } catch (err) {
      // catastrophic failure — try to revert temps best-effort
      // (We already stashed entries for phase 1 in undoSnap; we’ll attempt to move them back)
      for (const entry of undoSnap.renames) {
        try {
          if (await fse.pathExists(entry.from)) {
            await fse.move(entry.from, entry.to, { overwrite: true });
          }
        } catch (_) { /* swallow */ }
      }
      for (const entry of undoSnap.tagRenames) {
        try {
          if (await fse.pathExists(entry.from)) {
            await fse.move(entry.from, entry.to, { overwrite: true });
          }
        } catch (_) { /* swallow */ }
      }
      return { ok: false, error: `Rename failed: ${err.message}` };
    }
  }

  // push snapshot for future undo
  try { undoManager.push(undoSnap); } catch (_) {}

  return { ok: true, changes };
};
