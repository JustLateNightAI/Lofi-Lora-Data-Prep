const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const sharp = require('sharp');
const undo = require('./undoManager');
const { pickTargets, portableName, stem, IMAGE_EXTENSIONS } = require('./paths');
const { digest } = require('./transactions');
async function planPairs(payload, destination) {
  const targets = pickTargets(payload.items, payload.scope, payload.selectedPaths);
  if (targets.some(i => i.ambiguous)) throw new Error('Resolve duplicate image/caption stems before changing these files.');
  const plan = [];
  for (const [index, item] of targets.entries()) {
    const image = destination(item, index);
    plan.push({ from: item.imagePath, to: image });
    const tag = path.join(path.dirname(image), `${stem(image)}.txt`);
    if (item.tagPath) plan.push({ from: item.tagPath, to: tag });
    else if (await digest(tag)) throw new Error(`Destination has an unrelated caption: ${tag}`);
  }
  // Reserve the entire image/caption stem, including other image formats and .TXT.
  const sources = new Set(plan.map(p => path.resolve(p.from)));
  const directories = new Map();
  for (const pair of plan.filter(p => IMAGE_EXTENSIONS.has(path.extname(p.to).toLowerCase()))) {
    const directory = path.dirname(pair.to);
    if (!directories.has(directory)) directories.set(directory, await fs.readdir(directory));
    for (const name of directories.get(directory)) {
      const ext = path.extname(name).toLowerCase();
      if (stem(name).toLowerCase() !== stem(pair.to).toLowerCase() || (!IMAGE_EXTENSIONS.has(ext) && ext !== '.txt')) continue;
      if (!payload.outDir && sources.has(path.join(directory, name))) continue;
      throw new Error(`Destination stem already exists: ${path.join(directory, name)}`);
    }
  }
  return plan;
}
async function applyPairs(kind, plan, copy) {
  const changed = plan.filter(p => path.resolve(p.from) !== path.resolve(p.to));
  const sources = new Set(changed.map(p => path.resolve(p.from)));
  const destinations = new Set();
  const changes = new Map();
  for (const p of changed) {
    const target = path.resolve(p.to);
    if (destinations.has(target.toLowerCase())) throw new Error(`Duplicate destination: ${target}`);
    destinations.add(target.toLowerCase());
    const exists = await digest(target);
    if (exists && (copy || !sources.has(target))) throw new Error(`Target exists: ${target}`);
    changes.set(target, { target, source: p.from, replace: !copy && sources.has(target), expected: exists });
  }
  if (!copy) for (const from of sources) if (!changes.has(from)) changes.set(from, { target: from, remove: true, replace: true, expected: await digest(from) });
  return undo.get().execute(kind, [...changes.values()]);
}
async function rename(payload) {
  const base = portableName(payload.baseName);
  const start = payload.start ?? 0, pad = payload.pad ?? 4;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isInteger(pad) || pad < 1 || pad > 12) throw new Error('Invalid numbering.');
  const plan = await planPairs(payload, (item, i) => path.join(payload.outDir || path.dirname(item.imagePath), `${base}_${String(start + i).padStart(pad, '0')}${path.extname(item.imagePath).toLowerCase()}`));
  return applyPairs('Rename', plan, !!payload.outDir);
}
async function shuffle(payload) {
  const items = [...pickTargets(payload.items, payload.scope, payload.selectedPaths)];
  for (let i = items.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  const pad = Math.max(4, String(items.length).length);
  const plan = await planPairs({ ...payload, items, scope: 'all' }, (item, i) => path.join(payload.outDir || payload.inDir, `${String(i).padStart(pad, '0')}${path.extname(item.imagePath).toLowerCase()}`));
  return applyPairs('Shuffle', plan, !!payload.outDir);
}
async function convert(payload) {
  const formats = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };
  const format = formats[payload.targetExt];
  if (!format) throw new Error('Unsupported output format.');
  const items = pickTargets(payload.items, payload.scope, payload.selectedPaths);
  if (items.some(i => i.ambiguous)) throw new Error('Resolve duplicate image/caption stems before converting.');
  const sameFormat = item => formats[path.extname(item.imagePath).toLowerCase()] === format;
  const converting = items.filter(item => payload.outDir || !sameFormat(item));
  const skipped = items.length - converting.length;
  const destination = item => path.join(payload.outDir || path.dirname(item.imagePath), `${stem(item.imagePath)}${payload.targetExt}`);
  await planPairs({ ...payload, items: converting, scope: 'all' }, destination);
  const changes = [];
  for (const item of converting) {
    const target = destination(item);
    changes.push({ target, expected: null, ...(sameFormat(item) ? { source: item.imagePath } : { render: file => sharp(item.imagePath).rotate().toFormat(format, { quality: 92 }).toFile(file) }) });
    if (payload.outDir && path.resolve(payload.outDir) !== path.dirname(item.imagePath)) {
      const tag = path.join(payload.outDir, `${stem(item.imagePath)}.txt`);
      if (item.tagPath) changes.push({ target: tag, source: item.tagPath, expected: null });
      else if (await digest(tag)) throw new Error(`Destination has an unrelated caption: ${tag}`);
    } else changes.push({ target: item.imagePath, replace: true, remove: true, expected: await digest(item.imagePath) });
  }
  return { ...await undo.get().execute('Convert', changes), skipped };
}
async function remove(payload) {
  if (payload.scope !== 'selected') throw new Error('Select the images to delete.');
  const items = pickTargets(payload.items, 'selected', payload.selectedPaths);
  if (items.some(i => i.ambiguous)) throw new Error('Resolve duplicate stems before deleting paired files.');
  const changes = [];
  for (const item of items) for (const target of [item.imagePath, item.tagPath].filter(Boolean)) changes.push({ target, replace: true, remove: true, expected: await digest(target) });
  return undo.get().execute('Delete', changes);
}
module.exports = { rename, shuffle, convert, remove, applyPairs };
