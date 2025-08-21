// actions/convertFormat.js
// payload: { items:[{imagePath, tagPath?}], outDir:string|null, targetExt: ".png"|".jpg"|".webp"|".jpeg",
//            scope?:"all"|"selected", selectedPaths?:string[], quality?:number, overwrite?:boolean }
const fs    = require('fs/promises');
const path  = require('path');
const sharp = require('sharp');

let snapshot;
try { snapshot = require('./snapshot'); } catch { snapshot = null; }

const VALID = new Set(['.png', '.jpg', '.jpeg', '.webp']);

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

function fmt(ext) {
  ext = ext.toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.png')  return 'png';
  if (ext === '.webp') return 'webp';
  throw new Error(`Unsupported ${ext}`);
}

async function uniquify(p) {
  if (!(await exists(p))) return p;
  const dir  = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  const ext  = path.extname(p);
  let i = 1;
  for (;;) {
    const cand = path.join(dir, `${base}_${i}${ext}`);
    if (!(await exists(cand))) return cand;
    i++;
  }
}

async function convertOne(srcPath, outDir, targetExt, { quality, overwrite }) {
  const srcExt  = path.extname(srcPath).toLowerCase();
  const srcDir  = path.dirname(srcPath);
  const base    = path.basename(srcPath, srcExt);
  const destDir = outDir || srcDir;

  await fs.mkdir(destDir, { recursive: true });

  let destPath = path.join(destDir, `${base}${targetExt}`);

  const sameDirectory    = path.resolve(destDir) === path.resolve(srcDir);
  const samePlaceSameExt = (sameDirectory && srcExt === targetExt);

  // If we're not literally overwriting the same file, and overwrite=false, uniquify
  if (!samePlaceSameExt && !overwrite) {
    destPath = await uniquify(destPath);
  }

  // Sharp pipeline
  let p = sharp(srcPath);
  const f = fmt(targetExt);
  if (f === 'jpeg') p = p.jpeg({ quality: quality ?? 92 });
  if (f === 'webp') p = p.webp({ quality: quality ?? 92 });
  if (f === 'png')  p = p.png({
    quality: quality ?? 100,           // sharp supports quality for PNG (palette)
    compressionLevel: 9                // max compression; tweak if desired
  });

  await p.toFile(destPath);

  // --- Tag handling ---
  // In-place: do NOT copy tag (keep the single .txt).
  // Output dir: copy exactly one tag matching the FINAL image basename (handles _1 uniquify).
  try {
    const srcTag = path.join(srcDir, `${base}.txt`);
    if (await exists(srcTag)) {
      if (!sameDirectory) {
        const destBase = path.basename(destPath, path.extname(destPath));
        const destTag  = path.join(destDir, `${destBase}.txt`);
        await fs.copyFile(srcTag, destTag); // overwrite to avoid duplicates
      }
    }
  } catch (e) {
    console.warn('Tag sync failed:', e);
  }

  // In-place, different extension, and overwrite => remove original
  if (sameDirectory && srcExt !== targetExt && overwrite) {
    try { await fs.unlink(srcPath); } catch {}
  }

  return { from: srcPath, to: destPath };
}

module.exports = async function convertFormat(payload) {
  try {
    if (!payload || !Array.isArray(payload.items)) {
      return { ok: false, error: 'items[] required' };
    }

    const targetExt = (payload.targetExt || '').toLowerCase();
    if (!VALID.has(targetExt)) {
      return { ok: false, error: 'targetExt must be .png, .jpg, .jpeg, or .webp' };
    }

    const scope = payload.scope || 'all';
    const sel   = new Set(payload.selectedPaths || []);
    const items = payload.items.filter(it =>
      it?.imagePath && (scope === 'all' || sel.has(it.imagePath))
    );

    if (items.length === 0) return { ok: true, changes: [] };

    // Optional snapshot hook
    try {
      await snapshot?.beforeWrite?.({ kind: 'convert', touching: items.map(i => i.imagePath) });
    } catch (e) {
      console.warn('snapshot failed', e);
    }

    const opts   = { quality: payload.quality, overwrite: !!payload.overwrite };
    const outDir = payload.outDir || null;

    const changes = [];
    for (const it of items) {
      try {
        const ch = await convertOne(it.imagePath, outDir, targetExt, opts);
        changes.push(ch);
      } catch (e) {
        console.warn('Convert failed', it.imagePath, e);
      }
    }

    return { ok: true, changes };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
};
