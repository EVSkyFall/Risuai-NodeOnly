---
schema_version: 1
gate: 4d
status_enum: [core-4d, core-earlier, joint-required, manual-smoke]
---

# Gate 4d acceptance coverage

The status describes the **whole row**, not just its Core half. A `joint-required`
row remains joint even when this suite proves its durable Core boundary.

## Counts

| Scope | core-4d | core-earlier | joint-required | manual-smoke | Total |
|---|---:|---:|---:|---:|---:|
| §5 shared fixtures | 5 | 1 | 0 | 0 | 6 |
| §5 targeted items 1–11 | 3 | 0 | 8 | 0 | 11 |
| §20 acceptance rows | 11 | 39 | 9 | 0 | 59 |
| Paid provider smoke gate | 0 | 0 | 0 | 1 | 1 |
| **All mapped rows** | **19** | **40** | **17** | **1** | **77** |

## §5 shared fixtures

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| SF-01 | Exact marker plus slot attribute order and closing form | core-4d | `acceptance/sharedFixtures.test.ts::pins production control nodes while distinguishing the parser superset` |
| SF-02 | Actual production 32-hex nonce/token and `job_` ID | core-4d | `acceptance/sharedFixtures.test.ts::pins production control nodes while distinguishing the parser superset`; `acceptance/coreFlows.test.ts::drains 15 bridge-created jobs exactly once and finalizes the parent live` |
| SF-03 | Positive/negative UTF-8 16384 accepted, 16385 rejected | core-4d | `acceptance/coreFlows.test.ts::accepts 16384 UTF-8 bytes and rejects 16385 for both prompt fields through the bridge` |
| SF-04 | Full Core terminal/dashboard-outstanding classification | core-4d | `acceptance/sharedFixtures.test.ts::pins the complete job-state terminal and dashboard-outstanding table` |
| SF-05 | Production name plus final script hash | core-4d | `acceptance/sharedFixtures.test.ts::pins the production plugin name and final script digest through authorization` |
| SF-06 | Wrong name/hash, duplicate name, permission-only, guessed `_ij*` rejected | core-earlier | `v3Bridge.test.ts::requires exact name, V3 version, pinned script digest, and a unique persisted name`; `v3Bridge.test.ts::does not construct roots or aliases when authorization is absent` |

## §5 targeted fake-provider items

| ID | Acceptance row | Status | Evidence / why joint |
|---|---|---|---|
| §5-01 | 10k-token RP, auto-continue twice, Planner once, Tagger 15 times | joint-required | Core halves: `acceptance/coreFlows.test.ts::records exactly one terminal root turn and records none for abort`; `::drains 15 bridge-created jobs exactly once and finalizes the parent live`. Planner/Tagger scheduling counts require the live Plugin actor. |
| §5-02 | Global C1 before first successful Tagger, then global C2 | joint-required | The canary transition and cross-runtime Tagger scheduler are Plugin-owned. |
| §5-03 | Ready prompt plus active reservation HWM2 | joint-required | Backpressure/reservation accounting is Plugin-owned. |
| §5-04 | NAI global C1; 15 job/asset/inlay exactly once | core-4d | `acceptance/coreFlows.test.ts::drains 15 bridge-created jobs exactly once and finalizes the parent live`; server C1 foundation: `server/node/naiImageBroker.test.ts::keeps maxActive at one across 15 background and interleaved interactive calls` |
| §5-05 | Event loss plus Plugin reload; Planner re-call zero | joint-required | Core half: `acceptance/coreFlows.test.ts::reconciles durable jobs after actor reload without re-planning or duplication`. The real Plugin's polling/reload scheduler must prove Planner count zero. |
| §5-06 | Successor stays standby while owner unloads | joint-required | Core drain primitive: `v3Bridge.test.ts::feature OFF and unload durably drain, clean subscriptions, and release once active work settles`. Standby behavior needs two live Plugin instances. |
| §5-07 | Feature OFF versus renew; no late/new cost work | joint-required | Core half: `acceptance/coreFlows.test.ts::converges feature OFF against an in-flight host LLM and releases once`. Plugin invalidation and late-result suppression remain joint. |
| §5-08 | OFF RPC reject keeps owner until Core OFF confirmation | joint-required | `feature_off_pending`, retry, renew, and release timing are Plugin-owned. |
| §5-09 | Failure-report reject plus takeover journal blocks auto LLM until local retry | joint-required | Core durable failure primitives: `agentFailure.test.ts::increments retryable failures, deduplicates lost ACK, and preserves count through retry`. Shared Plugin journal reload is joint. |
| §5-10 | Source edit / slot delete causes zero further provider calls | core-4d | `acceptance/coreFlows.test.ts::stales every remaining sibling after a mid-batch body edit with no further provider calls`; `::stales a deleted slot before dispatch with zero provider calls` |
| §5-11 | NAI socket reset becomes uncertain; no auto-retry | core-4d | `acceptance/coreFlows.test.ts::holds a socket reset uncertain until one confirmed retry with a fresh deterministic asset` |

## §20 Finalization and asynchronous UX

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| F-01 | No Planner/Tagger/NAI during 10k-token streaming | joint-required | `terminalCapture.test.ts::ignores recursive, aborted, and failed exits` pins the Core boundary; live streaming plus Plugin scheduling is required. |
| F-02 | Two auto-continues produce one root request | core-4d | `acceptance/coreFlows.test.ts::records exactly one terminal root turn and records none for abort` |
| F-03 | Resend registers only the final normal response | core-earlier | `terminalCapture.test.ts::dispatches once while registration hangs, snapshots text, and stays done after success`; `coordinator.test.ts::returns the existing turn on a sequential registration replay` |
| F-04 | Emotion embedding and emotion-LLM early exits each register once | core-4d | `acceptance/processFinalization.test.ts::captures the root turn through the real emotion-embedding sendChat exit`; `::captures the root turn through the real emotion-LLM sendChat exit` |
| F-05 | Aborted/failed streams create zero turns/jobs | core-4d | `acceptance/coreFlows.test.ts::records exactly one terminal root turn and records none for abort`; failed exit foundation: `terminalCapture.test.ts::ignores recursive, aborted, and failed exits` |
| F-06 | Initial RP body display does not await Planner/Tagger/image | joint-required | Requires live UI timing with the Plugin actor. |
| F-07 | Feature OFF has no marker/ledger/API side effect | core-earlier | `terminalCapture.test.ts::feature OFF has no registration or ID-minting side effects`; `bootstrap.test.ts::does not load recovery or executor while the feature is OFF` |
| F-08 | Initial hidden-request strict flush failure causes zero LLM/NAI | joint-required | Core failure boundary: `coordinator.test.ts::leaves blocked_capture after strict failure without retrying the marker`. Proving Plugin cost calls remain zero is joint. |

## §20 Manifest, API, and prompt hygiene

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| M-01 | Crash at any of 15 record writes recovers without duplicate/missing/re-plan | core-earlier | `store.test.ts::recovers missing records and rebuilds the index after a partial storage failure`; `recovery.test.ts::rebuilds jobs after a crash between manifest record writes`; `store.test.ts::accepts 15 jobs and rejects the 16th before writing` |
| M-02 | `submitPlan`/`supplyPrompt` replay is idempotent | core-earlier | `coordinator.test.ts::returns the existing jobs for an identical submitPlan replay`; `coordinator.test.ts::returns the queued job for an identical supplyPrompt replay` |
| M-03 | Slot 16, oversized prompt, invalid version/lease/state reject before cost work | core-4d | Exact bridge byte boundary: `acceptance/coreFlows.test.ts::accepts 16384 UTF-8 bytes and rejects 16385 for both prompt fields through the bridge`; `coordinator.test.ts::rejects a sixteenth slot and invalid UTF-16 offsets before any chat write`; `store.test.ts::rejects wrong coordinator lease and fence on every claim/plan/prompt CAS` |
| M-04 | Literal copied marker cannot create a job | core-4d | `acceptance/coreFlows.test.ts::strips copied production control nodes without creating forged jobs` |
| M-05 | Main/continue/memory/Hypa/Lightboard/Plugin prompts contain no controls | joint-required | Core transform: `controlNodes.test.ts::strips prompt message copies without mutating inputs and preserves the no-node fast path`. Full Lightboard/Plugin transport needs the live module and Plugin. |
| M-06 | Event loss / Plugin reload recovers by snapshot | joint-required | Core half: `acceptance/coreFlows.test.ts::reconciles durable jobs after actor reload without re-planning or duplication`. Live Plugin polling reconciliation remains joint. |
| M-07 | Late Tagger lease rejects; durable queued prompt runs pluginless | core-earlier | `store.test.ts::accepts an exact holder lost-ACK replay after expiry but not changed provenance`; `executor.test.ts::wakes from a durable prompt handoff without an explicit poke` |
| M-08 | Two tabs claim once and start one Tagger LLM | joint-required | Core claim exclusion: `store.test.ts::claims, renews, rejects an active rival, and fences an expired holder`. The one-LLM scheduler assertion is Plugin-owned. |
| M-09 | Expired holder is reclaimable; old `supplyPrompt` rejects | core-earlier | `store.test.ts::claims, renews, rejects an active rival, and fences an expired holder`; `store.test.ts::renews an expired same bearer as a fenced reclaim` |
| M-10 | Old fence rejects `submitPlan`/`supplyPrompt` after reclaim | core-earlier | `store.test.ts::rejects wrong coordinator lease and fence on every claim/plan/prompt CAS` |
| M-11 | Non-owner snapshots hide bearer lease IDs | core-earlier | `v3Bridge.test.ts::injects the host runtime identity and returns bearer-free ownership views`; `coordinatorRecord.test.ts::claims, renews without a fence bump, rejects a rival without bearer leakage, and expires at 60s` |
| M-12 | Plugin uses exact snapshot source across chat/character switches | joint-required | Core snapshots expose the source; consumption and Planner offsets are Plugin-owned. |
| M-13 | Plugin reload resumes Tagger from durable `scenePayload` without Planner | joint-required | Core half: `acceptance/coreFlows.test.ts::reconciles durable jobs after actor reload without re-planning or duplication`; immutability: `store.test.ts::does not allow a transition patch to rewrite manifest scenePayload`. |
| M-14 | Unfinalized/test Plugin identity keeps capability and feature OFF | core-earlier | `v3Bridge.test.ts::requires exact name, V3 version, pinned script digest, and a unique persisted name`; `v3Bridge.test.ts::does not construct roots or aliases when authorization is absent`; `featureFlag.test.ts::defaults off and persists explicit changes` |

## §20 NAI C=1 and priority

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| N-01 | 15 background plus manual/Lua/trigger mix has `maxActive === 1` | core-earlier | `server/node/naiImageBroker.test.ts::keeps maxActive at one across 15 background and interleaved interactive calls` |
| N-02 | Manual request takes the next slot before queued background | core-earlier | `server/node/naiImageBroker.test.ts::starts every queued interactive call before any queued background call` |
| N-03 | Two tabs seeing one job produce one claim/provider call | core-earlier | `store.test.ts::claims, renews, rejects an active rival, and fences an expired holder`; `executor.test.ts::starts idempotently with one epoch, one provider call, and a releasable lock` |
| N-04 | Disconnected `/proxy2` body settles before next dispatch | core-earlier | `server/node/naiImageBroker.test.ts::does not dispatch the next call until a disconnected client has aborted and settled upstream` |
| N-05 | Active-lease write failure makes zero upstream calls | core-earlier | `server/node/naiImageBroker.test.ts::makes zero upstream calls when the durable lease write fails and releases the permit` |
| N-06 | Crash after lease ACK boots into hold/cooldown | core-earlier | `server/node/naiImageBroker.test.ts::enters cooldown after SIGKILL leaves an acknowledged active lease` |
| N-07 | Missing broker/Web Locks or ambiguous lease fails closed | core-4d | New ambiguous-lease row: `server/node/naiImageBroker.test.ts::holds an agentic request when the persisted active lease is ambiguous`; Web Locks: `store.test.ts::rejects every public store operation when Web Locks are unavailable` |
| N-08 | Fingerprint drift blocks remaining jobs | core-earlier | `executor.test.ts::blocks on fingerprint drift and resumes only after restoration and target CAS` |
| N-09 | Restored settings plus valid anchor/source resumes queued | core-earlier | `executor.test.ts::blocks on fingerprint drift and resumes only after restoration and target CAS` |
| N-10 | Restart exposes UNKNOWN cooldown instead of claiming active status | core-earlier | `server/node/naiImageBroker.test.ts::holds queued requests during a fresh boot cooldown and exposes the hold state`; SIGKILL test above |

## §20 Target, edit, reroll, and swipe

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| T-01 | After first commit, remaining 14 normalized source hashes remain valid | core-4d | `acceptance/coreFlows.test.ts::drains 15 bridge-created jobs exactly once and finalizes the parent live`; `sourceHash.test.ts::is invariant when a turn slot becomes its committed native inlay` |
| T-02 | Body edit makes remaining jobs stale with no new provider call | core-4d | `acceptance/coreFlows.test.ts::stales every remaining sibling after a mid-batch body edit with no further provider calls` |
| T-03 | Deleted unstarted slot makes zero provider calls | core-4d | `acceptance/coreFlows.test.ts::stales a deleted slot before dispatch with zero provider calls` |
| T-04 | Character/chat switch still writes original target and metadata | core-earlier | `inlays.test.ts::uses an explicit target and preserves active-chat inference when target is absent`; executor passes the captured target. |
| T-05 | Active swipe updates `data + swipes[i]` | core-earlier | `executor.test.ts::patches both mirrors when the captured swipe remains active` |
| T-06 | Inactive swipe updates only `swipes[i]` | core-earlier | `executor.test.ts::commits an inactive swipe without changing the active data mirror` |
| T-07 | Swipe-index shift updates only the exact anchor variant | core-earlier | `anchors.test.ts::still finds the exact-token variant after swipe indices shift` |
| T-08 | Reroll-copy to a new `Message.chatId` cannot inherit the old job | core-earlier | `anchors.test.ts::gives the foreign-message fence priority even when the expected message also has the token`; `anchors.test.ts::classifies a token found only under another Message.chatId as stale` |
| T-09 | Token duplicated across logical variants is corrupt | core-earlier | `anchors.test.ts::treats the same token in distinct logical swipes as corrupt`; `recovery.test.ts::marks duplicate asset references across logical variants corrupt` |
| T-10 | Lazy hydration commits to exact `Chat.id` | core-earlier | `executor.test.ts::re-finds the exact Chat.id after hydration moves its array index` |

## §20 Crash, storage, and cancel

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| C-01 | Queued survives restart and resumes | core-earlier | `recovery.test.ts::leaves a valid queued job queued for the executor without dispatching it`; `bootstrap.test.ts::waits for recovery to finish before loading and starting the executor` |
| C-02 | Interrupted generating without asset becomes uncertain, no auto-call | core-4d | `acceptance/coreFlows.test.ts::holds a socket reset uncertain until one confirmed retry with a fresh deterministic asset`; `recovery.test.ts::settles an interrupted generating attempt as uncertain without provider work` |
| C-03 | Explicit provider reject maps to failed | core-earlier | `executor.test.ts::maps definite and uncertain results without blind retry` |
| C-04 | Actual-only asset repairs info/meta without provider | core-earlier | `recovery.test.ts::repairs a partial asset record before committing`; `inlays.test.ts::repairs missing info and meta from actual storage with the expected target` |
| C-05 | Invalid/onerror/timeout/null blob releases permit and queue continues | core-earlier | `inlays.test.ts::rejects with a typed error when image loading fails and clears its timer`; `::rejects with a typed error after the decode timeout without leaving a timer`; `::rejects with a typed error when canvas encoding returns null`; executor continuation is covered by its terminal-settlement pump tests. |
| C-06 | Crash after asset write recovers by deterministic ID | core-earlier | `recovery.test.ts::recovers a complete deterministic asset from generating without provider work` |
| C-07 | Crash after chat patch reconciles provider-free | core-earlier | `recovery.test.ts::reconciles an exact asset reference to committed` |
| C-08 | Strict flush failure never produces committed | core-earlier | `executor.test.ts::leaves a patched job committing when strict flush fails` |
| C-09 | Durable asset ref plus committing becomes committed provider-free | core-earlier | `recovery.test.ts::reconciles an exact asset reference to committed` |
| C-10 | Generating cancel is not immediately done and never inserts returned asset | core-earlier | `executor.test.ts::retains a successful asset after generating cancel and skips chat commit` |
| C-11 | Cancel disconnect is uncertain; success bytes persist then cancel | core-earlier | `executor.test.ts::preserves asset-write uncertainty when cancel wins its version race`; `executor.test.ts::retains a successful asset after generating cancel and skips chat commit` |
| C-12 | Cancel survives crashes at `asset_writing` and `asset_ready` | core-earlier | `recovery.test.ts::finishes asset integrity then cancels an asset_writing job with durable cancel intent`; `recovery.test.ts::honors durable cancel intent after a second crash at asset_ready` |
| C-13 | Manual uncertain retry requires charge confirmation and fresh IDs | core-4d | `acceptance/coreFlows.test.ts::holds a socket reset uncertain until one confirmed retry with a fresh deterministic asset`; `store.test.ts::requires confirmation and creates fresh attempt, asset, and idempotency identifiers` |
| C-14 | Automatic GC does not delete inactive/other-chat inlays | core-earlier | The implementation has no automatic inlay-asset janitor; deletion is explicit. `inlays.test.ts::asset is always null after removal` pins explicit removal, while `store.test.ts::deletes old prunable jobs within the bound and protects active and uncertain jobs` pins metadata-only pruning boundaries. |

## §20 Security and preservation

| ID | Acceptance row | Status | Evidence / boundary |
|---|---|---|---|
| S-01 | Authorization/reference base64 absent from console/fetch logs | core-earlier | `v3Bridge.test.ts::maps every stable code without echoing payloads or logging RPC values`; `server/node/naiImageBroker.test.ts::strips local metadata, preserves provider auth, and never logs request sentinels` |
| S-02 | Terminal metadata GC protects active/recoverable records | core-earlier | `store.test.ts::deletes old prunable jobs within the bound and protects active and uncertain jobs`; `store.test.ts::lists Agent-blocked turns and never prunes blocked turn or job records` |
| S-03 | 100+ history status display causes no reload/persistent-save loop | joint-required | Core payload bound: `store.test.ts::returns all live and uncertain jobs plus only 50 sanitized recent terminal summaries`; `store.test.ts::keeps a 200-turn by 15-job terminal history well under 1 MiB`. Display/reconcile side effects are Plugin/dashboard-owned. |

## Explicit joint-required list

- §5-01, §5-02, §5-03, §5-05, §5-06, §5-07, §5-08, §5-09
- §20 F-01, F-06, F-08, M-05, M-06, M-08, M-12, M-13, S-03

## Manual smoke gate

| ID | Acceptance row | Status | Boundary |
|---|---|---|---|
| SMOKE-01 | One real paid provider image | manual-smoke | Run only after both fake suites pass and the user gives separate explicit approval. No real provider call belongs in Gate 4d automation. |
