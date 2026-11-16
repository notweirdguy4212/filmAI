# Optional generation engines

- `comfyui/` — ComfyUI source. Run as a separate local service and set `FILMAI_COMFYUI_URL` in the filmAI server environment.
- `wan2.1/` — Wan 2.1 inference source. Weights and compatible runtime dependencies must be installed separately. Wan can be exposed to filmAI through a ComfyUI workflow or a separately operated runner.

These engines are separate processes; filmAI does not install model weights or start GPU workloads implicitly. Review each engine's own README, license and security guidance before enabling it.
