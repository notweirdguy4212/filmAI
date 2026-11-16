# filmAI Studio

**A cinematic AI filmmaking workspace for developing stories, generating scenes, and assembling film projects.**

filmAI Studio combines the existing creative workspace, assistant, media-generation adapters, project storage and canvas architecture with an editorial production workspace. The included ComfyUI and Wan 2.1 source trees provide optional local generation engines. Existing application services and provider integrations are retained rather than replaced with a second application stack.

> **Important capability boundary:** the studio does not bundle model weights or provider credentials and is not a full nonlinear editor. Scene generation runs through configured ComfyUI workflows; Wan 2.1 requires separately downloaded weights and a supported GPU/runtime. FFmpeg provides bounded MP4 assembly, source-frame trimming, basic grading, optional 3D LUTs, one audio track and subtitle burn-in. Advanced VFX, multitrack mixing and automatic lip-sync input wiring remain workflow-dependent.

## What's included

- Existing Next.js creative workspace, project assistant, project/resource APIs, provider registry, canvas, task execution, storage and deployment editions.
- Dedicated dark cinematic film production workspace at `/<locale>/film-studio`.
- Screenplay editor, project metadata, screenplay scene breakdown, editable scene cards and planned scene durations.
- Scene-by-scene ComfyUI API workflow submission with positive/negative prompt injection, global character and visual bibles, per-scene continuity notes and node-catalogue capability discovery.
- Database-backed `FilmProduction` and `FilmProductionJob` records, debounced server autosave, provider-history reconciliation and durable generation state.
- Authenticated generated-media preview/streaming from ComfyUI outputs, including scene video and audio job outputs.
- Frame-based clip trim controls, CMX3600 EDL export, basic brightness/contrast/saturation grading, clip fades and FFmpeg H.264 MP4 assembly.
- Optional audio-track selection and final muxing, plus Whisper-compatible segment-timed subtitle transcription and SRT burn-in.
- Music and voice generation through user-supplied ComfyUI API workflows; optional lip-sync, Wan, LTX, Hunyuan and audio node capability discovery.
- Included ComfyUI source under `engines/comfyui` and Wan 2.1 inference source under `engines/wan2.1`.

## Quick start

This repository retains the upstream self-hosted Docker and source-development workflows. Read the full original installation and security instructions in [README.upstream.md](README.upstream.md) and [docs/INSTALL.md](docs/INSTALL.md) before deploying.

For local source development, the existing project expects Node.js 22+, the configured database/cache/object-storage services, and its normal environment setup:

```bash
cp .env.example .env
npm ci
npm run edition:prepare
npm run dev:infra
npm run dev:next
```

Use the existing documented bootstrap for database migrations, storage, Temporal workers and required secrets. Do not expose the development server directly to the public internet.

Open the app, sign in, then choose **Open filmAI Studio** or navigate to `/<locale>/film-studio` (for example `/en/film-studio`). The filmmaking APIs require an authenticated session.

## Connect ComfyUI

Start the included ComfyUI source using its official install instructions and compatible Python/PyTorch build. Configure its API endpoint on the filmAI application server:

```dotenv
FILMAI_COMFYUI_URL=http://127.0.0.1:8188
```

Restart the filmAI server and open **Engine settings** in filmAI Studio. Export a workflow from ComfyUI in **API format**, paste its JSON, and optionally enter the prompt node ID and input key (commonly `text` or `prompt`, depending on the node). The scene description is inserted into that input before the workflow is queued. If no prompt node is selected, the workflow is submitted unchanged.

The application proxies `/system_stats`, `/prompt` and `/history/{prompt_id}` through authenticated server routes. It does not accept an arbitrary endpoint from the browser, which avoids turning the API into a general-purpose SSRF proxy. Keep ComfyUI bound to a trusted local/private interface and do not expose its unauthenticated API to the public internet.

## Wan 2.1

The Wan 2.1 inference source is retained in `engines/wan2.1`. Model weights are not included. Follow `engines/wan2.1/README.md` and `engines/wan2.1/INSTALL.md` for compatible dependencies, model downloads and inference commands. Wan workflows can also be run through ComfyUI after installing the matching Wan nodes and model files. Hardware requirements vary significantly by model size, precision, resolution and offloading configuration; do not assume a 14B model will fit a consumer GPU.

## Production workflow

1. Write or import a screenplay and split it into editable `INT.` / `EXT.` scenes.
2. Define a **character continuity bible**, global visual style and negative prompt. These are injected into every scene prompt; per-scene continuity notes can add shot-specific constraints.
3. Configure one or more ComfyUI API-format workflows. Wan, LTX-Video, Hunyuan, image, audio, speech and lip-sync workflows are selected by the node graph you install and provide. The engine page inspects `/object_info` and reports compatible node families it can detect.
4. Queue individual scenes, music or voice jobs. The application records prompt, workflow, provider job ID, status, outputs and errors in `film_productions` / `film_production_jobs`.
5. Refresh the queue to reconcile active jobs with ComfyUI history. Completed video outputs are automatically surfaced in scene cards through an authenticated media proxy; audio outputs can be opened from the queue.
6. Set source-frame in/out points, choose 720p or 1080p, adjust brightness / contrast / saturation, select a completed soundtrack, and render an H.264 MP4 with FFmpeg. Each clip is normalized to the chosen frame rate and resolution, receives short fades, and is concatenated in scene order.
7. For speech-timed subtitles, configure a Whisper-compatible endpoint, upload the film audio/video, and generate segment-timed SRT captions. If present, the SRT can be burned into the final MP4.

## Configuration

| Variable | Purpose |
|---|---|
| `FILMAI_COMFYUI_URL` | Trusted ComfyUI API base URL, e.g. `http://127.0.0.1:8188` |
| `FILMAI_WHISPER_URL` | OpenAI-compatible `/audio/transcriptions` endpoint that supports `verbose_json` and segment timestamps |
| `FILMAI_WHISPER_MODEL` | Transcription model name; defaults to `whisper-1` |
| `FILMAI_WHISPER_API_KEY` | Optional server-side bearer token for the transcription service |

Keep ComfyUI and model services on trusted private interfaces. API keys remain server-side. The film editor never accepts an arbitrary provider URL from the browser.

## Persistence, verification and current limits

- Screenplay, scene metadata, continuity prompts, workflow JSON and production settings autosave locally and synchronize to the authenticated MySQL/Prisma production record. The render queue is durable in the database rather than browser-only.
- ComfyUI output references are persisted with job records and proxied after completion. The current implementation does not copy every provider file into MinIO; the provider's output storage must remain available for previews and rendering.
- Final MP4 assembly is a real FFmpeg render, not an EDL-only placeholder. It supports up to 24 completed clips per synchronous request, source-frame in/out points, 720p/1080p normalization, basic brightness/contrast/saturation, `.cube` 3D LUT looks, fade-to-black transitions, one audio track and SRT burn-in.
- Audio selection currently supports one completed generated soundtrack/dialogue job per final render. Advanced multitrack mixing, crossfades, keyframed grading, compositing, motion graphics and plugin-host execution remain future work.
- Voice and music generation are submitted through user-configured ComfyUI workflows. Install the matching audio/speech models and ensure the workflow saves audio outputs. Lip-sync node families are detected, but fully automatic source-video/audio wiring still depends on the workflow's input nodes.
- Automatic subtitles require a Whisper-compatible endpoint returning timestamped segments. The app exports SRT and can burn those captions into the final render; it does not silently fabricate timestamps when the provider returns text only.
- Character consistency is reinforced through a shared prompt bible and per-scene continuity notes. Actual identity persistence still depends on reference-image conditioning, character LoRAs, IP-Adapter or other capabilities in the selected generation model/workflow.
- Scene breakdown remains a heading-based parser, not a screenplay-understanding model. GPU scheduling and model memory use are managed by the configured model runtimes (primarily ComfyUI), not by a new universal GPU scheduler.

## Verification

```bash
npm run typecheck
npm run lint -- src/features/film-studio src/app/api/film-studio
npx vitest run tests/unit/film-studio
```

The full upstream test suites and service setup are documented in the original project documentation. End-to-end generation, media retrieval, transcription and MP4 rendering require authenticated application services plus the relevant ComfyUI / Whisper / FFmpeg runtimes.

## Source projects and licenses

This distribution preserves the source projects and their license files:

- The original filmAI creative application source and its upstream documentation are retained in this repository; see the root `LICENSE` and `README.upstream.md`.
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) source is included under `engines/comfyui`; see `engines/comfyui/LICENSE`.
- [Wan 2.1](https://github.com/Wan-Video/Wan2.1) inference source is included under `engines/wan2.1`; see `engines/wan2.1/LICENSE.txt`.

Respect each upstream project's license, model licenses, provider terms and usage restrictions. Inclusion of inference code does not grant rights to model weights or generated training data.

## filmAI Studio production pipeline (v1.2)

The filmmaking workspace now includes durable production records and a database-backed ComfyUI job queue, authenticated generated-output retrieval, source-frame trimming, bounded FFmpeg MP4 assembly, basic colour controls and optional 3D LUT looks, optional soundtrack muxing, video-to-audio extraction for Whisper-compatible timed transcription, SRT burn-in, character/visual continuity prompt bibles and source-aware CMX3600 EDL export. Existing ComfyUI and bundled Wan 2.1 source integrations are retained.

If the v1.1 production migration has not already been applied, run `npx prisma migrate deploy` and `npx prisma generate` before first use. No new database migration is required for v1.2. See [`docs/film-studio/production-pipeline-v1.2.md`](docs/film-studio/production-pipeline-v1.2.md) for setup, supported integration boundaries, workflow configuration and reusable film prompts.

**Scope note:** final MP4 assembly is functional for the bounded workflow described above, but it is not a full NLE. Advanced VFX, crossfades, multiple audio buses, automated lip-sync graph binding, long-running resumable renders and persistent final-render history remain future work. Generated source media is staged temporarily from ComfyUI and is not yet archived in managed object storage.

## filmAI Studio 1.3.0

See [`docs/film-studio/production-pipeline-v1.3.md`](docs/film-studio/production-pipeline-v1.3.md) for the persistent timeline, asset ingestion, render queue, GPU scheduling, lip-sync binding and continuity upgrade.
