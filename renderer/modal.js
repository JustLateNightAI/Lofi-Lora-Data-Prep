let state = {
  open: false,
  listRef: null,   // 'input' | 'output'
  items: [],
  index: 0
};

const modal = document.getElementById('modal');
const imgEl = document.getElementById('modal-image');
const nameEl = document.getElementById('modal-filename');
const tagsEl = document.getElementById('modal-tags');

document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-save').onclick = saveTags;

function show(idx) {
  const item = state.items[idx];
  state.index = idx;
  imgEl.src = `file://${item.imagePath}`;
  nameEl.textContent = item.filename;
  state.currentTagPath = item.tagPath || null;

  if (item.tagPath) {
    window.LDP.readText(item.tagPath).then(res => {
      tagsEl.value = res?.ok ? res.text : '';
    });
  } else {
    tagsEl.value = '';
  }
}

function onKey(e) {
  if (!state.open) return;
  if (e.key === 'Escape') return closeModal();
  if (e.key === 'ArrowLeft' && state.index > 0) show(state.index - 1);
  if (e.key === 'ArrowRight' && state.index < state.items.length - 1) show(state.index + 1);
}

export async function openModal(listRef, items, index) {
  state.open = true;
  state.listRef = listRef;
  state.items = items;
  modal.classList.remove('hidden');
  modal.focus();
  show(index);
  window.addEventListener('keydown', onKey);
}

export function closeModal() {
  state.open = false;
  modal.classList.add('hidden');
  window.removeEventListener('keydown', onKey);
}

async function saveTags() {
  if (!state.currentTagPath) {
    // create a tag file alongside the image if none exists
    const img = state.items[state.index];
    const baseDir = img.imagePath.substring(0, img.imagePath.lastIndexOf('/'));
    const baseName = img.filename.replace(/\.[^/.]+$/, '');
    state.currentTagPath = `${baseDir}/${baseName}.txt`;
  }
  const res = await window.LDP.writeText(state.currentTagPath, tagsEl.value);
  if (!res?.ok) alert(res?.error || 'Failed to save tags');
}
