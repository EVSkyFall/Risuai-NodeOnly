# Comfy test fixtures

Real ComfyUI API-format graphs, checked in so the registration and
instantiation pins run against workflows people actually ship rather than
against shapes we invented. None of them is a runtime template — the templates
the server serves live in `server/node/comfy/templates/`.

## `DasiwaMinimaxH3WorkflowsT2VA_cMMH3V11_FL2VA.min.json`
## `DasiwaMinimaxH3WorkflowsT2VA_cMMH3V16_REF2VA.min.json`

Upstream: **DaSiWa MiniMax H3 Workflows** (`MiniMaxH3Director` +
`DaSiWa_EnhancedVideoCombine` node packs), supplied by the user from their own
ComfyUI install. Both are **sanitized** exports, minified, kept only for what
the pins need:

- V11 FL2VA is the older two-keyframe preset. It still carries `{{positive}}`
  inside the Director's `timeline_data` and `builder_state` strings, which is
  precisely why it pins the embedded-JSON slot machinery and the
  unknown-placeholder warnings.
- V16 REF2VA is the unified-checkpoint preset, all 32 nodes intact, with the
  Director's three authored inputs normalized: `prompt` to `{{positive}}`,
  `timeline_data` to the direct `{{timeline}}` token, `builder_state` to `"{}"`.
  That alone takes the export from 316 KB to 6 KB, because the builder's
  `thumbnail` and `waveform_peaks` blobs — 288 KB and 8.5 KB of base64 UI
  payload — lived inside the `timeline_data` string the token replaces. It is
  the reference for registration against a graph with **zero LoadImage nodes**.

The vendor's unsanitized V16 export (the ground truth for the `timeline_data`
slot address space — images 0..8, videos 9..11, audio 0..2) is not checked in;
it lives outside the repo with the round's design notes.

## `Wan_workflow_api.json`
## `Wan_workflow_flf2v.json`

Retained WAN source workflows. `templateBuild.test.ts` builds the shipped
`wan-i2v` and `wan22-flf2v-loop` templates from these and asserts the tuning
never drifts, so they are the "before" side of that comparison rather than
inputs to the registration path.
