// Minimal action helper to call JoyCaption from renderer code
export async function captionPromptForImage(imagePath, opts = {}) {
// opts: { device:'gpu'|'cpu', quant:'int8'|'nf4'|'bf16', imageSide:384|448, maxTokens:160|200 }
return await window.joy.prompt(imagePath, opts);
}
