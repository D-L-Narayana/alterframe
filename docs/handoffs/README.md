# Historical build notes (0.1)

The files in this folder (`W1.md` … `W10.md` and the `w*-shots` screenshots of our own dev
harnesses) are the hand-off notes written by the ten module builders of the first release in
October 2026. They are kept verbatim as a record of the decisions taken while the modules were
built in parallel — selector contracts, coordinate conventions, known gaps at the time, and the
requests that were later folded into `docs/contract-changes.md`.

They are **not maintained**. For the current description of every module, its public API and the
conventions it relies on, read [`../modules.md`](../modules.md); for the data flow, [`../architecture.md`](../architecture.md);
for how things are tested, [`../testing.md`](../testing.md). Worker labels (W1 … W10) in these
notes refer to the module ownership table that used to live in `src/OWNERS.md`; the mapping is
app/ui/state → W1, media/runtime → W2, tracking → W3, render/core → W4, shaders/styles → W5,
persona → W6, interaction → W7, hud → W8, capture/perf → W9, QA/infra/docs → W10.

Repository hygiene rules exempt this folder from the "no references to retired internal planning
documents" check so the notes can stay as they were written; everywhere else those references
must not appear.
