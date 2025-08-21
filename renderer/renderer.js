// renderer.js
import { setGridSize, makeTile } from './utils.js';
import { openModal } from './modal.js';

const inputPathEl  = document.getElementById('input-path');
const outputPathEl = document.getElementById('output-path');

const pickInputBtn  = document.getElementById('pick-input');
const pickOutputBtn = document.getElementById('pick-output');

const inputGrid = document.getElementById('input-grid');
const outputGrid = document.getElementById('output-grid');
const inputWrap = document.getElementById('input-wrap');
const outputWrap = document.getElementById('output-wrap');

const inputViewSizeSel  = document.getElementById('input-view-size');
const outputViewSizeSel = document.getElementById('output-view-size');

const toggleSelectBtn   = document.getElementById('toggle-select');
const deleteSelectedBtn = document.getElementById('delete-selected');

const convertBtn   = document.getElementById('convert-btn');
const convertExtSel = document.getElementById('convert-ext');

const renameBtn   = document.getElementById('rename-btn');
const renameBase  = document.getElementById('rename-base');
const renamePad   = document.getElementById('rename-pad');    // may be null
const renameStart = document.getElementById('rename-start');  // may be null

const shuffleBtn = document.getElementById('shuffle-btn');
const undoBtn    = document.getElementById('undo-btn');

// --- Tag search UI (IDs match index.html) ---
const tagSearch      = document.getElementById('tag-search');
const runSearchBtn   = document.getElementById('run-search');
const clearSearchBtn = document.getElementById('clear-search');

// Modal elements
const modalEl   = document.getElementById('modal');
const modalCard = modalEl.querySelector('.modal-card');
const modalCloseBtn = document.getElementById('modal-close');

// --- State ---
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

const bumpCacheBust = () => {   // ← add this helper right under state
  state.cacheBust = Date.now(); // unique token each refresh
};

// --- Enable/disable ops ---
function enableOps(enabled) {
  convertBtn.disabled = !enabled;
  renameBtn.disabled  = !enabled;
  shuffleBtn.disabled = !enabled;
  undoBtn.disabled    = false; // enable once snapshots exist
}


// Close when clicking the dark backdrop
modalEl.addEventListener('click', (e) => {
  if (e.target === modalEl) {
    modalEl.classList.add('hidden');
  }
});

// (Optional safety) prevent clicks inside the card from closing
modalCard.addEventListener('click', (e) => e.stopPropagation());

// Close button already exists in your HTML
if (modalCloseBtn) {
  modalCloseBtn.addEventListener('click', () => modalEl.classList.add('hidden'));
}

// Keep Esc close too (if not already wired)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') modalEl.classList.add('hidden');
});


// ---------- Tag helpers ----------
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
  // re-render both panes with current filter
  renderGrid('input');
  if (state.outputDir) renderGrid('output');
}

// ---------- Rendering ----------
async function renderGrid(which) {
  const wrap = which === 'input' ? inputWrap : outputWrap;
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
    // build tile
    const tile = makeTile(it, null);

    // cache‑bust the image *after* tile exists
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

    // persist selection state
    if (state.selected.has(it.imagePath)) tile.classList.add('selected');

    // click behavior
    tile.addEventListener('click', () => {
      if (state.selectionMode) {
        tile.classList.toggle('selected');
        if (tile.classList.contains('selected')) state.selected.add(it.imagePath);
        else state.selected.delete(it.imagePath);
        deleteSelectedBtn.disabled = state.selected.size === 0;
      } else {
        openModal(which, items, idx);
      }
    }, { passive: true });

    wrap.appendChild(tile);
  });

  setGridSize(which === 'input' ? inputGrid : outputGrid,
              which === 'input' ? state.inputView : state.outputView);
}

//*------theme switcher stuff-------*//

document.addEventListener('DOMContentLoaded', () => {
  const THEME_KEY = 'ldp_theme';
  const themeLink = document.getElementById('theme-link');
  const radios = document.querySelectorAll('input[name="theme"]');

  // restore saved theme (default = cream)
  const saved = localStorage.getItem(THEME_KEY) || 'cream';
  themeLink.href = saved === 'cyber' ? 'cyberLofistyle.css' : 'style.css';

  // reflect in UI
  const checked = document.querySelector(`input[name="theme"][value="${saved}"]`);
  if (checked) checked.checked = true;

  // handle changes
  radios.forEach(r =>
    r.addEventListener('change', (e) => {
      const mode = e.target.value; // "cream" | "cyber"
      themeLink.href = (mode === 'cyber') ? 'cyberLofistyle.css' : 'style.css';
      localStorage.setItem(THEME_KEY, mode);
    })
  );
});



// ---------- Folder pick / rescans ----------
async function pickFolder(kind) {
  const dir = await window.LDP.selectFolder();
  if (!dir) return;

  if (kind === 'input') {
    state.inputDir = dir;
    inputPathEl.textContent = dir;
    const { items } = await window.LDP.scanFolder(dir);
    state.inputItems = items;
    state.tagCache.clear(); // invalidate tags on rescan
    bumpCacheBust();         
    await renderGrid('input');
    inputGrid.classList.remove('hidden');
  } else {
    state.outputDir = dir;
    outputPathEl.textContent = dir;
    const { items } = await window.LDP.scanFolder(dir);
    state.outputItems = items;
    // output may also have tags; clear to be safe when switching dirs
    state.tagCache.clear();
    bumpCacheBust();                 // ← add this
    await renderGrid('output');
    outputGrid.classList.remove('hidden');
  }
  enableOps(!!state.inputDir);
}

pickInputBtn.onclick  = () => pickFolder('input');
pickOutputBtn.onclick = () => pickFolder('output');

// ---------- View size ----------
inputViewSizeSel.onchange = () => {
  state.inputView = inputViewSizeSel.value;
  setGridSize(inputGrid, state.inputView);
};
outputViewSizeSel.onchange = () => {
  state.outputView = outputViewSizeSel.value;
  setGridSize(outputGrid, state.outputView);
};

// ---------- Selection ----------
toggleSelectBtn.onclick = () => {
  state.selectionMode = !state.selectionMode;
  toggleSelectBtn.textContent = `Selection Mode: ${state.selectionMode ? 'On' : 'Off'}`;
  if (!state.selectionMode) {
    state.selected.clear();
    deleteSelectedBtn.disabled = true;
  } else {
    deleteSelectedBtn.disabled = state.selected.size === 0;
  }
  renderGrid('input');
  if (state.outputDir) renderGrid('output');
};

deleteSelectedBtn.onclick = async () => {
  if (!state.selectionMode || state.selected.size === 0) return;
  const selectedPaths = Array.from(state.selected);

  const res = await window.LDP.deleteItems({
    items: state.inputItems,   // operating on INPUT grid for now
    scope: 'selected',
    selectedPaths
  });
  if (!res?.ok) {
    alert(res?.error || 'Delete failed');
    return;
  }
  // rescan
  if (state.inputDir) {
    const { items } = await window.LDP.scanFolder(state.inputDir);
    state.inputItems = items;
  }
  state.selected.clear();
  state.tagCache.clear(); // paths changed → drop cached tags
  renderGrid('input');
};

// ---------- Undo ----------
undoBtn.onclick = async () => {
  const res = await window.LDP.undo();
  if (!res?.ok) { alert('Undo failed'); return; }
  // rescan both (in case)
  if (state.inputDir) {
    const { items } = await window.LDP.scanFolder(state.inputDir);
    state.inputItems = items;
    bumpCacheBust();      
    await renderGrid('input');
  }
  if (state.outputDir) {
    const { items } = await window.LDP.scanFolder(state.outputDir);
    state.outputItems = items;
    await renderGrid('output');
  }
  state.tagCache.clear();
};

// ---------- Shuffle (stub) ----------
shuffleBtn.onclick = async () => {
  if (!state.inputDir) return;

  shuffleBtn.disabled = true;
  const label = shuffleBtn.textContent;
  shuffleBtn.textContent = 'Shuffling…';

  try {
    const res = await window.LDP.shuffle({
      items: state.inputItems,                      // operate on INPUT set
      inDir: state.inputDir,
      outDir: state.outputDir || null,             // null => in-place
      scope: state.selectionMode ? 'selected' : 'all',
      selectedPaths: Array.from(state.selected),
    });

    if (!res?.ok) { alert(res?.error || 'Shuffle failed'); return; }

    // rescan both panes
    if (state.inputDir)  {
      const { items } = await window.LDP.scanFolder(state.inputDir);
      state.inputItems = items;
    }
    if (state.outputDir) {
      const { items } = await window.LDP.scanFolder(state.outputDir);
      state.outputItems = items;
    }

	state.selected.clear();
	state.tagCache.clear();
	bumpCacheBust();                      // ← add this
	await renderGrid('input');
	if (state.outputDir) await renderGrid('output');
  } finally {
    shuffleBtn.textContent = label;
    shuffleBtn.disabled = false;
  }
};


// ---------- Rename ----------
renameBtn.onclick = async () => {
  const base = renameBase.value.trim();
  const pad   = renamePad ? (parseInt(renamePad.value, 10) || 4) : 4;
  const start = renameStart ? (parseInt(renameStart.value, 10) || 0) : 0;
  if (!base) return;

  const scope = state.selectionMode ? 'selected' : 'all';
  const selectedPaths = Array.from(state.selected);
  const payload = {
    items: state.inputItems,
    outDir: state.outputDir || null,
    baseName: base,
    pad,
    start,
    scope,
    selectedPaths
  };

  const res = await window.LDP.renameBatch(payload);
  if (!res?.ok) { alert(res?.error || 'Rename failed'); return; }

  // rescan + rerender (input, and output if present)
  if (state.inputDir) {
    const { items } = await window.LDP.scanFolder(state.inputDir);
    state.inputItems = items;
  }
  if (state.outputDir) {
    const { items } = await window.LDP.scanFolder(state.outputDir);
    state.outputItems = items;
  }
	state.selected.clear();
	state.tagCache.clear();
	bumpCacheBust();                      // ← add this
	await renderGrid('input');
	if (state.outputDir) await renderGrid('output');
};

// ---------- Convert ----------
convertBtn.onclick = async () => {
  if (!state.inputDir) return;

  const targetExt = convertExtSel.value;               // ".png" | ".jpg" | ".webp"
  const outDir    = state.outputDir || null;           // ← null means "in-place"
  const scope     = state.selectionMode ? 'selected' : 'all';
  const selectedPaths = Array.from(state.selected);

  // UI lock
  convertBtn.disabled = true;
  const label = convertBtn.textContent;
  convertBtn.textContent = 'Converting…';

  try {
    const res = await window.LDP.convert({
      items: state.inputItems,
      outDir,                             // null → handled as in-place
      targetExt,
      scope,
      selectedPaths,
      overwrite: !state.outputDir,        // replace originals only if no output dir chosen
      // quality: 92,
    });

    if (!res?.ok) { alert(res?.error || 'Convert failed'); return; }

    // rescan both (output may be same as input)
    if (state.inputDir)  {
      const { items } = await window.LDP.scanFolder(state.inputDir);
      state.inputItems  = items;
    }
    if (state.outputDir) {
      const { items } = await window.LDP.scanFolder(state.outputDir);
      state.outputItems = items;
    }

	state.selected.clear();
	state.tagCache.clear();
	bumpCacheBust();                      // ← add this
	await renderGrid('input');
	if (state.outputDir) await renderGrid('output');
  } finally {
    convertBtn.textContent = label;
    convertBtn.disabled = false;
  }
};



// ---------- Tag search wiring ----------
runSearchBtn.onclick = () => {
  state.filterText = tagSearch.value.trim();
  applyFilter(); // re-render both panes
};
tagSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    state.filterText = tagSearch.value.trim();
    applyFilter();
  }
});
clearSearchBtn.onclick = () => {
  state.filterText = '';
  tagSearch.value = '';
  applyFilter();
};

// ---------- Initial sizes ----------
setGridSize(inputGrid, state.inputView);
setGridSize(outputGrid, state.outputView);
