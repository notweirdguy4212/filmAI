# filmAI Studio

![filmAI — Your story. Your vision. Your film.](images/filmai-brand-banner.svg)

**filmAI is an AI-powered creative production workspace for turning ideas into screenplays, visual worlds, generated shots and finished film projects.**

The product brings the creative workspace, project assistant, media-generation integrations, project storage and canvas together with a dedicated film production studio. Build a story, shape scenes, keep characters and locations consistent, generate media through configured workflows, then assemble and export your cut.

## The filmAI experience

- **Creative home:** a focused launchpad for starting projects, developing concepts and working with reference media.
- **Film Studio:** a dedicated cinematic workspace for screenplays, storyboards, shot direction, timelines, assets, audio and render jobs.
- **Continuity tools:** shared visual, character, voice and location bibles plus scene-level notes.
- **Generation workflows:** authenticated ComfyUI API workflows, with optional Wan 2.1 and other model workflows when separately installed and configured.
- **Production pipeline:** persistent production records, job queue, generated-media previews, asset ingestion, frame trimming, basic grading, subtitle burn-in and FFmpeg MP4 assembly.
- **Flexible deployment:** the existing Next.js application, provider integrations, project storage and self-hosted/cloud edition architecture are retained.

![filmAI brand mark](public/filmai-logo.svg)

> **Capability note:** filmAI does not bundle model weights or provider credentials. Scene generation depends on workflows and model runtimes that you configure. The current editor supports the production operations listed above; it is not a complete replacement for a professional nonlinear editor, and advanced VFX, compositing and multi-bus audio remain workflow-dependent or future work.

## Quick start

Read [the installation guide](docs/INSTALL.md) and [the original deployment/security notes](README.upstream.md) before deploying. The project expects Node.js 22+ for source development and the configured database, cache, object-storage and Temporal services.

```bash
cp .env.example .env
npm ci
npm run edition:prepare
npm run dev:infra
npm run dev:next
```

Use the documented bootstrap for database migrations, storage, Temporal workers and required secrets. Do not expose a development server directly to the public internet.

After signing in, open **filmAI Studio** from the creative home or visit `/<locale>/film-studio` (for example `/en/film-studio`). Film production APIs require an authenticated session.

## Connect a generation engine

### ComfyUI

Start the included ComfyUI source using its official installation instructions and a compatible Python/PyTorch build. Configure its trusted API endpoint on the filmAI application server:

```dotenv
FILMAI_COMFYUI_URL=http://127.0.0.1:8188
```

Restart filmAI, open **Engine settings** in Film Studio, and paste a ComfyUI workflow exported in **API format**. Optionally select the prompt node ID and input key. Keep ComfyUI on a trusted private interface; do not expose its unauthenticated API publicly.

### Wan 2.1 and other workflows

The Wan 2.1 inference source is retained under `engines/wan2.1`; model weights are not included. Follow that engine's README and install guide for model downloads and hardware requirements. Wan, LTX-Video, Hunyuan, image, audio, speech and lip-sync workflows depend on the nodes and models installed in your configured runtime.

## Typical production flow

1. Start a project and write or import a screenplay.
2. Break the script into editable scenes and refine each scene's visual direction.
3. Define character, location, voice and visual continuity notes.
4. Configure one or more API-format generation workflows and queue scene, audio or voice jobs.
5. Review generated outputs, ingest assets into the production library and arrange clips on the timeline.
6. Trim source frames, apply supported finishing controls, choose audio and render an H.264 MP4.
7. Generate timestamped subtitles through a configured Whisper-compatible endpoint and optionally burn them into the final render.

## Configuration

| Variable | Purpose |
|---|---|
| `FILMAI_COMFYUI_URL` | Trusted ComfyUI API base URL |
| `FILMAI_WHISPER_URL` | OpenAI-compatible transcription endpoint supporting timestamped segments |
| `FILMAI_WHISPER_MODEL` | Transcription model name (defaults to `whisper-1`) |
| `FILMAI_WHISPER_API_KEY` | Optional server-side transcription bearer token |

Keep model services on trusted private interfaces and API keys server-side. The browser does not accept arbitrary provider URLs.

## Verification

```bash
npm run typecheck
npm run lint -- src/features/film-studio src/app/api/film-studio
npx vitest run tests/unit/film-studio
```

End-to-end generation, media retrieval, transcription and MP4 rendering require authenticated application services plus the relevant ComfyUI, Whisper and FFmpeg runtimes.

## Project structure

- `src/features/film-studio` — film production UI and workflow logic
- `src/app/api/film-studio` — authenticated production, generation, asset and render APIs
- `public/filmai-logo.svg` and `public/filmai-icon.svg` — primary brand assets
- `public/filmai-banner.svg` and `images/filmai-brand-banner.svg` — filmAI banner artwork
- `docs/film-studio` — production pipeline and integration documentation
- `engines/comfyui` and `engines/wan2.1` — optional generation engine sources

## Brand assets

The repository includes the filmAI logo, icon, animated in-app mark and a scalable banner. The interface uses a cinematic midnight palette with cyan, electric blue and violet accents. No QR codes or third-party community QR images are used in the project README.

## Licences and upstream components

This distribution retains third-party source and licence files. See the root `LICENSE`, `README.upstream.md`, `engines/comfyui/LICENSE` and `engines/wan2.1/LICENSE.txt`. Respect upstream code licences, model licences, provider terms and usage restrictions. Inclusion of inference code does not grant rights to model weights or training data.
