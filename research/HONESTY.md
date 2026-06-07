# HONESTY.md

> Mandatory disclosure for the hackathon. This file lives at the root of your repository. Judges cross-check it against your code and your technical video.
>
> **The deal:** disclosed shortcuts are **not** penalized — that is the entire point of this file. Hidden ones are. Undisclosed pre-built code is heavily penalized, each undisclosed mock carries a small penalty, and a faked demo is heavily penalized. Telling the truth here costs you nothing.

---

## 1. Team — who did what
Judges compare this against `git shortlog -sn`, so keep it honest.

| Member | GitHub handle | Main contributions |
|---|---|---|
| Christiana Constantina | bristiana | Business: idea, use case evaluation and interviewing, tema coordination, pitch |
| Bogdan Caraeane | Bogdan-ca | System 3: dashboard, user interaction, restricted area management, integration with unity simulation and camera detection system  |
| Marius Manae | Marius0G | System 5: unity simulation with full rendering of HK City, integration live system 1 camera detection systems inside the simulation, addition of a controllable drone inside the simulation |
| Filipp Trigub | FilippTrigub | System 1, 2 & 4: drone detection system for the camera, data processing and position triangulation, tracking system; fine-tuning of a YOLOv11 with datasets from Zhejiang university for small object detection 

---

## 2. What is fully working
Features that run end-to-end on the live app, with real data and real logic. Be specific: name the feature, what input it takes, what output it produces.

- **Drone detection (System 1)**: Reads RTSP video streams from Unity simulator or physical cameras, runs YOLOv8/11 inference on each frame, converts bounding-box detections to 3D ENU bearing vectors, POSTs detection events to System 2. Verified via E2E test and live runs.
- **GPS triangulation (System 2)**: Receives bearing vectors from System 1, buffers them per-camera, runs skew-line midpoint triangulation every 500 ms across all camera pairs, converts ENU intersections to WGS84 lat/lon/alt, writes to `positions` table in Azure PostgreSQL. Deployed and live at `system2-api.agreeablesea-31719cb5.westeurope.azurecontainerapps.io`.
- **Persistent track association (System 4)**: Polls `positions` table every 1 s, associates new detections to existing tracks (greedy nearest-neighbour, 50 m / 3 s window), creates new tracks on miss, marks idle tracks `lost` after 10 s, writes `tracks` + `track_points` tables. Deployed and live at `system4-tracking.agreeablesea-31719cb5.westeurope.azurecontainerapps.io`.
- **Operator dashboard (System 3)**: Next.js app deployed on Azure Container Apps. Renders a MapLibre map of Hong Kong, polls raw detection dots from `positions` table, polls track polyline trails from System 4, shows coloured drone dots per track, lets operators draw / edit / delete restricted no-fly zones, fires zone-violation alerts on entry (severity based on zone type), lists violations in an alerts panel. Live at `system3-dashboard.agreeablesea-31719cb5.westeurope.azurecontainerapps.io`.
- **Unity simulator (System 5)**: Unity scene with two fixed virtual cameras and a controllable drone actor. Re-publishes camera render textures as RTSP streams via mediamtx. System 1 consumes these streams identically to physical cameras. Runs locally; not deployed to Azure.
- **Fine-tuned YOLO model**: YOLOv11x fine-tuned on 17,351 drone images (Zhejiang University + DetFly datasets). Published at `FilippTrigub/yolov11x-drone-finetuned` on HuggingFace. mAP@0.5 = 0.555, precision 0.775, recall 0.606. Pluggable via `MODEL_PATH` env var in System 1.

---

## 3. What is mocked, stubbed, or hardcoded

**Undisclosed mocks carry a small penalty each. Anything you list here = free.**

| What is faked | Where (file:line or folder) | Why we mocked it | What the real version would do |
|---|---|---|---|
| For better visualization & additional to the real detection feed: synthetic background drones (SIM-001, SIM-002, SIM-003) | `system3-operator-dashboard/src/lib/use-drone-stream.ts` | Ensures for better visualization the alert engine and zone-violation logic are always demonstrable without a live camera feed connected | Remove when physical cameras or the Unity simulator are streaming — the real detections flow through System 1 → 2 → 4 → 3 automatically |

---

## 4. External APIs, services & data sources
Everything the project calls or pretends to call. Mark each as real or mocked.

| Service / API / dataset | Used for | Real call or mocked? | Auth (sandbox / test key / none) |
|---|---|---|---|
| Azure Container Apps (westeurope) | Hosting System 2, System 3, System 4 containers | Real | Azure subscription credentials |
| Azure PostgreSQL Flexible Server (northeurope) | Shared data store (`positions`, `tracks`, `track_points`) | Real | Username/password via env var |
| Azure Container Registry (`dronedetectionacr`) | Storing Docker images for all server systems | Real | Azure subscription credentials |
| HuggingFace Hub (`FilippTrigub/yolov11x-drone-finetuned`) | Fine-tuned drone detection model weights | Real | Public, no auth required |
| MapLibre GL JS | Map rendering in System 3 dashboard | Real (open-source library; uses free raster tile provider) | None |
| mediamtx | RTSP stream relay from Unity to System 1 | Real (open-source, runs locally) | None |

---

## 5. Pre-existing code
Anything written **before** kickoff that we brought into this project: prior personal projects, forked open-source code, templates, boilerplate, internal libraries.

**Undisclosed pre-built code is heavily penalized. Anything you list here = free.**

| Item | Source (URL or description) | Roughly how much | License |
|---|---|---|---|
| YOLOv8n baseline weights (`yolov8s.pt`) | Ultralytics YOLOv8 — off-the-shelf pretrained model | Model weights only; all inference wrapper code written during hackathon | AGPL-3.0 |
| mediamtx binary | [github.com/bluenviron/mediamtx](https://github.com/bluenviron/mediamtx) — open-source RTSP/RTMP server | Binary bundled in System 5 repo; no source modifications | MIT |

All application code across all five systems (System 1–5 repos) was written during the hackathon window. The YOLOv11x fine-tune (training data prep, training run, evaluation, HuggingFace upload) was also performed during the hackathon.

---

## 6. Known limitations & next steps
What we would build next, and the weak spots we already know about. Naming these honestly is a strength, not a flaw.

- **System 1 not cloud-deployed**: the detection agent runs on the camera host machine (or developer laptop), not on Azure. A production deployment would containerise System 1 and run it on edge nodes co-located with each camera.
- **Greedy nearest-neighbour tracking**: System 4 uses a simple distance/time association with no motion model. A Kalman filter or similar would handle higher drone speeds, occlusions, and multiple simultaneous drones much more robustly.
- **Triangulation requires ≥ 2 cameras with overlapping view**: a single camera cannot produce a GPS fix. Scaling to more cameras is config-only (`cameras.yaml`), but the current deployment uses just 2.
- **No authentication on any endpoint**: all APIs and the dashboard are publicly accessible. Production would require auth on the dashboard and mTLS or API-key enforcement on the System 2 / System 4 APIs.
- **Fine-tuned model mAP@0.5 = 0.555**: solid for a hackathon fine-tune on 17k images, but a production system would need more diverse training data, higher recall (0.606 today), and adversarial test cases (camouflage, partial occlusion, night conditions).
