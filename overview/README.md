# Sky Observations (SkyObs) — Project Overview

Real-time drone airspace monitoring system. Detects drones via fixed cameras, triangulates their GPS position, tracks them over time, and alerts operators when drones enter restricted zones.

---

## How it works

```
System 5: Unity simulator → mediamtx RTSP server (or physical cameras)
  → System 1: YOLO detection → bearing vectors
  → System 2: multi-camera triangulation → GPS positions → PostgreSQL
  → System 4: greedy track association → persistent tracks → PostgreSQL
  → System 3: operator dashboard — map, zone alerts, track trails
```

All server components run on **Azure Container Apps**. Systems 2, 3, and 4 share a single **Azure PostgreSQL** instance as their integration boundary — no direct API coupling between systems.

System 5 (Unity simulator) runs locally and is the simulation substitute for physical cameras during development and demo.

---

## Detection model

Three options, all YOLOv8/11 family, all output pixel bounding boxes that `drone-detection-ml` converts to ENU bearing vectors:

| Model | Source | mAP@0.5 | Notes |
|---|---|---|---|
| **YOLOv8n** (baseline) | bundled in repo | — | Fastest; misses small/distant drones; conf 0.37–0.84 on test set |
| **YOLOv11x** (public fine-tune) | public HuggingFace checkpoint pre-trained on drone data | — | Starting point for our fine-tune; not our weights |
| **YOLOv11x** (our fine-tune, recommended) | [`FilippTrigub/yolov11x-drone-finetuned`](https://huggingface.co/FilippTrigub/yolov11x-drone-finetuned) | 0.555 | Trained on 17,351 images (Zhejiang Uni + DetFly); precision 0.775, recall 0.606 |

Full model cards, benchmarks, and usage: [`drone-detection-ml/`](../drone-detection-ml/README.md).

---

## Repositories

| Repo | Role |
|---|---|
| [system5-unity-simulation](https://github.com/Mosquito-Control/system5-unity-simulation) | Unity drone scene · mediamtx RTSP server · virtual cameras |
| [drone-detection-ml](https://github.com/Mosquito-Control/drone-detection-ml) | YOLO inference library · pixel bbox → ENU bearing vector |
| [system1-detection-agent](https://github.com/Mosquito-Control/system1-detection-agent) | Per-camera YOLO inference · bearing vector POST to System 2 |
| [system2-positioning-engine](https://github.com/Mosquito-Control/system2-positioning-engine) | Ray triangulation · writes `positions` table |
| [system3-operator-dashboard](https://github.com/Mosquito-Control/system3-operator-dashboard) | Next.js map UI · zone alerts · track polylines |
| [system4-tracking-engine](https://github.com/Mosquito-Control/system4-tracking-engine) | Track association · writes `tracks` + `track_points` tables |

---

## Live URLs (Azure, westeurope)

| Service | URL |
|---|---|
| System 2 API | `https://system2-api.agreeablesea-31719cb5.westeurope.azurecontainerapps.io` |
| System 3 Dashboard | `https://system3-dashboard.agreeablesea-31719cb5.westeurope.azurecontainerapps.io` |
| System 4 API | `https://system4-tracking.agreeablesea-31719cb5.westeurope.azurecontainerapps.io` |

---

## Documentation in this repo

| File | Contents |
|---|---|
| [INTEGRATED_SYSTEM_STATE.md](./INTEGRATED_SYSTEM_STATE.md) | Full system state — architecture, endpoints, DB schema, config, risks |
| [RESEARCH.md](./RESEARCH.md) | ML model selection, detection/positioning approach, sprint plan |
| [DATASETS.md](./DATASETS.md) | Drone detection datasets ranked by relevance |
| [OS_COMPATIBILITY.md](./OS_COMPATIBILITY.md) | Simulator stack compatibility on Arch/CachyOS |

---

*Project name: **Sky Observations** · short: **SkyObs***
