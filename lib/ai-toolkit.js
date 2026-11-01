const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const scan = require('../actions/loadFolder');
const { portableName, stem } = require('../actions/paths');
const { digest } = require('../actions/transactions');

async function validateToolkitDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value.trim())) throw new Error('Choose the full path to your main AI Toolkit folder.');
  const directory = await fs.realpath(value.trim()).catch(() => { throw new Error('Cannot access the AI Toolkit folder. Choose an existing installation and check its permissions.'); });
  const [runner, toolkit] = await Promise.all([
    fs.stat(path.join(directory, 'run.py')).catch(() => null),
    fs.stat(path.join(directory, 'toolkit')).catch(() => null)
  ]);
  if (!runner?.isFile() || !toolkit?.isDirectory()) throw new Error('Choose the main AI Toolkit folder containing run.py and the toolkit directory.');
  return directory;
}

async function exportDataset({ toolkitDir, sourceDir, name, selectedPaths }, history) {
  const root = await validateToolkitDirectory(toolkitDir);
  if (root !== toolkitDir) throw new Error('The AI Toolkit folder moved or changed. Choose it again in export settings.');
  portableName(name);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Use letters, numbers, underscores, or hyphens for the dataset name.');
  if (!Array.isArray(selectedPaths) || !selectedPaths.length || selectedPaths.some(p => typeof p !== 'string')) throw new Error('Select at least one image to export.');
  const selected = new Set(selectedPaths);
  const items = (await scan(sourceDir)).items.filter(item => selected.has(item.imagePath));
  if (items.length !== selected.size) throw new Error('Some selected images are missing or unsupported. Refresh the folder and try again.');
  if (items.some(item => item.ambiguous)) throw new Error('Resolve duplicate image/caption stems before exporting.');
  if (items.some(item => item.filename.startsWith('.'))) throw new Error('AI Toolkit ignores hidden images. Rename filenames starting with a dot before exporting.');

  const datasets = path.join(root, 'datasets');
  await fs.mkdir(datasets).catch(e => { if (e.code !== 'EEXIST') throw e; });
  if (!(await fs.lstat(datasets)).isDirectory() || await fs.realpath(datasets) !== datasets) throw new Error('AI Toolkit datasets must be a regular directory inside the selected installation, not a symbolic link.');
  if ((await fs.readdir(datasets)).some(entry => entry.toLowerCase() === name.toLowerCase())) throw new Error('A dataset with this name already exists in AI Toolkit. Choose a new dataset name.');
  const destination = path.join(datasets, name);
  const changes = [];
  let captions = 0, converted = 0;
  for (const item of items) {
    const ext = path.extname(item.filename).toLowerCase();
    const webp = ext === '.webp';
    const files = [{ source: item.imagePath, filename: `${stem(item.filename)}${webp ? '.png' : ext}`, webp }];
    if (item.tagPath) { files.push({ source: item.tagPath, filename: `${stem(item.filename)}.txt`, webp: false }); captions++; }
    if (webp) converted++;
    for (const file of files) {
      const expected = await digest(file.source);
      if (expected === null) throw new Error('A source file disappeared. Refresh the folder and try again.');
      changes.push({ target: path.join(destination, file.filename), expected: null, render: async staged => {
        if (await digest(file.source) !== expected) throw new Error('A source file changed during export. Refresh and try again.');
        // Buffer input keeps the image decoder from retaining a Windows file lock.
        if (file.webp) await sharp(await fs.readFile(file.source), { limitInputPixels: 100000000 }).rotate().png().toFile(staged);
        else await fs.copyFile(file.source, staged, constants.COPYFILE_EXCL);
        if (await digest(file.source) !== expected || (!file.webp && await digest(staged) !== expected)) throw new Error('A source file changed during export. Refresh and try again.');
      } });
    }
  }
  // Reserve a new directory without merging into or replacing an existing dataset.
  await fs.mkdir(destination);
  try {
    await history.execute('Export to AI Toolkit', changes);
  } catch (error) {
    // Rollback owns individual files. Only remove the directory if it is empty;
    // preserve any external edits or recovery conflicts for the user to inspect.
    await fs.rmdir(destination).catch(() => {});
    throw error;
  }
  return { destination, images: items.length, captions, missingCaptions: items.length - captions, converted };
}

module.exports = { validateToolkitDirectory, exportDataset };
