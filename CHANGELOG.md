# Changelog

## Unreleased

- Add a saved AI Toolkit installation path and an **Export to AI Toolkit** button.
- Copy the current working folder/selection into a new named dataset under the installation’s `datasets` folder, with matching saved captions.
- Convert WebP export copies to PNG, preserve PNG/JPEG bytes and source files, and report missing captions.
- Prevent existing datasets from being overwritten and use persistent Undo/recovery for exported files.

## 0.2.0

### Captioning

- Replace the Python/JoyCaption sidecar with configurable OpenAI-compatible vision API captioning.
- Discover available models from the API and choose them in a dropdown.
- Support localhost and private LAN servers, including servers without API keys.
- Add thinking controls and configurable token budgets, with a 2,048-token default for new settings.
- Send one image per request, sequentially. Save only usable final captions.
- Pause batches on connection failures, HTTP errors, exhausted token budgets, and missing final answers.
- Retry unfinished work using current saved API settings while preserving completed captions and pending reviews.
- Add prompt presets, missing-caption mode, draft review, cancellation, and persistent job recovery.
- Keep API keys in the main process, with optional OS-protected storage.

### Dataset editing

- Stage file operations and back up originals for persistent Undo and crash recovery.
- Detect image/caption collisions and ambiguous stems before changing files.
- Protect captions from stale reads and saves, and preserve external edits during recovery.
- Support an explicit working folder, paginated image previews, and portable filenames.
- Preserve original bytes for same-format copies, including uppercase extensions and JPG/JPEG aliases.

### Linux and Windows

- Update the desktop runtime, image-processing dependencies, setup scripts, and build tooling.
- Build AppImage/deb packages for Linux and an NSIS installer for Windows.
- Use the direct native Linux folder chooser to avoid desktop-portal delays, with a portal opt-in.
- Remember folder locations and recover cleanly from chooser cancellation or failure.

### Validation

- Initial manual Linux testing by the maintainer reported expected behavior.
- [Windows and Ubuntu CI](https://github.com/JustLateNightAI/Lofi-Lora-Data-Prep/actions/runs/41267871895) passed 30 regression tests, 7 source Electron UI tests, and the same 7 tests against packaged applications. Native installer builds also passed.
- Verified model discovery and image captioning against a local TensorFold API using synthetic images, including requests with thinking disabled.
- Windows validation is automated; manual Windows testing is still pending.

Installers are unsigned. This changelog documents the application changes; downloadable release publication is separate.
