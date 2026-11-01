const sharp = require('sharp');
const { isIP } = require('node:net');
const DEFAULT_PROMPT = 'Write a concise factual caption describing the visible subject, appearance, clothing, pose, setting, lighting, and visual style. Describe only what is visible. Return only the caption.';
function localHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) return host === '::1' || /^(fc|fd)[\da-f]{2}:/.test(host);
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^[a-z\d-]+$/i.test(host);
}
function normalizeBaseURL(value = 'https://api.openai.com/v1') {
  const raw = String(value).trim();
  if (!raw) throw new Error('Enter an API base URL.');
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw);
  const url = new URL(hasScheme ? raw : `http://${raw}`);
  if (!hasScheme && !localHost(url.hostname)) url.protocol = 'https:';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Use HTTPS, or HTTP for localhost or a private LAN server.');
  if (url.pathname === '/') url.pathname = '/v1';
  return url.href.replace(/\/+$/, '');
}
function normalizeConfig(input = {}) {
  const baseURL = normalizeBaseURL(input.baseURL);
  const model = String(input.model || '').trim();
  if (model.length > 200) throw new Error('Model name is too long.');
  const maxTokens = Number(input.maxTokens ?? 2048);
  if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 65536) throw new Error('Output token limit must be 32–65536.');
  const reasoningEffort = input.reasoningEffort ?? '';
  if (!['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) throw new Error('Invalid thinking setting.');
  const imageSide = Number(input.imageSide ?? 1536);
  if (![768, 1024, 1536, 2048].includes(imageSide)) throw new Error('Invalid image size.');
  const temperature = input.temperature === '' || input.temperature == null ? null : Number(input.temperature);
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('Temperature must be 0–2 or left empty.');
  const tokenField = input.tokenField === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens';
  const prompt = String(input.prompt ?? DEFAULT_PROMPT).trim();
  if (!prompt || prompt.length > 20000) throw new Error('Provide a prompt shorter than 20,000 characters.');
  return { baseURL, model, maxTokens, imageSide, temperature, tokenField, prompt, reasoningEffort };
}
function pauseError(message, code) { return Object.assign(new Error(message), { code, pauseJob: true }); }
async function listModels(baseURL, apiKey = '', fetchFn = fetch) {
  const endpoint = normalizeBaseURL(baseURL);
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response;
  try {
    response = await fetchFn(`${endpoint}/models`, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Could not reach the model list. Check the API address, network connection, and whether the server is running.');
  }
  if (!response.ok) {
    const hint = { 401: 'Check your API key.', 403: 'Check access to the model list.', 404: 'This API does not expose /models at this base URL.', 429: 'Rate limit reached; try again later.' }[response.status] || 'Check the server status and API base URL.';
    throw new Error(`Models HTTP ${response.status}. ${hint}`);
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The model endpoint returned invalid JSON. Check the API base URL.'); }
  if (!Array.isArray(data?.data)) throw new Error('The API returned an unsupported model list. Expected a data array of model IDs.');
  return [...new Set(data.data.map(model => model?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 200).map(id => id.trim()))].sort((a, b) => a.localeCompare(b));
}
async function caption(imagePath, config, apiKey, signal, fetchFn = fetch) {
  if (!config.model) throw new Error('Choose a vision-capable model in API settings.');
  const bytes = await sharp(imagePath, { limitInputPixels: 100000000 }).rotate()
    .resize({ width: config.imageSide, height: config.imageSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  signal?.throwIfAborted();
  const body = { model: config.model, messages: [{ role: 'user', content: [
    { type: 'text', text: config.prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }
  ] }], [config.tokenField]: config.maxTokens };
  if (config.temperature !== null) body.temperature = config.temperature;
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  const timeout = AbortSignal.timeout(180000);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response, data;
  try {
    response = await fetchFn(`${config.baseURL}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (response.ok) data = await response.json();
  } catch {
    signal?.throwIfAborted();
    throw pauseError(timeout.aborted
      ? 'The API request timed out. Check the server or lower thinking effort, then resume.'
      : 'The API connection failed or returned an unreadable response. Check that the server is running, then resume.', 'API_UNAVAILABLE');
  }
  if (!response.ok) {
    // Never persist an arbitrary provider response: it may echo credentials or image data.
    const hint = { 400: 'Check model compatibility, thinking setting, and token limit.', 401: 'Check your API key.', 403: 'Check model access.', 404: 'Check the base URL and model name.', 429: 'Rate limit or quota reached; retry later.' }[response.status] || 'Check model compatibility and provider status.';
    throw pauseError(`API HTTP ${response.status}. ${hint}`, 'API_HTTP');
  }
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
    const detail = Number.isInteger(reasoning) && reasoning > 0 ? ` The API reports ${reasoning} reasoning tokens.` : '';
    throw pauseError(`Caption was truncated (request budget: ${config.maxTokens} tokens). Thinking may share this budget.${detail} Disable or lower thinking, or increase the limit; save API settings and retry.`, 'TOKEN_LIMIT');
  }
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error('The provider declined to caption this image.');
  let text = choice?.message?.content;
  // Some local servers return tagged reasoning inside content instead of a
  // separate reasoning field. Only a complete final answer may become a caption.
  if (typeof text === 'string') text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (typeof text !== 'string' || !text || text.length > 20000 || /<\/?think>/i.test(text)) throw pauseError('The API returned no usable final caption. Check image support and thinking settings, then retry.', 'NO_CAPTION');
  return text.trim();
}
module.exports = { normalizeBaseURL, normalizeConfig, listModels, caption, DEFAULT_PROMPT };
