// actions/shuffleDataset.js
// payload: { items: [{ imagePath, tagPath? }], outDir: string|null, inDir: string,
//            scope: "all"|"selected", selectedPaths?: string[] }
const fs   = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let snapshot;
try { snapshot = require('./snapshot'); } catch { snapshot = null; }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

function padWidth(n) {
  const w = String(Math.max(0, n - 1)).length;
  return Math.max(4, w); // min 4 digits
}

function tagPathFor(imgPath) {
  const dir = path.dirname(imgPath);
  const base = path.basename(imgPath, path.extname(imgPath));
  return path.join(dir, `${base}.txt`);
}

function tmpNameFor(p) {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const id = crypto.randomBytes(6).toString('hex');
  return path.join(dir, `.__shuf_${id}__${base}`);
}

async function copyPair(srcImg, destImg) {
  await fs.mkdir(path.dirname(destImg), { recursive: true });
  await fs.copyFile(srcImg, destImg);
  const srcTag = tagPathFor(srcImg);
  if (await exists(srcTag)) {
    const destBase = path.basename(destImg, path.extname(destImg));
    const destTag  = path.join(path.dirname(destImg), `${destBase}.txt`);
    await fs.copyFile(srcTag, destTag);
  }
}

async function renamePair(srcImg, destImg) {
  // 2‑phase safe rename for image
  const tmpImg = tmpNameFor(srcImg);
  await fs.rename(srcImg, tmpImg);
  await fs.rename(tmpImg, destImg);

  // tag if present
  const srcTag = tagPathFor(srcImg);          // NOTE: srcImg no longer exists; this is the *old* tag path
  if (await exists(srcTag)) {
    const tmpTag = tmpNameFor(srcTag);
    await fs.rename(srcTag, tmpTag);

    const destBase = path.basename(destImg, path.extname(destImg));
    const destTag  = path.join(path.dirname(destImg), `${destBase}.txt`);
    await fs.rename(tmpTag, destTag);
  }
}

module.exports = async function shuffleDataset(payload) {
  try {
    if (!payload || !Array.isArray(payload.items)) {
      return { ok: false, error: 'items[] required' };
    }
    const inDir = payload.inDir;
    if (!inDir) return { ok: false, error: 'inDir required' };

    const scope = payload.scope === 'selected' ? 'selected' : 'all';
    const selected = new Set(payload.selectedPaths || []);

    // candidates = items we will shuffle & reindex
    const candidates = payload.items.filter(it =>
      it?.imagePath && (scope === 'all' || selected.has(it.imagePath))
    );

    if (candidates.length === 0) return { ok: true, changes: [] };

    // Optional snapshot
    try {
      await snapshot?.beforeWrite?.({
        kind: 'shuffle',
        touching: candidates.map(i => i.imagePath)
      });
    } catch (e) {
      console.warn('snapshot failed', e);
    }

    // Shuffle
    const shuffled = shuffle([...candidates]);

    // Determine pad
    const pad = padWidth(shuffled.length);

    // Build plan
    const outDir = payload.outDir || null;
    const changes = [];

    if (outDir) {
      // COPY to outDir with new sequential names
      await fs.mkdir(outDir, { recursive: true });
      for (let i = 0; i < shuffled.length; i++) {
        const src = shuffled[i].imagePath;
        const ext = path.extname(src).toLowerCase();
        const dest = path.join(outDir, `${String(i).padStart(pad, '0')}${ext}`);
        await copyPair(src, dest);
        changes.push({ from: src, to: dest });
      }
    } else {
      // IN‑PLACE RENAME: two‑phase to avoid collisions
      // First, rename every source to a unique temp file (so no name collisions)
      const tempMap = new Map(); // src -> temp
      for (const it of shuffled) {
        const src = it.imagePath;
        const tmp = tmpNameFor(src);
        await fs.rename(src, tmp);
        tempMap.set(src, tmp);

        const srcTag = tagPathFor(src);
        if (await exists(srcTag)) {
          const tmpTag = tmpNameFor(srcTag);
          await fs.rename(srcTag, tmpTag);
          tempMap.set(srcTag, tmpTag);
        }
      }

      // Second, move temp files into final sequential names
      for (let i = 0; i < shuffled.length; i++) {
        const original = shuffled[i].imagePath;
        const tmpImg   = tempMap.get(original);
        const ext      = path.extname(original).toLowerCase();
        const finalImg = path.join(inDir, `${String(i).padStart(pad, '0')}${ext}`);

        await fs.rename(tmpImg, finalImg);
        changes.push({ from: original, to: finalImg });

        const origTag = tagPathFor(original);
        const tmpTag  = tempMap.get(origTag);
        if (tmpTag && await exists(tmpTag)) {
          const finalBase = path.basename(finalImg, path.extname(finalImg));
          const finalTag  = path.join(inDir, `${finalBase}.txt`);
          await fs.rename(tmpTag, finalTag);
        }
      }
    }

    // Optional record
    try {
      await snapshot?.record?.({ kind: 'shuffle', changes });
    } catch (e) {
      // non‑fatal
    }

    return { ok: true, changes };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
};
