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

// --- Guard helpers: block navigation while typing ---
function isTypingElement(el) {
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  const type = el.type ? String(el.type).toLowerCase() : "";

  // Inputs that accept text
  if (tag === "input") {
    const texty = ["text","search","url","tel","password","email","number"];
    if (texty.includes(type)) return true;
  }
  if (tag === "textarea" || tag === "select") return true;

  // Contenteditable regions
  if (el.isContentEditable) return true;

  // If your tag editor has a wrapper, list it here (optional)
  if (el.closest && el.closest(".tag-editor, .tags-box, [data-role='tag-editor']")) return true;

  return false;
}

// IME composition safety
let composing = false;
window.addEventListener("compositionstart", () => (composing = true), true);
window.addEventListener("compositionend",   () => (composing = false), true);

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

  // 🚫 Don’t change images if user is typing in tags (or any text field)
  if (composing || isTypingElement(document.activeElement)) return;

  if (e.key === 'Escape') return closeModal();

  // Prevent default so arrows don't scroll the page when navigating images
  if (e.key === 'ArrowLeft' && state.index > 0) {
    e.preventDefault();
    show(state.index - 1);
  } else if (e.key === 'ArrowRight' && state.index < state.items.length - 1) {
    e.preventDefault();
    show(state.index + 1);
  }
}

export async function openModal(listRef, items, index) {
  state.open = true;
  state.listRef = listRef;
  state.items = items;
  modal.classList.remove('hidden');
  modal.focus();
  show(index);
  window.addEventListener('keydown', onKey, { capture: true }); // capture helps intercept before other handlers
}

export function closeModal() {
  state.open = false;
  modal.classList.add('hidden');
  window.removeEventListener('keydown', onKey, { capture: true });
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
