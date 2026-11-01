const $ = id => document.getElementById(id);
const api = window.LDP;
const state = { settings: null, items: [], selected: new Set(), captions: new Map(), working: 'input', page: 0, busy: false, job: null, scanVersion: 0 };
const PAGE_SIZE = 60;
const presets = {
  descriptive: 'Write a concise factual caption describing the visible subject, appearance, clothing, pose, setting, lighting, and visual style. Describe only what is visible. Return only the caption.',
  tags: 'Describe the visible image using a comma-separated list of concise tags. Include subject, appearance, clothing, pose, background, lighting, and style. Do not invent artist names, identities, or hidden details. Return only tags.'
};
let customPresets = [];
const modelList = { request: 0, baseURL: '', items: [] };
let modelTimer;
function paintModels(selected = '') {
  const select = $('api-model'); select.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a model…'; select.append(placeholder);
  const ids = [...modelList.items]; if (selected && !ids.includes(selected)) ids.unshift(selected);
  for (const id of ids) {
    const option = document.createElement('option'); option.value = id;
    option.textContent = modelList.items.includes(id) ? id : `${id} (saved; not listed)`; select.append(option);
  }
  select.value = selected;
}
async function refreshModels() {
  clearTimeout(modelTimer);
  const request = ++modelList.request;
  const baseURL = $('api-url').value.trim(), selected = $('api-model').value;
  if (!baseURL) { $('model-status').textContent = 'Enter an API address first.'; return; }
  $('refresh-models').disabled = true; $('api-model').disabled = true;
  $('model-status').textContent = 'Loading available models…';
  try {
    const result = await api.models({ baseURL, apiKey: $('api-key').value });
    if (request !== modelList.request) return;
    modelList.baseURL = result.baseURL; modelList.items = result.models;
    const saved = state.settings?.api.baseURL === result.baseURL ? state.settings.api.model : '';
    const preferred = selected || saved;
    paintModels(preferred && (result.models.includes(preferred) || preferred === saved) ? preferred : result.models.length === 1 ? result.models[0] : '');
    $('model-status').textContent = result.models.length ? `${result.models.length} models available. Choose one that supports image inputs; some providers also list text-only models.` : 'The server returned no models. Load a model on the server, then refresh.';
  } catch (e) {
    if (request === modelList.request) $('model-status').textContent = e.message;
  } finally {
    if (request === modelList.request) { $('refresh-models').disabled = false; $('api-model').disabled = false; }
  }
}
function queueModels() { clearTimeout(modelTimer); if ($('api-panel').open) modelTimer = setTimeout(refreshModels, 600); }
function modelConnectionChanged(clearSelection) {
  modelList.request++; modelList.items = []; modelList.baseURL = '';
  $('refresh-models').disabled = false; $('api-model').disabled = false;
  paintModels(clearSelection ? '' : $('api-model').value);
  $('model-status').textContent = 'Waiting to load models…'; queueModels();
}
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function dir() { return state.settings?.[`${state.working}Dir`] || null; }
function visibleItems() {
  const query = $('search').value.trim().toLowerCase();
  return state.items.filter(i => !query || `${i.filename}\n${state.captions.get(i.imagePath) || ''}`.toLowerCase().includes(query));
}
function targets() { return $('scope').value === 'selected' ? visibleItems().filter(i => state.selected.has(i.imagePath)) : visibleItems(); }
function busy() { return state.busy || state.job?.running; }
function controls() {
  const unavailable = busy() || !dir();
  for (const id of ['rename','convert','shuffle','generate']) $(id).disabled = unavailable || !targets().length;
  $('delete').disabled = unavailable || !state.selected.size;
  for (const id of ['undo','pick-input','pick-output','clear-output','working-folder','save-api','forget-key','save-template']) $(id).disabled = !!busy();
  $('cancel-job').disabled = !state.job?.running;
  $('resume-job').disabled = !!busy() || !state.job?.items.some(i => ['pending','failed','cancelled'].includes(i.status));
  $('selection-count').textContent = `${state.selected.size} selected · ${targets().length} in operation`;
  const output = state.working === 'input' ? state.settings?.outputDir : null;
  $('operation-target').textContent = output ? `Copy results to: ${output}` : 'Changes apply to the working folder. Undo keeps the original files.';
  $('caption-target').textContent = dir() ? `Captions will be saved beside images in: ${dir()}` : 'Choose a working folder.';
}
async function task(fn) {
  if (busy()) return;
  state.busy = true; controls();
  try { await fn(); } catch (e) { status(e.message, true); }
  finally { state.busy = false; controls(); }
}
function paintSettings() {
  const s = state.settings, a = s.api;
  $('input-path').textContent = s.inputDir || 'No folder selected';
  $('output-path').textContent = s.outputDir || 'Optional: copy operations here';
  $('working-folder').querySelector('[value="output"]').disabled = !s.outputDir;
  if (state.working === 'output' && !s.outputDir) state.working = 'input';
  $('working-folder').value = state.working;
  clearTimeout(modelTimer); modelList.request++; $('refresh-models').disabled = false; $('api-model').disabled = false;
  if (modelList.baseURL !== a.baseURL) { modelList.baseURL = a.baseURL; modelList.items = []; }
  $('model-status').textContent = modelList.items.length ? `${modelList.items.length} models available. Choose one that supports image inputs; some providers also list text-only models.` : 'Refresh models to load the available choices.';
  $('api-url').value = a.baseURL; paintModels(a.model); $('api-tokens').value = a.maxTokens;
  $('api-token-field').value = a.tokenField; $('api-temperature').value = a.temperature ?? '';
  $('api-reasoning').value = a.reasoningEffort || '';
  $('api-image-side').value = a.imageSide; $('api-prompt').value = a.prompt; $('api-key').value = '';
  $('remember-key').disabled = !s.canRememberKey; $('remember-key').checked = s.remembered;
  $('key-status').textContent = `${s.hasKey ? (s.remembered ? 'Key saved in OS-protected storage.' : 'Key kept for this session only.') : 'No API key set. Local servers may not need one.'}${s.canRememberKey ? '' : ' Secure key storage is unavailable; keys stay in memory.'}`;
  controls();
}
async function refresh() {
  const version = ++state.scanVersion;
  state.captions.clear();
  if (!dir()) { state.items = []; render(); return; }
  const result = await api.scan(dir());
  if (version !== state.scanVersion) return;
  state.items = result.items;
  state.selected = new Set([...state.selected].filter(p => state.items.some(i => i.imagePath === p)));
  $('warnings').textContent = result.warnings.join('\n');
  render();
  if ($('search').value) await loadSearchCaptions(version);
}
async function loadSearchCaptions(version = state.scanVersion) {
  const missing = state.items.filter(i => i.tagPath && !i.ambiguous && !state.captions.has(i.imagePath));
  for (let offset = 0; offset < missing.length; offset += 8) {
    await Promise.all(missing.slice(offset, offset + 8).map(async item => {
      const result = await api.readCaption(item.imagePath).catch(() => null);
      if (version === state.scanVersion && result) state.captions.set(item.imagePath, result.text);
    }));
    if (version !== state.scanVersion) return;
  }
  render();
}
function render() {
  const visible = visibleItems();
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  $('grid').replaceChildren();
  for (const item of visible.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    const tile = document.createElement('div'); tile.className = 'tile'; tile.classList.toggle('selected', state.selected.has(item.imagePath));
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.selected.has(item.imagePath); check.setAttribute('aria-label', `Select ${item.filename}`);
    check.onchange = () => { if (check.checked) state.selected.add(item.imagePath); else state.selected.delete(item.imagePath); tile.classList.toggle('selected', check.checked); controls(); };
    const button = document.createElement('button'); button.setAttribute('aria-label', `Edit ${item.filename}`);
    const image = document.createElement('img'); image.src = item.imageUrl; image.alt = ''; image.loading = 'lazy';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.filename;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = item.ambiguous ? 'Ambiguous caption stem' : item.tagPath ? 'Captioned' : 'Missing caption';
    button.append(image, name, badge); button.onclick = () => openEditor(item).catch(e => status(e.message, true));
    tile.append(check, button); $('grid').append(tile);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = dir() ? 'No matching images. Supported formats: PNG, JPEG, WebP.' : 'Choose an input folder to begin.'; $('grid').append(empty); }
  $('image-count').textContent = `${visible.length} visible / ${state.items.length} images`;
  $('page-number').textContent = `${state.page + 1} / ${pages}`;
  $('previous-page').disabled = state.page === 0; $('next-page').disabled = state.page + 1 >= pages; controls();
}
function bind(id, fn) { $(id).onclick = () => task(fn); }
for (const kind of ['input','output']) bind(`pick-${kind}`, async () => {
  status('Opening folder chooser…');
  const settings = await api.pickFolder(kind); if (!settings) { status('Folder selection cancelled.'); return; }
  status('Loading folder…');
  state.settings = settings; state.selected.clear(); state.page = 0; paintSettings(); await refresh(); status('Folder loaded.');
});
bind('clear-output', async () => { state.settings = await api.clearOutput(); paintSettings(); await refresh(); });
$('working-folder').onchange = () => task(async () => { state.working = $('working-folder').value; state.selected.clear(); state.page = 0; await refresh(); });
bind('refresh', refresh);
bind('undo', async () => { const result = await api.undo(); await refresh(); status(result.message); });
for (const kind of ['rename','convert','shuffle','delete']) bind(kind, async () => {
  const selected = kind === 'delete' ? state.items.filter(i => state.selected.has(i.imagePath)) : targets();
  if (!selected.length) throw new Error('No images selected.');
  const output = kind !== 'delete' && state.working === 'input' ? state.settings.outputDir : null;
  if (kind === 'delete' && !confirm(`Delete ${selected.length} image(s) and their captions? Undo can restore them.`)) return;
  const result = await api.action({ kind, inDir: dir(), outDir: output, scope: 'selected', selectedPaths: selected.map(i => i.imagePath), baseName: $('rename-base').value.trim(), targetExt: $('convert-ext').value });
  state.selected.clear(); await refresh(); status(`${kind}: ${result.changed} files changed.${result.skipped ? ` ${result.skipped} images already in that format.` : ''}`);
});
$('scope').onchange = controls;
$('select-all').onclick = () => { visibleItems().forEach(i => state.selected.add(i.imagePath)); render(); };
$('select-none').onclick = () => { state.selected.clear(); render(); };
let searchTimer;
$('search').oninput = () => { state.page = 0; render(); clearTimeout(searchTimer); searchTimer = setTimeout(() => loadSearchCaptions().catch(e => status(e.message, true)), 250); };
$('previous-page').onclick = () => { state.page--; render(); }; $('next-page').onclick = () => { state.page++; render(); };
function apiForm() { return { baseURL: $('api-url').value, model: $('api-model').value, apiKey: $('api-key').value, rememberKey: $('remember-key').checked, maxTokens: Number($('api-tokens').value), tokenField: $('api-token-field').value, reasoningEffort: $('api-reasoning').value, temperature: $('api-temperature').value, imageSide: Number($('api-image-side').value), prompt: $('api-prompt').value }; }
bind('save-api', async () => { state.settings = await api.saveApi(apiForm()); paintSettings(); status('API settings saved.'); });
bind('forget-key', async () => { state.settings = await api.saveApi({ ...state.settings.api, forgetKey: true }); paintSettings(); modelConnectionChanged(false); status('API key removed.'); });
$('refresh-models').onclick = refreshModels;
$('api-url').addEventListener('input', () => modelConnectionChanged(true));
$('api-key').addEventListener('input', () => modelConnectionChanged(false));
$('api-panel').addEventListener('toggle', () => { if ($('api-panel').open) queueModels(); else clearTimeout(modelTimer); });
async function loadTemplates() {
  customPresets = await api.templates();
  for (const option of [...$('prompt-preset').options]) if (option.value.startsWith('saved:')) option.remove();
  customPresets.forEach((t, i) => { const opt = document.createElement('option'); opt.value = `saved:${i}`; opt.textContent = t.label; $('prompt-preset').append(opt); });
}
$('prompt-preset').onchange = () => { const value = $('prompt-preset').value; if (presets[value]) $('api-prompt').value = presets[value]; else if (value.startsWith('saved:')) $('api-prompt').value = customPresets[Number(value.slice(6))].content; };
bind('save-template', async () => { await api.saveTemplate({ label: $('template-name').value.trim(), content: $('api-prompt').value }); await loadTemplates(); $('template-name').value = ''; status('Prompt preset saved.'); });
function paintJob(job) {
  const wasRunning = state.job?.running; state.job = job;
  $('job-results').replaceChildren();
  $('job-pause-reason').hidden = !job?.pauseReason;
  $('job-pause-reason').textContent = job?.pauseReason ? `Paused: ${job.pauseReason} Completed captions were kept; remaining images are queued.` : '';
  if (job) {
    const done = job.items.filter(i => !['pending','running'].includes(i.status)).length;
    const failed = job.items.filter(i => i.status === 'failed').length;
    $('job-status').textContent = `${job.status}: ${done}/${job.items.length} processed · ${failed} failed · ${job.config.model} at ${job.config.baseURL}`;
    $('job-progress').max = job.items.length || 1; $('job-progress').value = done;
    for (const item of job.items.filter(i => ['failed','review','running'].includes(i.status))) {
      const row = document.createElement('div'); row.className = 'job-row';
      const text = document.createElement('span'); text.textContent = `${item.filename}: ${item.status}${item.error ? ` — ${item.error}` : ''}`; row.append(text);
      if (item.status === 'review') { const button = document.createElement('button'); button.textContent = 'Review'; button.disabled = job.running; button.onclick = () => openEditor(item, true).catch(e => status(e.message, true)); row.append(button); }
      $('job-results').append(row);
    }
  }
  controls();
  if (wasRunning && !job?.running) refresh().catch(e => status(e.message, true));
}
bind('generate', async () => {
  if ($('caption-mode').value === 'replace' && !confirm(`Replace captions for ${targets().length} images? Existing captions will be backed up for Undo.`)) return;
  const job = await api.startJob({ dir: dir(), scope: 'selected', selectedPaths: targets().map(i => i.imagePath), mode: $('caption-mode').value });
  paintJob(job); status('Caption job started.');
});
$('cancel-job').onclick = () => api.cancelJob().catch(e => status(e.message, true));
bind('resume-job', async () => { paintJob(await api.resumeJob()); status('Caption job resumed.'); });
api.onJob(paintJob);

const editor = { token: 0, item: null, original: '', hash: null, saving: false, ready: false, review: false };
function canLeave() { return !editor.saving && (!editor.ready || $('editor-text').value === editor.original || confirm('Discard unsaved caption edits?')); }
function closeEditor() { if (!canLeave()) return; editor.token++; editor.ready = false; $('editor').close(); }
async function openEditor(item, review = false) {
  if ($('editor').open && !canLeave()) return;
  const token = ++editor.token; editor.item = item; editor.review = review; editor.ready = false;
  $('editor-name').textContent = item.filename; $('editor-text').value = ''; $('editor-text').disabled = true; $('editor-save').disabled = true;
  $('editor-status').textContent = 'Reading caption…'; $('editor-mode').textContent = review ? 'Review API suggestion before saving.' : 'Edit this image’s caption.';
  $('original-caption').hidden = !review; $('editor-discard').hidden = !review;
  $('editor-image').src = `${item.imageUrl || `ldp-image://image/?path=${encodeURIComponent(item.imagePath)}`}&full=1`;
  if (!$('editor').open) $('editor').showModal();
  try {
    const result = await api.readCaption(item.imagePath);
    if (token !== editor.token || !$('editor').open) return;
    editor.hash = result.hash; editor.original = review ? item.text : result.text;
    $('editor-original').textContent = result.text || '(No caption)'; $('editor-text').value = editor.original;
    editor.ready = true; $('editor-text').disabled = false; $('editor-save').disabled = !!busy(); $('editor-status').textContent = '';
  } catch (e) { if (token === editor.token) $('editor-status').textContent = e.message; }
}
$('editor-save').onclick = async () => {
  if (!editor.ready || editor.saving || busy()) return;
  const item = editor.item, text = $('editor-text').value, review = editor.review;
  editor.saving = true; $('editor-save').disabled = true; $('editor-text').disabled = true;
  try {
    if (review) paintJob(await api.reviewCaption({ imagePath: item.imagePath, text }));
    else await api.saveCaption({ imagePath: item.imagePath, text, hash: editor.hash });
    editor.original = text; editor.ready = false; $('editor').close(); await refresh(); status('Caption saved. Undo can restore the previous version.');
  } catch (e) { $('editor-status').textContent = e.message; }
  finally { editor.saving = false; $('editor-save').disabled = false; $('editor-text').disabled = false; }
};
$('editor-discard').onclick = async () => { if (busy() || !canLeave()) return; try { paintJob(await api.reviewCaption({ imagePath: editor.item.imagePath, text: null })); editor.ready = false; closeEditor(); } catch (e) { $('editor-status').textContent = e.message; } };
$('editor-close').onclick = closeEditor;
$('editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
async function navigate(delta) { const list = visibleItems(); const index = list.findIndex(i => i.imagePath === editor.item?.imagePath); if (!editor.review && index >= 0 && list[index + delta]) await openEditor(list[index + delta]); }
$('editor-prev').onclick = () => navigate(-1); $('editor-next').onclick = () => navigate(1);
$('editor').addEventListener('keydown', event => {
  if (['TEXTAREA','INPUT','SELECT'].includes(event.target.tagName) || event.isComposing) return;
  if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); navigate(event.key === 'ArrowLeft' ? -1 : 1); }
});
window.addEventListener('beforeunload', event => { if ($('editor').open && !canLeave()) event.returnValue = false; });
try {
  const initial = await api.state(); state.settings = initial.settings; paintSettings(); paintJob(initial.job);
  await loadTemplates(); await refresh(); status(initial.startupError || 'Ready. Choose a folder, or configure a vision API to caption images.', !!initial.startupError);
} catch (e) { status(e.message, true); }
