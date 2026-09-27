# World Lab screenshots

The root README uses screenshots of the current zero-swarm interface:

- `world-lab-live.png`: Live workspace, 1600 × 1000.
- `world-lab-agents.png`: Agents workspace, 1600 × 1000.

Captured from the local application using `HEXZERO_PROVIDER=scripted`. The
provider labels and usage describe deterministic fixture decisions, not a real
model evaluation. The map uses standard OpenStreetMap tiles with a dark
MapLibre raster treatment and visible OpenStreetMap attribution. No provider
keys or private reasoning are shown.

To refresh, start `pnpm dev:test-provider`, open the World Lab in a clean browser
profile at the viewport size above, advance six ticks with **Single tick**, and
select **Scoreboard** in Live before capturing. Then switch to **Agents** and
capture that workspace. Use only scripted provider calls for screenshots.
Preserve map attribution and capture the actual interface without adding mock
controls or model results.
