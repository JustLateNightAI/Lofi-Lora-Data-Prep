# Lofi LoRA Data Prep

A desktop tool for preparing image/caption datasets on **Windows and Linux**. Browse images, edit captions, rename and shuffle pairs, convert formats, and caption images using a configurable **OpenAI-compatible vision API**.

Python, PyTorch, CUDA, local model downloads, and the old JoyCaption sidecar are no longer used. Captioning runs through your chosen API; ordinary dataset editing works without an API key or internet connection.

## Start from source

Install **Node.js 24 LTS** (minimum 22.12) and Git, then:

```sh
git clone https://github.com/JustLateNightAI/Lofi-Lora-Data-Prep.git
cd Lofi-Lora-Data-Prep
```

**Windows 10/11:** run `setup.bat` once, then `start.bat`. `run.bat` remains an alias.

**Linux desktop:** run `./setup.sh` once, then `./start.sh`. If downloaded as a ZIP, use `bash setup.sh` and `bash start.sh`.

Equivalent commands on either platform:

```sh
npm ci
npm run install:electron
npm run dev
```

A graphical desktop and Electron's normal Linux system libraries are required. Keep the Chromium sandbox enabled for normal use. No Python virtual environment is needed. An old `sidecar/.venv` or model cache is no longer read; it can be removed manually if you no longer need it.

Standalone Linux builds use the direct native folder chooser to avoid desktop-portal delays. It opens in your home folder initially and remembers the selected folder. Set `LDP_USE_PORTAL_DIALOGS=1` before launching if you prefer the desktop portal; confined Flatpak/Snap environments retain it automatically.

## Dataset workflow

1. Choose an input folder containing PNG, JPEG, or WebP images and optional matching `.txt` captions.
2. Optionally choose an output folder. Rename, shuffle, and conversion copy their results there when Input is the working folder. Without an output folder, operations change the working folder with original bytes kept in history.
3. Use **Working folder** to explicitly choose Input or Output. Captioning always saves beside images in that working folder.
4. Filter by filenames/captions, select images, and choose All visible or Selected only. An empty selection never means the entire dataset.
5. Click an image to edit its caption. Close/navigation prompts before discarding edits. Filenames with spaces, Unicode, uppercase extensions, and URL punctuation are supported.
6. Use **Undo last change** to restore the latest file operation or caption save, including after restarting.

Destination collisions fail before writes. Multiple image formats sharing a stem, such as `photo.jpg` and `photo.png`, are marked ambiguous because they share `photo.txt`; resolve those names before paired operations. Same-format conversion is skipped in place and copies the original bytes when using an output folder, including uppercase extensions and JPG/JPEG aliases. Conversion between formats normalizes EXIF orientation. JPEG conversion flattens transparency against the image library's default background; use PNG/WebP when transparency matters.

## Vision API captioning

Expand **Vision API settings** and enter:

- **API base URL**, ending at the API root, such as `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, or `http://localhost:1234/v1` for a compatible local server. Private LAN servers work too: entering `192.168.1.2:8000` expands to `http://192.168.1.2:8000/v1`. Custom API paths are preserved. HTTP is supported for local/private LAN hosts; public hosts require HTTPS.
- **Vision model**: choose from the dropdown populated by the server's `/models` endpoint. The list loads when you open API settings or change the endpoint/key; **Refresh models** reloads it on demand. A sole model is selected automatically. The saved selection survives refreshes and connection errors. The model must accept image inputs through Chat Completions; a provider's list may also contain text-only models, which cannot caption images.
- **API key**, if required. Keys are kept in the Electron main process. Remembering a key uses the operating system's encrypted storage. Linux systems without a secure keyring keep keys in memory only. Changing the endpoint clears the old key.
- Optional temperature, maximum image side, and output token limit. Leave temperature empty for the provider default. Choose `max_tokens` for compatible servers requiring it, or `max_completion_tokens` for providers using that field.
- Your caption prompt, or a descriptive/tag preset. Existing text presets in `~/LofiTagger/taggingStyle` remain available.

Save settings before starting. Each request sends the prompt and a JPEG preview of one image to the configured endpoint. Images are oriented correctly and resized within the chosen maximum side; originals stay untouched. No images are sent until Start or Resume is clicked. Provider usage charges and data handling policies apply.

Save modes:

- **Keep existing** (default): skip every existing caption file, including empty files.
- **Review every result**: inspect and edit generated suggestions before saving; discard unwanted suggestions.
- **Replace captions**: explicit replacement with Undo backups.

Jobs record progress locally. Cancel aborts the active request and keeps completed work. Resume retries failed/unfinished images. Interrupted jobs reopen paused and require an explicit Resume. Generated results are saved before writing captions so recovery can reuse them. A provider may still charge for an interrupted request. Rate limits and authentication failures are reported per image; retries are manual. Truncated or empty responses are not written.

API format reference: [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision?api-mode=chat).

## Recovery and storage

History and jobs are stored under Electron's user-data directory (`%APPDATA%/lofi-data-prep` on Windows, `$XDG_CONFIG_HOME/lofi-data-prep` or `~/.config/lofi-data-prep` on Linux). `LDP_DATA_DIR` can select another local application-data directory.

Each operation stages replacements and backs up originals before changing the dataset. On restart, unfinished operations are rolled back. If a file changed outside the app, recovery stops with the backup location instead of overwriting that edit. Preserve the history directory when investigating a recovery error. Original files remain recoverable as long as those backups remain intact.

History is not automatically pruned and uses disk space. Keep enough free space for the originals and staged outputs. Safe publication uses hard links within the destination filesystem, supported by local NTFS and common Linux filesystems; unsupported filesystems fail with an explanation. Back up valuable datasets independently. Legacy `.ldp_trash` folders are left untouched; old in-memory undo records cannot be recovered by the new app.

## Development and builds

```sh
npm run check
npm test
npm run test:ui
npm run dist:linux
npm run dist:win
```

Build each installer on its native platform. Linux produces AppImage and deb packages; Windows produces an NSIS installer. Packages include the desktop runtime and image processing dependencies, with no Python executable or external model files. Installers are unsigned unless signing credentials are configured separately. Builds never publish releases automatically.

CI runs lint, filesystem/API regression tests, real Electron UI tests against a local mock vision API, and native packaging on Windows and Ubuntu. It repeats the UI tests against the built applications to verify bundled native dependencies. Set `LDP_TEST_PACKAGED=1` when running `npm run test:ui` to test a local build. Linux CI uses Xvfb and disables the Chromium sandbox only for its isolated test process. No real API key or billable model requests are needed for tests.

## License and community

[Creative Commons BY-NC 4.0](License). Package metadata follows the existing repository license.

[Discord](https://discord.gg/zxRACHM)
