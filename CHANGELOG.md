# Changelog

## 2.0.0 — AI Film Factory

- Added an authenticated AI Story Director endpoint backed by the account-configured language model runtime. It supports full screenplay drafting, story treatments/director vision, structured scene-to-shot breakdowns, and production-plan generation.
- Added a dedicated Story Director workspace with model-list selection, creative brief input, screenplay/context injection, review-before-apply controls, and downloadable Markdown outputs.
- Added a sequential automated production pipeline to queue draft storyboard scenes and any configured music, voice/dialogue and sound-effects tasks against their respective workflows, with pause-on-error behaviour and durable job monitoring.
- Added a dedicated sound-design/Foley workflow, prompt and node mapping, persisted in the production settings and available to manual or automated queue submission.
- Added spreadsheet-safe CSV export for structured AI director shot breakdowns, including framing, lens, movement, duration, generation prompts and sound notes.
- Expanded the Film Studio route map and project documentation for the new director workflow.
- Retained the existing cast/character and location continuity bible, reference-image propagation, voice assignment, dialogue extraction, voice/music/lip-sync workflow adapters, multitrack FFmpeg compositor, dialogue/music/effects buses with ducking, subtitle transcription, LUT/VFX controls, segmented resumable rendering, and 720p/1080p/4K UHD export.
- Aligned package and lockfile versions at 2.0.0.

### 2.0.0 capability boundaries

- AI screenplay, story-direction, shot-breakdown and production-plan actions require a text model configured for the signed-in user; provider charges, rate limits and model availability depend on that provider.
- Scene video, image, voice, music and lip-sync generation require compatible configured ComfyUI workflows, models/custom nodes or supported external providers. This release does not bundle proprietary model weights or guarantee free generation.
- Character and location continuity is enforced through reusable prompt context and approved reference assets; pixel-identical identity depends on the selected model and compatible identity-conditioning workflow.
- 4K is a supported final-render target, subject to source media, available memory/GPU/CPU, FFmpeg build, storage and deployment limits. It does not imply that every generation model produces native 4K media.
- The automated scene pipeline submits jobs sequentially and persists them through the existing queue. Provider execution and long-running render processing still depend on the configured server/runtime being available.


## 1.6.0 — Route integrity, developer experience & GitHub polish

- Added `npm run check:routes`, a dependency-free repository audit for Film Studio API references, internal Studio links, App Router handlers, and local Markdown links.
- Rebuilt the GitHub landing README with a professional project overview, badges, capability matrix, Mermaid production/architecture diagrams, quick start, verification steps, and explicit model/runtime boundaries.
- Added structured GitHub bug-report and feature-request issue forms plus a pull-request checklist.
- Added a spreadsheet-safe scene/shot-list CSV export for production handoff, including RFC-style quoting and formula-injection protection.
- Aligned package and lockfile versions at 1.6.0 and documented the new verification command.

### 1.6.0 verification boundaries

- The route audit validates source-level route existence and local documentation links; it is not a substitute for a running-server HTTP smoke test or full browser navigation test.
- A complete Next.js production build and model-generation end-to-end test were not run in this packaging environment because project dependencies and external services are not installed.

## 1.5.0 — Free Video Lab & Studio UI refresh

- Added a local-first Free Video Lab that turns up to 30 uploaded still images into a downloadable 30 FPS WebM motion video using cinematic pan/zoom movement. No API key, cloud credits, or image upload is required.
- Added landscape, portrait, and square output presets, per-image duration controls, progress feedback, in-browser playback, and download.
- Added a dedicated production navigation tab and refreshed selected-tab/focus states with responsive layouts for smaller screens.
- Existing ComfyUI/Wan workflows remain available for AI video generation; the Free Video Lab is a no-cost still-image motion-video tool, not a hosted text-to-video model.

## 1.4.0 — Multitrack compositing, cast continuity and resumable feature masters

- Connected the persisted multitrack timeline to a dedicated FFmpeg compositor and added a Render multitrack master action in the editor.
- Added true FFmpeg `xfade` transitions for contiguous overlapping picture clips, plus alpha-faded overlays for independently layered picture/effect tracks.
- Added simultaneous dialogue, music and effects buses with configurable gain, delayed timeline placement, and sidechain compression that automatically ducks music under dialogue.
- Added per-clip gamma, exposure, temperature, tint and vignette controls, plus blur, sharpen, vignette and grain effects; retained `.cube` 3D LUT and subtitle burn-in support.
- Added time-segmented render jobs (30–120 second segments). Each bounded segment renders with transition pre/post-roll, is archived to object storage and checkpointed in the durable render-job payload; retries skip completed segments and assemble the final MP4 after all segments are present.
- Added character/cast registry APIs and UI for voice IDs, language metadata and approved character reference images. Dialogue lines are mapped to the configured character voice and the voice lock is included in scene prompts.
- Added per-scene character, location and style reference-image selection. Reference sets propagate forward from scene to scene, are included in generation prompts, and are uploaded into configured ComfyUI image-loader nodes before scene generation.
- Added tests for FFmpeg graph composition, audio ducking, segmentation/checkpoint recovery, voice assignment and scene reference propagation.

### 1.4.0 boundaries

- Segmented rendering is checkpointed and resumable through the render API/UI, but it is request-driven rather than a Temporal.io workflow. A production deployment should run the same segment processor from a supervised worker for unattended execution after browser disconnects or host restarts.
- Segment renders currently evaluate the full timeline filter graph and trim the requested output interval. This preserves transitions and audio timing but can repeat decode/compositing work for later segments; a future optimization can render only the dependency window for each segment.
- `xfade` is used for contiguous overlapping clips on a primary video track. Independently positioned overlays use alpha fades; non-overlapping gaps remain transparent over the underlying track.
- The VFX controls are a practical FFmpeg filter pipeline, not a node-based compositor with animated keyframes, masks, motion tracking or a full ACES/OCIO colour-management pipeline.
- Character image references are persisted and passed into prompt conditioning. Actual image-to-image identity conditioning still depends on the configured ComfyUI workflow exposing compatible reference-image inputs or IP-Adapter/PuLID nodes.
- Voice IDs are passed into scene-generation voice locks and returned with extracted dialogue; the selected speech provider must expose matching voice IDs for synthesis to use them.

## 1.3.0 — Multitrack foundations, durable masters and continuity upgrade

- Added a database-backed multitrack editor UI and timeline records with revision checks, 24/25/30/50/60 fps validation, integer-frame clip positions, source FPS metadata, track kinds, transition bounds and a strict 30-clip limit.
- Added permanent generated-media ingestion into the existing S3/MinIO storage provider, SHA-256 checksums, signed asset delivery and automatic ingestion of completed ComfyUI outputs.
- Added persistent final-render job records, server-side render processing, output archival as permanent video assets, 720p/1080p/4K UHD output, higher-quality H.264 encoding, clean scene cuts, head/tail fades and render status recovery/retry in the production UI.
- Raised final-render request limit from 24 to 30 clips; requests above 30 are rejected with a clear message.
- Added ComfyUI VRAM telemetry and conservative GPU-aware generation back-pressure, including a safe one-job fallback when telemetry is unavailable.
- Added lip-sync media binding: selected permanent video/audio assets are uploaded to configured ComfyUI upload endpoints and mapped to explicit workflow loader nodes.
- Added exact screenplay speaker/dialogue extraction, character-speaker locks, dialogue language constraints and stronger location/background/wardrobe continuity prompt instructions.
- Fixed screenplay breakdown so dialogue and character cues are retained inside each scene instead of being dropped at blank-line boundaries.
- Added tests for multitrack frame validation, the 30-clip ceiling, speaker extraction and continuity prompt contracts.

### 1.3.0 boundaries

- The timeline persistence and validation layer supports multiple video/audio/title/effect tracks, but the existing FFmpeg master renderer still assembles a single ordered picture sequence with one optional soundtrack. Full track compositing, keyframes, audio buses and true crossfade/VFX graph editing remain follow-on work.
- Render jobs and outputs are durable in the database/object store, but processing is currently initiated by an authenticated server request; a separately supervised always-on worker/Temporal workflow is still required for unattended recovery of very long feature masters.
- Lip-sync input upload paths and loader input names are configurable because ComfyUI extensions differ. The workflow must expose compatible video/audio loader nodes; model weights and custom nodes remain external dependencies.
- Prompt continuity improves conditioning but cannot guarantee pixel-identical characters/backgrounds across all models. Reference images, identity adapters and trained character LoRAs remain model-dependent.
- GPU scheduling uses ComfyUI VRAM telemetry for conservative back-pressure; it does not override ComfyUI's own model placement or scheduler.


## 1.2.0 — Editorial and sound pipeline upgrade

- Added source-frame in/out points to CMX3600 EDL events and the FFmpeg renderer.
- Added `.cube` 3D LUT import and FFmpeg LUT application, alongside brightness, contrast and saturation controls.
- Added optional generated audio muxing with silence padding to avoid truncating the picture.
- Added video-to-audio extraction with FFmpeg before Whisper-compatible subtitle transcription.
- Expanded ComfyUI workflow settings for voice, music and lip-sync prompt graphs.
- Improved media filename validation and render ingestion size checks.
- Added persistent queue reconciliation, scene preview and render readiness updates.

### 1.2.0 boundaries

- Final render remains synchronous and bounded to 24 clips; no resumable background master-render worker.
- Only one generated soundtrack/dialogue job can be muxed per export.
- Lip-sync graph detection/configuration is present, but automatic source video/audio input wiring is workflow-dependent.
- Advanced VFX, crossfades, multiple audio buses, and managed-object-store archival are not yet implemented.

## 1.1.0 — Film production pipeline upgrade

- Added Prisma-backed film productions and persistent scene/audio generation jobs.
- Added authenticated ComfyUI history reconciliation and generated media preview/retrieval.
- Added scene prompt builder with global character, visual style, negative prompt and per-scene continuity controls.
- Added frame-based source trimming, 24 fps CMX3600 EDL export and FFmpeg MP4 assembly.
- Added 720p/1080p output, basic brightness/contrast/saturation grading and clip fades.
- Added optional soundtrack muxing and Whisper-compatible segment transcription with SRT export/burn-in.
- Added ComfyUI node-catalogue capability discovery for Wan, LTX, Hunyuan, audio, lip-sync and upscaling workflows.
- Added reusable film prompt templates, migration/setup documentation and production-toolkit tests.

### Known boundaries

- Final master rendering is bounded to 24 clips per request and is synchronous; it is not a resumable render worker or full nonlinear editor.
- Generated media is streamed/staged from ComfyUI and is not yet archived into managed object storage.
- Advanced VFX, transitions/crossfades, multi-bus audio, automatic lip-sync graph binding and guaranteed character identity are not included.
- Model weights, ComfyUI custom nodes and external service deployments must be installed and configured separately.
