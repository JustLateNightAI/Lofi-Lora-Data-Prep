const sharp = require('sharp');
const DEFAULT_PROMPT = 'Write a concise factual caption describing the visible subject, appearance, clothing, pose, setting, lighting, and visual style. Describe only what is visible. Return only the caption.';
function normalizeConfig(input = {}) {
  const url = new URL(input.baseURL || 'https://api.openai.com/v1');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS API base URL, or HTTP for a local server.');
  const model = String(input.model || '').trim();
  if (model.length > 200) throw new Error('Model name is too long.');
  const maxTokens = Number(input.maxTokens ?? 512);
  if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 8192) throw new Error('Output token limit must be 32–8192.');
  const imageSide = Number(input.imageSide ?? 1536);
  if (![768, 1024, 1536, 2048].includes(imageSide)) throw new Error('Invalid image size.');
  const temperature = input.temperature === '' || input.temperature == null ? null : Number(input.temperature);
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('Temperature must be 0–2 or left empty.');
  const tokenField = input.tokenField === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens';
  const prompt = String(input.prompt ?? DEFAULT_PROMPT).trim();
  if (!prompt || prompt.length > 20000) throw new Error('Provide a prompt shorter than 20,000 characters.');
  return { baseURL: url.href.replace(/\/+$/, ''), model, maxTokens, imageSide, temperature, tokenField, prompt };
}
async function caption(imagePath, config, apiKey, signal, fetchFn = fetch) {
  if (!config.model) throw new Error('Enter a vision-capable model name in API settings.');
  const bytes = await sharp(imagePath, { limitInputPixels: 100000000 }).rotate()
    .resize({ width: config.imageSide, height: config.imageSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  signal?.throwIfAborted();
  const body = { model: config.model, messages: [{ role: 'user', content: [
    { type: 'text', text: config.prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }
  ] }], [config.tokenField]: config.maxTokens };
  if (config.temperature !== null) body.temperature = config.temperature;
  const timeout = AbortSignal.timeout(180000);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchFn(`${config.baseURL}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) {
    // Never persist an arbitrary provider response: it may echo credentials or image data.
    const hint = { 401: 'Check your API key.', 403: 'Check model access.', 404: 'Check the base URL and model name.', 429: 'Rate limit or quota reached; retry later.' }[response.status] || 'Check model compatibility and provider status.';
    throw new Error(`API HTTP ${response.status}. ${hint}`);
  }
  const data = await response.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('Caption was truncated. Increase the output token limit and retry.');
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error('The provider declined to caption this image.');
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('The API returned no usable caption. Check that the model supports images.');
  return text.trim();
}
module.exports = { normalizeConfig, caption, DEFAULT_PROMPT };
