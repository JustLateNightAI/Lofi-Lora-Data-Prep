// renderer.js — updated for shell + partials routing (Home / Auto Tagging)
import { setGridSize, makeTile } from './utils.js';
import { openModal } from './modal.js';
import { captionPromptForImage } from '../actions/captionPrompt.js';

// ------------------------------
// Element refs (assigned in initHomePage)
// ------------------------------
let inputPathEl, outputPathEl;
let pickInputBtn, pickOutputBtn;
let inputGrid, outputGrid, inputWrap, outputWrap;
let inputViewSizeSel, outputViewSizeSel;
let toggleSelectBtn, deleteSelectedBtn;
let convertBtn, convertExtSel;
let renameBtn, renameBase, renamePad, renameStart;
let shuffleBtn, undoBtn;
let tagSearch, runSearchBtn, clearSearchBtn;

// Modal elements live in the shell (always present)
const modalEl = document.getElementById('modal');
const modalCard = modalEl?.querySelector('.modal-card');
const modalCloseBtn = document.getElementById('modal-close');

// ------------------------------
// State
// ------------------------------
let state = {
  inputDir: null,
  outputDir: null,
  inputItems: [],
  outputItems: [],
  selectionMode: false,
  selected: new Set(), // full imagePath strings
  inputView: 'medium',
  outputView: 'medium',
  filterText: '',
  tagCache: new Map(), // imagePath -> lowercased tag text
  cacheBust: 0,
};

const bumpCacheBust = () => { state.cacheBust = Date.now(); };

// JoyCaption UI/runtime state (persists across page swaps)
const joyState = {
  device: 'gpu',
  quant: 'bf16',
  imageSide: 448,
  loaded: false,
  progress: { visible: false, pct: 0, message: 'Idle…' },
  gpu: { name: null, used: 0, total: 0, pct: 0 },
  _gpuPoll: null, // interval id
};

let _vramLogged = false; // debug once

// ------------------------------
// Modal wiring (shell)
// ------------------------------
if (modalEl) {
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) modalEl.classList.add('hidden');
  });
}
if (modalCard) modalCard.addEventListener('click', (e) => e.stopPropagation());
if (modalCloseBtn) modalCloseBtn.addEventListener('click', () => modalEl.classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modalEl.classList.add('hidden'); });

// ------------------------------
// Tag helpers
// ------------------------------
const sidecarPathFor = (imgPath) => imgPath.replace(/\.[^/.]+$/, '.txt');

async function readTagText(imgPath) {
  const tagPath = sidecarPathFor(imgPath);
  try {
    const res = await window.LDP.readText(tagPath);
    if (res?.ok) return (res.text || '').toLowerCase();
  } catch (_) {}
  return '';
}

async function ensureTagsCached(items) {
  const misses = items.filter(it => !state.tagCache.has(it.imagePath));
  if (misses.length === 0) return;
  const texts = await Promise.all(misses.map(it => readTagText(it.imagePath)));
  misses.forEach((it, i) => state.tagCache.set(it.imagePath, texts[i]));
}

function applyFilter() {
  renderGrid('input');
  if (state.outputDir) renderGrid('output');
}

// ---- Prompt templates (built-ins + user-saved) ----
const BUILTIN_PROMPT_TEMPLATES = [
  {
    id: 'sd',
    label: 'Stable Diffusion Prompt',
    content: 'Output a stable diffusion prompt that is indistinguishable from a real stable diffusion prompt.'
  },
  {
    id: 'danbooru',
    label: 'Danbooru tag list',
    content: 'Generate only comma-separated Danbooru tags (lowercase_underscores). Strict order: `artist:`, `copyright:`, `character:`, `meta:`, then general tags. Include counts (1girl), appearance, clothing, accessories, pose, expression, actions, background. Use precise Danbooru syntax. No extra text.'
  },
  {
    id: 'e621',
    label: 'e621 tag list',
    content: 'Write a comma-separated list of e621 tags in alphabetical order for this image. Start with the artist, copyright, character, species, meta, and lore tags (if any), prefixed by \'artist:\', \'copyright:\', \'character:\', \'species:\', \'meta:\', and \'lore:\'. Then all the general tags.'
  }
];


const LS_TEMPLATES = 'ldp_prompt_templates_v1';
const LS_LAST      = 'ldp_prompt_style_last';
const LS_TEMP = 'ldp_temperature';
const LS_TOPP = 'ldp_top_p';
const LS_TEMP_EN  = 'ldp_temperature_enabled';
const LS_TOPP_EN  = 'ldp_top_p_enabled';

let FILE_TEMPLATES = []; // [{ id:'file:Name', label:'Name', content:string }]

function sanitizeTemplateName(raw) {
  return (raw || '')
    .trim()
    .replace(/[:/\\]/g, '-')  // no path-ish chars
    .replace(/\s+/g, ' ')     // collapse spaces
    .slice(0, 64);
}

async function refreshFileTemplates() {
  if (!window.Templates) { FILE_TEMPLATES = []; return; }
  const list = await window.Templates.list();
  const loaded = [];
  for (const t of list) {
    try {
      const { content } = await window.Templates.read(t.label);
      loaded.push({ id: t.id, label: t.label, content });
    } catch (_) {}
  }
  FILE_TEMPLATES = loaded;
}

// new "user templates" = file templates
function getUserTemplates() {
  return FILE_TEMPLATES;
}
// we keep setUserTemplates around for compatibility but it's a no-op now
function setUserTemplates(_arr) {}


function getAllTemplates() {
  return [...BUILTIN_PROMPT_TEMPLATES, ...getUserTemplates()];
}

function renderPromptStyleSelect(selectEl) {
  const all = getAllTemplates();
  selectEl.innerHTML = '';

  // Built-ins
  const ogBuilt = document.createElement('optgroup');
  ogBuilt.label = 'Built-in';
  BUILTIN_PROMPT_TEMPLATES.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    ogBuilt.appendChild(opt);
  });
  selectEl.appendChild(ogBuilt);

  // User templates (if any)
  const users = getUserTemplates();
  if (users.length) {
    const ogUser = document.createElement('optgroup');
    ogUser.label = 'My Templates';
    users.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;            // e.g., "user:My Product Shot"
      opt.textContent = t.label;
      ogUser.appendChild(opt);
    });
    selectEl.appendChild(ogUser);
  }

  // Restore last selection if possible
  const last = localStorage.getItem(LS_LAST);
  if (last && all.some(t => t.id === last)) {
    selectEl.value = last;
  } else {
    selectEl.value = BUILTIN_PROMPT_TEMPLATES[0].id; // default to first built-in
  }
}

function applyTemplateById(id, promptEl) {
  const t = getAllTemplates().find(x => x.id === id);
  if (!t) return;
  promptEl.value = t.content || '';
  localStorage.setItem(LS_LAST, id);
}

function saveCurrentAsTemplate(name, content) {
  const id = `user:${name}`;
  const users = getUserTemplates();
  const existsIdx = users.findIndex(u => u.id === id);

  const entry = { id, label: name, content };
  if (existsIdx >= 0) users[existsIdx] = entry; else users.push(entry);
  setUserTemplates(users);
  return id;
}


// ------------------------------
// JoyCaption hook (kept for later wiring)
// ------------------------------
async function onGeneratePrompt(imagePath) {
  try {
    const text = await captionPromptForImage(imagePath, { device: 'gpu', quant: 'int8', imageSide: 448, maxTokens: 160 });
    console.log('Prompt:', text);
  } catch (e) {
    alert(`JoyCaption failed: ${e.message}`);
  }
}

// ------------------------------
// JoyCaption helpers (scope/selection/folder)
// ------------------------------
function activeInputDir() {
  // Output overrides Input if set
  return state.outputDir || state.inputDir || null;
}

function currentVisibleItems() {
  // respects your filter + tag cache (same logic as renderGrid)
  let items = state.inputItems || [];
  const ft = (state.filterText || '').toLowerCase().trim();
  if (!ft) return items;
  return items.filter((it) => {
    const tags = state.tagCache.get(it.imagePath) || '';
    const nameHit = it.imagePath.toLowerCase().includes(ft);
    const tagHit  = tags.includes(ft);
    return nameHit || tagHit;
  });
}

function itemsForGenerate() {
  // priority: selected → visible → all
  const sel = Array.from(state.selected || []);
  if (sel.length) return (state.inputItems || []).filter(it => sel.includes(it.imagePath));
  return currentVisibleItems();
}

// ------------------------------
// Rendering helpers (use refs set in initHomePage)
// ------------------------------
async function renderGrid(which) {
  const wrap = which === 'input' ? inputWrap : outputWrap;
  if (!wrap) return; // page not mounted yet
  wrap.innerHTML = '';

  let items = which === 'input' ? state.inputItems : state.outputItems;

  const ft = (state.filterText || '').toLowerCase().trim();
  if (ft) {
    await ensureTagsCached(items);
    items = items.filter((it) => {
      const tags = state.tagCache.get(it.imagePath) || '';
      const nameHit = it.imagePath.toLowerCase().includes(ft);
      const tagHit  = tags.includes(ft);
      return nameHit || tagHit;
    });
  }

  items.forEach((it, idx) => {
    const tile = makeTile(it, null);

    const img = tile.querySelector('img');
    if (img && img.src) {
      const base = img.src.split('#')[0].split('?')[0];
      img.src = `${base}?v=${state.cacheBust}`;
    } else if (!img && tile.style?.backgroundImage) {
      const m = tile.style.backgroundImage.match(/url\(["']?(.*?)[)"']?\)/);
      if (m && m[1]) {
        const base = m[1].split('#')[0].split('?')[0];
        tile.style.backgroundImage = `url("${base}?v=${state.cacheBust}")`;
      }
    }

    if (state.selected.has(it.imagePath)) tile.classList.add('selected');

    tile.addEventListener('click', () => {
      if (state.selectionMode) {
        tile.classList.toggle('selected');
        if (tile.classList.contains('selected')) state.selected.add(it.imagePath);
        else state.selected.delete(it.imagePath);
        if (deleteSelectedBtn) deleteSelectedBtn.disabled = state.selected.size === 0;
      } else {
        openModal(which, items, idx);
      }
    }, { passive: true });

    wrap.appendChild(tile);
  });

  const grid = which === 'input' ? inputGrid : outputGrid;
  const view = which === 'input' ? state.inputView : state.outputView;
  if (grid) setGridSize(grid, view);
}

// ------------------------------
// Auto Tag page grid renderer (right pane)
// ------------------------------
async function renderAutoTagGrid() {
  const wrap = document.getElementById('autotag-wrap');
  if (!wrap) return;

  wrap.innerHTML = '';

  // ensure we have items (rescan if needed)
  if (state.inputDir && (!state.inputItems || state.inputItems.length === 0)) {
    try {
      const { items } = await window.LDP.scanFolder(state.inputDir);
      state.inputItems = items;
    } catch (_) {}
  }

  let items = state.inputItems || [];

  const ft = (state.filterText || '').toLowerCase().trim();
  if (ft) {
    await ensureTagsCached(items);
    items = items.filter((it) => {
      const tags = state.tagCache.get(it.imagePath) || '';
      const nameHit = it.imagePath.toLowerCase().includes(ft);
      const tagHit  = tags.includes(ft);
      return nameHit || tagHit;
    });
  }

  items.forEach((it, idx) => {
    const tile = makeTile(it, null);

    const img = tile.querySelector('img');
    if (img && img.src) {
      const base = img.src.split('#')[0].split('?')[0];
      img.src = `${base}?v=${state.cacheBust}`;
    } else if (!img && tile.style?.backgroundImage) {
      const m = tile.style.backgroundImage.match(/url\(["']?(.*?)[)"']?\)/);
      if (m && m[1]) {
        const base = m[1].split('#')[0].split('?')[0];
        tile.style.backgroundImage = `url("${base}?v=${state.cacheBust}")`;
      }
    }

    if (state.selected.has(it.imagePath)) tile.classList.add('selected');

    tile.addEventListener('click', () => {
      if (state.selectionMode) {
        tile.classList.toggle('selected');
        if (tile.classList.contains('selected')) state.selected.add(it.imagePath);
        else state.selected.delete(it.imagePath);
      } else {
        openModal('input', items, idx);
      }
    }, { passive: true });

    wrap.appendChild(tile);
  });
}


// ------------------------------
// Theme (shell: apply saved theme; page: bind radios in initHomePage)
// ------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const THEME_KEY = 'ldp_theme';
  const themeLink = document.getElementById('theme-link');
  const saved = localStorage.getItem(THEME_KEY) || 'cream';
  if (themeLink) themeLink.href = (saved === 'cyber') ? 'cyberLofistyle.css' : 'style.css';
});

function bindThemeRadios(scopeRoot) {
  const THEME_KEY = 'ldp_theme';
  const themeLink = document.getElementById('theme-link');
  const radios = scopeRoot.querySelectorAll('input[name="theme"]');
  const saved = localStorage.getItem(THEME_KEY) || 'cream';
  const checked = scopeRoot.querySelector(`input[name="theme"][value="${saved}"]`);
  if (checked) checked.checked = true;
  radios.forEach(r => r.addEventListener('change', (e) => {
    const mode = e.target.value;
    if (themeLink) themeLink.href = (mode === 'cyber') ? 'cyberLofistyle.css' : 'style.css';
    localStorage.setItem(THEME_KEY, mode);
  }));
}

// ------------------------------
// Folder pick / rescans (use refs assigned by initHomePage)
// ------------------------------
async function pickFolder(kind) {
  const dir = await window.LDP.selectFolder();
  if (!dir) return;

  if (kind === 'input') {
    state.inputDir = dir;
    if (inputPathEl) inputPathEl.textContent = dir;
    const { items } = await window.LDP.scanFolder(dir);
    state.inputItems = items;
    state.tagCache.clear();
    bumpCacheBust();
    await renderGrid('input');
    if (inputGrid) inputGrid.classList.remove('hidden');
  } else {
    state.outputDir = dir;
    if (outputPathEl) outputPathEl.textContent = dir;
    const { items } = await window.LDP.scanFolder(dir);
    state.outputItems = items;
    state.tagCache.clear();
    bumpCacheBust();
    await renderGrid('output');
    if (outputGrid) outputGrid.classList.remove('hidden');
  }
  enableOps(!!state.inputDir);
}

function enableOps(enabled) {
  if (convertBtn) convertBtn.disabled = !enabled;
  if (renameBtn)  renameBtn.disabled  = !enabled;
  if (shuffleBtn) shuffleBtn.disabled = !enabled;
  if (undoBtn)    undoBtn.disabled    = !enabled; // enable once snapshots exist
}

// ------------------------------
// Home page initializer (rehydrates UI from state)
// ------------------------------
async function initHomePage() {
  const root = document; // Home partial is mounted
  

  // assign refs
  inputPathEl  = root.getElementById('input-path');
  outputPathEl = root.getElementById('output-path');
  pickInputBtn  = root.getElementById('pick-input');
  pickOutputBtn = root.getElementById('pick-output');
  inputGrid = root.getElementById('input-grid');
  outputGrid = root.getElementById('output-grid');
  inputWrap = root.getElementById('input-wrap');
  outputWrap = root.getElementById('output-wrap');
  inputViewSizeSel  = root.getElementById('input-view-size');
  outputViewSizeSel = root.getElementById('output-view-size');
  toggleSelectBtn   = root.getElementById('toggle-select');
  deleteSelectedBtn = root.getElementById('delete-selected');
  convertBtn   = root.getElementById('convert-btn');
  convertExtSel = root.getElementById('convert-ext');
  renameBtn   = root.getElementById('rename-btn');
  renameBase  = root.getElementById('rename-base');
  renamePad   = root.getElementById('rename-pad');
  renameStart = root.getElementById('rename-start');
  shuffleBtn  = root.getElementById('shuffle-btn');
  undoBtn     = root.getElementById('undo-btn');
  tagSearch      = root.getElementById('tag-search');
  runSearchBtn   = root.getElementById('run-search');
  clearSearchBtn = root.getElementById('clear-search');

  // theme radios (live in Home)
  const homeAside = root.getElementById('actions');
  if (homeAside) bindThemeRadios(homeAside);

  // initial sizes (so grids get proper class even before render)
  if (inputGrid)  setGridSize(inputGrid, state.inputView);
  if (outputGrid) setGridSize(outputGrid, state.outputView);

  // --- REHYDRATE PATH LABELS + GRIDS FROM STATE ---
  if (state.inputDir) {
    if (inputPathEl) inputPathEl.textContent = state.inputDir;
    if (state.inputItems.length === 0) {
      const { items } = await window.LDP.scanFolder(state.inputDir);
      state.inputItems = items;
    }
    if (inputGrid) inputGrid.classList.remove('hidden');
    await renderGrid('input');
  }
  if (state.outputDir) {
    if (outputPathEl) outputPathEl.textContent = state.outputDir;
    if (state.outputItems.length === 0) {
      const { items } = await window.LDP.scanFolder(state.outputDir);
      state.outputItems = items;
    }
    if (outputGrid) outputGrid.classList.remove('hidden');
    await renderGrid('output');
  }

  // reflect selection mode + delete button
  if (toggleSelectBtn) {
    toggleSelectBtn.textContent = `Selection Mode: ${state.selectionMode ? 'On' : 'Off'}`;
  }
  if (deleteSelectedBtn) {
    deleteSelectedBtn.disabled = !state.selectionMode || state.selected.size === 0;
  }

  // reflect search box value (and current filter)
  if (tagSearch) tagSearch.value = state.filterText || '';

  // enable/disable ops based on having an input dir
  enableOps(!!state.inputDir);

  // ---- bind buttons (exist now) ----
  if (pickInputBtn)  pickInputBtn.onclick  = () => pickFolder('input');
  if (pickOutputBtn) pickOutputBtn.onclick = () => pickFolder('output');

  if (inputViewSizeSel)  inputViewSizeSel.onchange  = () => {
    state.inputView = inputViewSizeSel.value; setGridSize(inputGrid, state.inputView);
  };
  if (outputViewSizeSel) outputViewSizeSel.onchange = () => {
    state.outputView = outputViewSizeSel.value; setGridSize(outputGrid, state.outputView);
  };

  if (toggleSelectBtn) toggleSelectBtn.onclick = () => {
    state.selectionMode = !state.selectionMode;
    toggleSelectBtn.textContent = `Selection Mode: ${state.selectionMode ? 'On' : 'Off'}`;
    if (!state.selectionMode) { state.selected.clear(); if (deleteSelectedBtn) deleteSelectedBtn.disabled = true; }
    else { if (deleteSelectedBtn) deleteSelectedBtn.disabled = state.selected.size === 0; }
    renderGrid('input'); if (state.outputDir) renderGrid('output');
  };

  if (deleteSelectedBtn) deleteSelectedBtn.onclick = async () => {
    if (!state.selectionMode || state.selected.size === 0) return;
    const selectedPaths = Array.from(state.selected);
    const res = await window.LDP.deleteItems({ items: state.inputItems, scope: 'selected', selectedPaths });
    if (!res?.ok) { alert(res?.error || 'Delete failed'); return; }
    if (state.inputDir) { const { items } = await window.LDP.scanFolder(state.inputDir); state.inputItems = items; }
    state.selected.clear(); state.tagCache.clear(); renderGrid('input');
  };

  if (undoBtn) undoBtn.onclick = async () => {
    const res = await window.LDP.undo();
    if (!res?.ok) { alert('Undo failed'); return; }
    if (state.inputDir)  { const { items } = await window.LDP.scanFolder(state.inputDir);  state.inputItems  = items; bumpCacheBust(); await renderGrid('input'); }
    if (state.outputDir) { const { items } = await window.LDP.scanFolder(state.outputDir); state.outputItems = items; await renderGrid('output'); }
    state.tagCache.clear();
  };

  if (shuffleBtn) shuffleBtn.onclick = async () => {
    if (!state.inputDir) return;
    shuffleBtn.disabled = true; const label = shuffleBtn.textContent; shuffleBtn.textContent = 'Shuffling…';
    try {
      const res = await window.LDP.shuffle({
        items: state.inputItems,
        inDir: state.inputDir,
        outDir: state.outputDir || null,
        scope: state.selectionMode ? 'selected' : 'all',
        selectedPaths: Array.from(state.selected),
      });
      if (!res?.ok) { alert(res?.error || 'Shuffle failed'); return; }
      if (state.inputDir)  { const { items } = await window.LDP.scanFolder(state.inputDir);  state.inputItems  = items; }
      if (state.outputDir) { const { items } = await window.LDP.scanFolder(state.outputDir); state.outputItems = items; }
      state.selected.clear(); state.tagCache.clear(); bumpCacheBust(); await renderGrid('input'); if (state.outputDir) await renderGrid('output');
    } finally { shuffleBtn.textContent = label; shuffleBtn.disabled = false; }
  };

  if (renameBtn) renameBtn.onclick = async () => {
    const base = (renameBase?.value || '').trim();
    const pad   = renamePad ? (parseInt(renamePad.value, 10) || 4) : 4;
    const start = renameStart ? (parseInt(renameStart.value, 10) || 0) : 0;
    if (!base) return;
    const scope = state.selectionMode ? 'selected' : 'all';
    const selectedPaths = Array.from(state.selected);
    const payload = { items: state.inputItems, outDir: state.outputDir || null, baseName: base, pad, start, scope, selectedPaths };
    const res = await window.LDP.renameBatch(payload);
    if (!res?.ok) { alert(res?.error || 'Rename failed'); return; }
    if (state.inputDir)  { const { items } = await window.LDP.scanFolder(state.inputDir);  state.inputItems  = items; }
    if (state.outputDir) { const { items } = await window.LDP.scanFolder(state.outputDir); state.outputItems = items; }
    state.selected.clear(); state.tagCache.clear(); bumpCacheBust(); await renderGrid('input'); if (state.outputDir) await renderGrid('output');
  };

  if (convertBtn) convertBtn.onclick = async () => {
    if (!state.inputDir) return;
    const targetExt = convertExtSel.value;
    const outDir    = state.outputDir || null;
    const scope     = state.selectionMode ? 'selected' : 'all';
    const selectedPaths = Array.from(state.selected);
    convertBtn.disabled = true; const label = convertBtn.textContent; convertBtn.textContent = 'Converting…';
    try {
      const res = await window.LDP.convert({ items: state.inputItems, outDir, targetExt, scope, selectedPaths, overwrite: !state.outputDir });
      if (!res?.ok) { alert(res?.error || 'Convert failed'); return; }
      if (state.inputDir)  { const { items } = await window.LDP.scanFolder(state.inputDir);  state.inputItems  = items; }
      if (state.outputDir) { const { items } = await window.LDP.scanFolder(state.outputDir); state.outputItems = items; }
      state.selected.clear(); state.tagCache.clear(); bumpCacheBust(); await renderGrid('input'); if (state.outputDir) await renderGrid('output');
    } finally { convertBtn.textContent = label; convertBtn.disabled = false; }
  };

  if (runSearchBtn) runSearchBtn.onclick = () => { state.filterText = (tagSearch?.value || '').trim(); applyFilter(); };
  if (tagSearch) tagSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.filterText = (tagSearch.value || '').trim(); applyFilter(); } });
  if (clearSearchBtn) clearSearchBtn.onclick = () => { state.filterText = ''; if (tagSearch) tagSearch.value = ''; applyFilter(); };
}


async function refreshJoyStatusFromHealth() {
  try {
    const rsp = await fetch('http://127.0.0.1:5057/health');
    const j = await rsp.json();
    joyState.loaded = !!j.loaded;
    // _loaded_conf looks like ["gpu","int8"] in our server
    if (Array.isArray(j.config)) {
      if (j.config[0]) joyState.device = j.config[0];
      if (j.config[1]) joyState.quant  = j.config[1];
    }
  } catch (_) { /* keep previous joyState */ }
}

function paintAutoTagUI(root) {
  const devGpu  = root.querySelector('input[name="jc-device"][value="gpu"]');
  const devCpu  = root.querySelector('input[name="jc-device"][value="cpu"]');
  const quant   = root.getElementById('jc-quant');
  const imgSide = root.getElementById('jc-image-side');
  const genBtn  = root.getElementById('jc-generate');
  const progBox = root.getElementById('jc-progress');
  const progBar = progBox?.querySelector('.bar');
  const progMsg = root.getElementById('jc-progress-status');
  const gpuSel  = root.getElementById('jc-gpu-device'); // optional (if present)
  const unloadBtn = root.getElementById('jc-unload');
  const loadBtn   = root.getElementById('jc-install');

  // device radios reflect 'gpu'/'cpu'
  if (devGpu) devGpu.checked = (joyState.device === 'gpu');
  if (devCpu) devCpu.checked = (joyState.device === 'cpu');

  // selects
  if (quant) {
    quant.disabled = (joyState.device === 'cpu');
    quant.value = joyState.quant;
  }
  if (imgSide) imgSide.value = String(joyState.imageSide);

  // progress box
  if (progBox) {
    progBox.classList.toggle('hidden', !joyState.progress.visible);
    if (progBar) progBar.style.width = `${joyState.progress.pct}%`;
    if (progMsg) progMsg.textContent = joyState.progress.message;
  }

  // buttons enabled state
  const haveImages = (state.inputItems && state.inputItems.length) || false;
  if (genBtn)   genBtn.disabled   = !joyState.loaded || !haveImages;
  if (unloadBtn)unloadBtn.disabled= !joyState.loaded;
  if (loadBtn)  loadBtn.disabled  = !!joyState.loaded;

  // gpu dropdown lock while loaded
  if (gpuSel) gpuSel.disabled = joyState.loaded || joyState.device === 'cpu';
}



// ------------------------------
// Auto Tagging page initializer (kept minimal; server progress later)
// ------------------------------
async function initAutoTagPage() {
  const ROOT = document;

  // stop old poller, start fresh
  if (joyState._gpuPoll) { clearInterval(joyState._gpuPoll); joyState._gpuPoll = null; }
  await pollVramOnce(ROOT);
  joyState._gpuPoll = setInterval(() => { pollVramOnce(ROOT); }, 2000);

  // last-known paint + health refresh
  paintAutoTagUI(ROOT);
  await refreshJoyStatusFromHealth();
  paintAutoTagUI(ROOT);

  // refs
  const installBtn = ROOT.getElementById('jc-install');
  const unloadBtn  = ROOT.getElementById('jc-unload');
  const genBtn     = ROOT.getElementById('jc-generate');
  const quantSel   = ROOT.getElementById('jc-quant');
  const imgSideSel = ROOT.getElementById('jc-image-side');
  const gpuSel     = ROOT.getElementById('jc-gpu-device');
  const pathLbl    = ROOT.getElementById('autotag-input-path');
  const pickBtn    = ROOT.getElementById('autotag-change-input');
  const promptEl   = ROOT.getElementById('jc-prompt');
  // NEW: style dropdown + save button
  const styleSel   = ROOT.getElementById('jc-prompt-style');
  const saveBtn    = ROOT.getElementById('jc-save-template');
  const capLenSel  = ROOT.getElementById('jc-caption-length');
  
  // Captioning progress (separate bar)
  const capBox  = document.getElementById('jc-cap-progress');
  const capBar  = document.getElementById('jc-cap-bar');
  const capText = document.getElementById('jc-cap-status');
  const capCnt  = document.getElementById('jc-cap-count');

  // === Max tokens UI (local to init; predictOne will look up fresh) ===
  const maxEnable = ROOT.getElementById('jc-max-tokens-enable');
  const maxRange  = ROOT.getElementById('jc-max-tokens');
  const maxLive   = ROOT.getElementById('jc-max-tokens-live');

  // init
  if (maxRange && maxLive) maxLive.textContent = String(maxRange.value);
  if (maxEnable && maxRange) maxRange.disabled = !maxEnable.checked;

  // listeners
  maxEnable?.addEventListener('change', () => {
    if (maxRange) maxRange.disabled = !maxEnable.checked;
  });
  maxRange?.addEventListener('input', () => {
    if (maxLive) maxLive.textContent = String(maxRange.value);
  });

// ------- Temperature / Top-p controls -------
const tempEn   = document.getElementById('jc-temperature-enable');
const tempEl   = document.getElementById('jc-temperature');
const tempLive = document.getElementById('jc-temperature-live');
const tempWrap = tempEl?.closest('.control-right');

const topEn    = document.getElementById('jc-top-p-enable');
const topEl    = document.getElementById('jc-top-p');
const topLive  = document.getElementById('jc-top-p-live');
const topWrap  = topEl?.closest('.control-right');

// Restore values
const savedTemp   = localStorage.getItem(LS_TEMP);
const savedTopP   = localStorage.getItem(LS_TOPP);
const savedTempEn = localStorage.getItem(LS_TEMP_EN);
const savedTopEn  = localStorage.getItem(LS_TOPP_EN);

if (savedTemp !== null && tempEl) tempEl.value = savedTemp;
if (savedTopP !== null && topEl) topEl.value = savedTopP;

if (tempEn) tempEn.checked = savedTempEn === null ? true : savedTempEn === '1';
if (topEn)  topEn.checked  = savedTopEn  === null ? true : savedTopEn  === '1';

// Apply live labels
if (tempLive && tempEl) tempLive.textContent = Number(tempEl.value).toFixed(2);
if (topLive  && topEl)  topLive.textContent  = Number(topEl.value).toFixed(2);

// Helpers to flip UI
function applyTempEnabled() {
  const on = !!tempEn?.checked;
  localStorage.setItem(LS_TEMP_EN, on ? '1' : '0');
  if (tempEl)   tempEl.disabled = !on;
  if (tempWrap) tempWrap.classList.toggle('is-off', !on);
}
function applyTopEnabled() {
  const on = !!topEn?.checked;
  localStorage.setItem(LS_TOPP_EN, on ? '1' : '0');
  if (topEl)   topEl.disabled = !on;
  if (topWrap) topWrap.classList.toggle('is-off', !on);
}

// Initial apply + listeners
applyTempEnabled();
applyTopEnabled();

tempEn?.addEventListener('change', applyTempEnabled);
topEn?.addEventListener('change', applyTopEnabled);

tempEl?.addEventListener('input', () => {
  if (tempLive) tempLive.textContent = Number(tempEl.value).toFixed(2);
  localStorage.setItem(LS_TEMP, tempEl.value);
});
topEl?.addEventListener('input', () => {
  if (topLive) topLive.textContent = Number(topEl.value).toFixed(2);
  localStorage.setItem(LS_TOPP, topEl.value);
});




// Selection mode toggle (reuse global state/logic)
const toggleSelectBtn   = ROOT.getElementById('toggle-select');
const deleteSelectedBtn = ROOT.getElementById('delete-selected'); // may not exist on this page; it's ok if null

if (toggleSelectBtn) {
  // initial label
  toggleSelectBtn.textContent = `Selection Mode: ${state.selectionMode ? 'On' : 'Off'}`;

  // click to toggle; update both pages' buttons if present
  toggleSelectBtn.onclick = () => {
    state.selectionMode = !state.selectionMode;

    // sync label on ALL toggle buttons (Home + Tagging) that share the same id
    document.querySelectorAll('#toggle-select').forEach(btn => {
      btn.textContent = `Selection Mode: ${state.selectionMode ? 'On' : 'Off'}`;
    });

    // when turning off, clear selection; keep delete button state in sync if present
    if (!state.selectionMode) {
      state.selected?.clear?.();
      if (deleteSelectedBtn) deleteSelectedBtn.disabled = true;
    } else {
      if (deleteSelectedBtn) deleteSelectedBtn.disabled = (state.selected?.size || 0) === 0;
    }

    // repaint both grids so selection styling matches current mode
    renderGrid?.('input');
    if (state.outputDir) renderGrid?.('output');
    renderAutoTagGrid?.();
  };
}

  // input path label (Output overrides Input)
  const showPath = () => {
    const dirNow = state.outputDir || state.inputDir || null;
    if (pathLbl) pathLbl.textContent = dirNow || '(from Home)';
  };
  showPath();

  // ensure the right-pane grid reflects current items
  await renderAutoTagGrid();

  // populate GPU selector once
  async function populateGpuSelector() {
    if (!gpuSel) return;
    gpuSel.innerHTML = '';
    try {
      const r = await fetch('http://127.0.0.1:5057/gpu');
      const j = await r.json();
      (j.gpus || []).forEach((g, i) => {
        const opt = document.createElement('option');
        opt.value = `cuda:${g.index ?? i}`;
        const freeGiB = ((g.free_bytes||0)/(1024**3)).toFixed(1);
        const totGiB  = ((g.total_bytes||0)/(1024**3)).toFixed(1);
        opt.textContent = `${g.name} (${freeGiB}/${totGiB} GB free)`;
        gpuSel.appendChild(opt);
      });
      if (!gpuSel.value && gpuSel.options.length) gpuSel.selectedIndex = 0;
    } catch {
      const opt = document.createElement('option');
      opt.value = 'cuda:0';
      opt.textContent = 'GPU';
      gpuSel.appendChild(opt);
    }
  }
  await populateGpuSelector();

  // controls sync
  ROOT.addEventListener('change', (e) => {
    if (e.target?.name === 'jc-device') {
      joyState.device = (e.target.value === 'gpu') ? 'gpu' : 'cpu';
      paintAutoTagUI(ROOT);
    }
    if (e.target === quantSel)   joyState.quant      = quantSel.value;
    if (e.target === imgSideSel) joyState.imageSide  = parseInt(imgSideSel.value, 10) || joyState.imageSide;
    if (e.target === gpuSel)     pollVramOnce(ROOT); // reflect different device immediately
  });

  // folder pick mirrors Home and re-renders the right grid
  if (pickBtn) {
    pickBtn.onclick = async () => {
      const dir = await window.LDP.selectFolder(); if (!dir) return;
      state.inputDir = dir;
      const { items } = await window.LDP.scanFolder(state.inputDir);
      state.inputItems = items; state.tagCache.clear(); bumpCacheBust();
      showPath();
      await renderAutoTagGrid();
      paintAutoTagUI(ROOT);
    };
  }

  // load/unload
  async function callLoad({ device, quant }) {
    const fd = new FormData();
    fd.append('device', device);                 // 'gpu' or 'cpu'
    if (device === 'gpu') fd.append('quant', quant);
    const rsp = await fetch('http://127.0.0.1:5057/load', { method: 'POST', body: fd });
    const json = await rsp.json().catch(() => ({}));
    if (!rsp.ok || json.status !== 'ok') throw new Error(json.message || 'Sidecar load failed');
    return json;
  }
  async function callUnload() {
    try {
      const rsp = await fetch('http://127.0.0.1:5057/unload', { method: 'POST' });
      if (!rsp.ok) console.warn('unload non-OK:', rsp.status);
    } catch (e) {
      console.warn('unload error (best-effort):', e);
    }
  }

  installBtn?.addEventListener('click', async () => {
    try {
      joyState.progress.visible = true; joyState.progress.pct = 15; joyState.progress.message = 'Loading model…';
      paintAutoTagUI(ROOT);
      await callLoad({ device: joyState.device, quant: joyState.quant });
      joyState.loaded = true;
      joyState.progress.pct = 100; joyState.progress.message = 'Model loaded.';
    } catch (err) {
      joyState.loaded = false;
      joyState.progress.pct = 0; joyState.progress.message = String(err.message || err);
    } finally {
      paintAutoTagUI(ROOT);
    }
  });

  unloadBtn?.addEventListener('click', async () => {
    if (!joyState.loaded) return;
    joyState.loaded = false;
    paintAutoTagUI(ROOT);
    await callUnload();
    await pollVramOnce(ROOT);
    document.getElementById("jc-progress")?.classList.add("hidden");
  });

// Generate (selected → visible → all) + refresh folder so tags appear
genBtn?.addEventListener('click', async () => {
  if (!joyState.loaded) return;
  const todo = itemsForGenerate();
  if (!todo.length) { alert('No images to process.'); return; }

genBtn.disabled = true;
try {
const promptText = (promptEl?.value || '').trim();
const total = todo.length;

// show/reset captioning bar
capBox?.classList.remove('hidden');
if (capBar) capBar.style.width = '0%';
if (capText) capText.textContent = 'Starting…';
if (capCnt) capCnt.textContent = `0/${total}`;

for (let i = 0; i < total; i++) {
  const item = todo[i];

  // status text + count
  if (capText) capText.textContent = `Captioning — ${item.name || item.imagePath.split('/').pop()}`;
  if (capCnt)  capCnt.textContent  = `${i + 1}/${total}`;

  await predictOne(item.imagePath, promptText);

  // advance bar
  const pct = Math.round(((i + 1) / total) * 100);
  if (capBar) capBar.style.width = `${pct}%`;
}

// (your existing folder refresh code stays here)

if (capText) capText.textContent = 'Done ✔';
if (capCnt)  capCnt.textContent  = `${total}/${total}`;
// Optionally auto-hide after a moment:
// setTimeout(() => capBox?.classList.add('hidden'), 1200);

  // 🔄 Refresh folder so new .txt files show
  const dir = state.outputDir || state.inputDir || null;
  if (dir && window.LDP?.scanFolder) {
    const { items } = await window.LDP.scanFolder(dir);
    state.inputItems = items;
    state.tagCache?.clear?.();
    bumpCacheBust?.();
    await renderAutoTagGrid();
    paintAutoTagUI(document);
  }

  if (progTxt) progTxt.textContent = `Done ✔ (${total}/${total})`;
  alert(`Generated tags for ${total} image(s).`);
} catch (e) {
  if (progTxt) progTxt.textContent = `Failed: ${e?.message || e}`;
  alert(`Generate failed: ${e?.message || e}`);
} finally {
  genBtn.disabled = false;
  // If you prefer to auto-hide after finishes, uncomment:
  // setTimeout(() => progBox?.classList.add('hidden'), 1200);
  if (capText) capText.textContent = `Failed: ${e?.message || e}`;

}
});


  // ===== Prompt Style: populate, apply on change, save templates =====
  if (styleSel && promptEl) {
    await refreshFileTemplates?.();                 // ok if undefined in LS mode
    renderPromptStyleSelect(styleSel);

    if (!promptEl.value.trim()) {
      applyTemplateById(styleSel.value, promptEl);
    }
    styleSel.addEventListener('change', () => {
      applyTemplateById(styleSel.value, promptEl);
    });
  }

  // NEW inline-name widgets for "Save as template…"
  const nameInput  = ROOT.getElementById('jc-template-name');
  const confirmBtn = ROOT.getElementById('jc-template-confirm');

  if (saveBtn && promptEl && styleSel) {
    // 1) Reveal the inline input + confirm button
    saveBtn.addEventListener('click', () => {
      if (!nameInput || !confirmBtn) {
        console.warn('[Templates] Missing inline name/confirm elements.');
        return;
      }
      nameInput.style.display = 'inline-block';
      confirmBtn.style.display = 'inline-block';
      nameInput.focus();
    });

    // 2) Confirm save → write (file or LS, depending on your helpers)
    confirmBtn?.addEventListener('click', async () => {
      if (!nameInput) return;
      const raw = (nameInput.value || '').trim();
      if (!raw) return;

      // sanitize name
      const safeName = (raw.replace(/[:/\\]/g, '-').replace(/\s+/g, ' ')).slice(0,64);

      // file-based path:
      if (window.Templates?.save) {
        await window.Templates.save({ label: safeName, content: promptEl.value });
        await refreshFileTemplates?.();
        renderPromptStyleSelect(styleSel);
        styleSel.value = `file:${safeName}`;
        localStorage.setItem(LS_LAST, `file:${safeName}`);
      } else {
        // fallback: localStorage mode
        const newId = saveCurrentAsTemplate(safeName, promptEl.value);
        renderPromptStyleSelect(styleSel);
        styleSel.value = newId;
        localStorage.setItem(LS_LAST, newId);
      }

      // reset + hide
      nameInput.value = '';
      nameInput.style.display = 'none';
      if (confirmBtn) confirmBtn.style.display = 'none';
    });
  }
} // <-- make sure THIS brace exists (closes initAutoTagPage)


function applyCaptionLengthHint(basePrompt, capLenValue) {
  const p = (basePrompt || '').trim();
  const v = String(capLenValue || '').toLowerCase();
  if (!v || v === 'any') return p; // no change

  // Keep hints minimal and unambiguous to avoid rambling
  if (v === 'short')  return p ? `${p}\n\nWrite one short, concise description. Do not repeat.` 
                               : `Write one short, concise description. Do not repeat.`;
  if (v === 'medium') return p ? `${p}\n\nWrite a medium-length detailed description. Avoid repetition.` 
                               : `Write a medium-length detailed description. Avoid repetition.`;
  if (v === 'long')   return p ? `${p}\n\nWrite a long, detailed description. Avoid repetition.` 
                               : `Write a long, detailed description. Avoid repetition.`;

  return p;
}




async function predictOne(imagePath, promptText='') {
  const body = new FormData();
  // Switch to path-based
  body.append('image_path', imagePath);
  // Match server param names
  body.append('device', joyState.device === 'gpu' ? 'gpu' : 'cpu');
  body.append('quant', joyState.quant);
  body.append('image_side', String(joyState.imageSide));
  // Only send max_tokens if user enabled the slider; otherwise let backend default (512)
const _en = document.getElementById('jc-max-tokens-enable');
const _rg = document.getElementById('jc-max-tokens');
if (_en?.checked && _rg) {
  const v = Math.max(64, Math.min(4096, _rg.valueAsNumber || 512));
  body.append('max_tokens', String(v));
}
  body.append('write_txt', 'true');
  
  // Sampling controls (optional; backend will ignore until supported)
const tempEl = document.getElementById('jc-temperature');
const topPEl = document.getElementById('jc-top-p');
if (tempEl) body.append('temperature', String(Number(tempEl.value)));
if (topPEl) body.append('top_p', String(Number(topPEl.value)));

  // If user did NOT enable custom tokens, nudge cap for 'short' and 'medium' presets
if (!document.getElementById('jc-max-tokens-enable')?.checked) {
  const v = (document.getElementById('jc-caption-length')?.value || 'any').toLowerCase();
  if (v === 'short') {
    body.append('max_tokens', String(160)); // ~40–55 words
  } else if (v === 'medium') {
    body.append('max_tokens', String(320)); // ~80–120 words
  } // 'long' and 'any' fall back to backend default (512)
}

// Apply caption-length hint to prompt
const capSel = document.getElementById('jc-caption-length');
const promptShaped = applyCaptionLengthHint(promptText, capSel?.value || 'any');
if (promptShaped) body.append('prompt', promptShaped);

  const r = await fetch('http://127.0.0.1:5057/predict', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.error || j?.message || `HTTP ${r.status}`);
  return j; // { ok:true, text:"...", txt_path:"/path/to/file.txt" }
}



function paintVramBox(root) {
  const nameEl = root.getElementById('vram-name');
  const numsEl = root.getElementById('vram-nums');
  const barEl  = root.getElementById('vram-bar');
  const statEl = root.getElementById('vram-status');
  if (!nameEl || !numsEl || !barEl || !statEl) return;

  if (joyState.gpu.total > 0) {
    const usedGB  = (joyState.gpu.used  / (1024**3)).toFixed(1);
    const totalGB = (joyState.gpu.total / (1024**3)).toFixed(1);
    nameEl.textContent = `GPU: ${joyState.gpu.name || 'Unknown'}`;
    numsEl.textContent = `${usedGB} GB / ${totalGB} GB`;
    barEl.style.width = `${joyState.gpu.pct}%`;
    statEl.textContent = `${Math.round(joyState.gpu.pct)}% used`;
  } else {
    nameEl.textContent = 'GPU: (not detected)';
    numsEl.textContent = '— / —';
    barEl.style.width = '0%';
    statEl.textContent = 'No GPU info';
  }
}

async function pollVramOnce(root) {
  try {
    const rsp = await fetch('http://127.0.0.1:5057/gpu');
    const j = await rsp.json();
    if (!_vramLogged) { console.log('GPU /gpu response:', j); _vramLogged = true; }

    // pick the selected GPU index if dropdown exists
    const gpuSel = root.getElementById('jc-gpu-device');
    let idx = 0;
    if (gpuSel && gpuSel.value && gpuSel.value.startsWith('cuda:')) {
      const n = parseInt(gpuSel.value.split(':')[1], 10);
      if (!Number.isNaN(n)) idx = n;
    }

    if (j.gpus && j.gpus.length > 0) {
      const g = j.gpus[Math.min(idx, j.gpus.length - 1)];
      joyState.gpu.total = g.total_bytes || 0;
      joyState.gpu.used  = g.used_bytes  || 0;
      joyState.gpu.name  = g.name || null;
      joyState.gpu.pct   = joyState.gpu.total > 0
        ? (joyState.gpu.used / joyState.gpu.total) * 100
        : 0;
    } else {
      joyState.gpu = { name: null, used: 0, total: 0, pct: 0 };
    }
  } catch (e) {
    if (!_vramLogged) { console.warn('GPU /gpu fetch failed:', e); _vramLogged = true; }
    joyState.gpu = { name: null, used: 0, total: 0, pct: 0 };
  }

  // paint with GiB (matches your sidebar bar math)
  const nameEl = root.getElementById('vram-name');
  const numsEl = root.getElementById('vram-nums');
  const barEl  = root.getElementById('vram-bar');
  const statEl = root.getElementById('vram-status');
  if (nameEl && numsEl && barEl && statEl) {
    if (joyState.gpu.total > 0) {
      const usedGiB  = (joyState.gpu.used  / (1024**3)).toFixed(1);
      const totalGiB = (joyState.gpu.total / (1024**3)).toFixed(1);
      nameEl.textContent = `GPU: ${joyState.gpu.name || 'Unknown'}`;
      numsEl.textContent = `${usedGiB} GB / ${totalGiB} GB`;
      barEl.style.width = `${joyState.gpu.pct}%`;
      statEl.textContent = `${Math.round(joyState.gpu.pct)}% used`;
    } else {
      nameEl.textContent = 'GPU: (not detected)';
      numsEl.textContent = '— / —';
      barEl.style.width = '0%';
      statEl.textContent = 'No GPU info';
    }
  }
}





// ------------------------------
// Simple router
// ------------------------------
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$= (s, r=document) => Array.from(r.querySelectorAll(s));
  const PAGES_BASE = './pages/';
  const ROOT = $('#app');

  async function loadPage(name){
    const res = await fetch(`${PAGES_BASE}${name}.html`);
    const html = await res.text();
    ROOT.innerHTML = html;
    $$('#top-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
	if (name === 'home') await initHomePage();
    if (name === 'autotag') await initAutoTagPage();
  }

  document.addEventListener('click', (e)=>{
    const b = e.target.closest('#top-tabs .tab'); if (!b) return; const name = b.dataset.tab; if (name) loadPage(name);
  });

  loadPage('home');
})();
