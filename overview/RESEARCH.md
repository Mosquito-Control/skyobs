# Munich Hack — Drone Airspace Monitoring Research

> **Rule**: All findings, decisions, and discoveries go in this file. Update continuously.

---

## Executive Summary

**What we're building**: A real-time system that monitors multiple camera feeds, detects drones, computes their GPS positions via triangulation, overlays them on a map of Hong Kong, and flags violations of user-defined forbidden zones.

**Detection**: YOLOv8s fine-tuned on drone datasets (VisDrone + MAV-VID + Drone-vs-Bird), deployed with TensorRT FP16. The MVP target is **small-to-medium rotary drones**. For distant/small drones, add SAHI (sliced inference) for +7–14% accuracy. ByteTrack handles cross-frame tracking.

**Positioning**: Multi-camera ray triangulation is the primary approach — known camera poses + bearing angles from detections → 3D GPS intersection, no depth model needed. For the MVP, **triangulation is mandatory**. Single-camera fallback uses pinhole size-based ranging (drone size / bbox size × focal length) only as a non-MVP backup path.

**Performance**: 8 camera streams at 30fps on one RTX 3090, ~60–200ms end-to-end latency (well within 500ms target). Edge alternative: Jetson AGX Orin per 3–4 camera cluster.

**Key open questions**: camera focal length specs, camera overlap coverage, day-only vs. 24/7 operation.

---

## Project Goal

Build a system that monitors video feeds from multiple cameras, detects drones, determines their GPS positions via triangulation, overlays them on a map of Hong Kong, and flags any drone flying inside user-defined forbidden zones.

**Pipeline overview:**
```
Multiple camera feeds
  → Drone detection (ML model)
  → Distance/bearing estimation per detection
  → 3D GPS position computation via multi-camera triangulation
  → Overlay drones on a Hong Kong map in the dashboard
  → Compare position against user-defined forbidden zones
  → Flag drones inside forbidden zones
```

**MVP scope locked in:**
- target class: **small-to-medium rotary drones**
- forbidden zones: **user-defined ad hoc in a dashboard**, with support for zones that **move along predetermined routes**
- positioning method: **triangulation required for the MVP**
- demo outcome: **camera detections → triangulated drone positions → map overlay of Hong Kong → dashboard-defined forbidden zones → live indication of which drones are inside them**

---

## ML Models: Detection

### Primary Recommendation: YOLOv8s / YOLOv8m (fine-tuned)

- Best speed/accuracy tradeoff in the YOLO family for small object detection
- Fine-tune on: **VisDrone2019 + MAV-VID + Drone-vs-Bird** datasets
- Export to **TensorRT FP16** for RTX 3090, **TensorRT INT8** for Jetson
- Integrated ByteTrack tracker (built into Ultralytics)

| Model | mAP@0.5 (VisDrone) | Notes |
|---|---|---|
| YOLOv8s (TensorRT FP16) | ~40-45% | Best speed/accuracy |
| LMWP-YOLO (2025) | +22% over YOLO11n | Long-range small drones specifically |
| UAV-DETR (2025) | 51.6%, +8.4% over YOLOv8m | Transformer-based, slower but most accurate |
| EDGS-YOLOv8 | 97.1% on Anti-UAV | Controlled benchmark |

**YOLO outputs**: bounding box `(x, y, w, h)` + class confidence. No depth — distance estimated downstream.

### SAHI (Slicing Aided Hyper Inference)
- Tiles frames into overlapping patches, runs YOLO on each, merges results
- +7–14% AP improvement on small/distant objects
- Use selectively for cameras covering >150m range or as a 2-pass (full-frame first, SAHI on no-detection regions)
- 4–16x inference cost multiplier — must batch tiles efficiently
- GitHub: https://github.com/obss/sahi

### Notable Drone Datasets

| Dataset | Size | Notes |
|---|---|---|
| VisDrone2019 | ~10,000 images | De-facto benchmark |
| MAV-VID | 29,500 train / 10,732 val | Ground + UAV perspectives |
| Drone-vs-Bird | 85,904 train / 28,856 val | 77 sequences |
| Anti-UAV (DUT) | RGB + Thermal video | 6 UAV models, tracking-focused |
| MMAUD | Stereo+LiDAR+Radar+Audio | Most comprehensive multi-modal |

---

## ML Models: Distance Estimation

### Critical Finding
**General monocular depth models (DepthAnything, MiDaS, ZoeDepth) are unreliable for small airborne objects.** A drone at 200m occupies ~15–35px — depth networks produce noisy estimates for isolated sky pixels. Do not use as primary ranging method.

### Approach 1: Multi-Camera Ray Triangulation (Primary — Best Accuracy)

Since the system has multiple fixed cameras with known GPS positions and orientations:
1. Detection bounding box center → bearing ray via camera intrinsic matrix
2. Two or more cameras detecting the same drone → triangulate 3D ray intersection
3. Output: GPS coordinates of drone
4. Add Kalman filter for smooth 3D trajectory

This eliminates the need for depth estimation entirely in camera overlap zones.
Reference: [IEEE Multi-camera Multi-drone (9358454)](https://ieeexplore.ieee.org/document/9358454/)

### Approach 2: Size-Based Monocular Ranging (Fallback for Single-Camera)

```
distance = (drone_real_width_m × focal_length_px) / bbox_width_px
focal_length_px = (image_width_px / sensor_width_mm) × focal_length_mm
```

- Accuracy: RMSE ~0.65–2.0m in controlled conditions
- Needs size lookup table per drone class:
  - DJI Mini: ~0.25m
  - DJI Mavic: ~0.35m
  - DJI Phantom: ~0.50m
- Orientation variation causes 3–5x bbox size swing (nose-on vs. broadside)
- Mitigation: use `sqrt(w × h)` as effective size instead of `w` or `h` alone

### Detection Range vs. Camera Pixel Coverage

| Range | Pixel size (1080p, 50mm equiv) | Detection likelihood |
|---|---|---|
| 50m | ~100–150px | >90% reliable |
| 100m | ~50–75px | 80–90% reliable |
| 200m | ~25–35px | 60–80% (SAHI helps) |
| 500m | ~8–12px | 20–50% (needs telephoto + SAHI) |

**Camera lens matters enormously**: 300mm telephoto at 4K gives ~300px at 100m vs. ~30px for a wide-angle. This is the dominant factor in detection range.

---

## Latency & Resource Requirements

### Inference Latency

| Model | Hardware | Format | Latency | FPS |
|---|---|---|---|---|
| YOLOv8n | RTX 3090 | TensorRT FP16 | ~5–8ms | ~125–200 |
| YOLOv8s | RTX 3090 | TensorRT FP16 | ~8–12ms | ~80–125 |
| YOLOv8n | Jetson AGX Orin | TensorRT INT8 | ~10–15ms | ~67–100 |
| YOLOv8x | Jetson AGX Orin | TensorRT INT8 | ~13ms | ~75 |
| UAV-DETR | GPU | PyTorch | ~40–80ms | ~12–25 |
| SAHI overhead | — | — | +20–80ms | — |
| ByteTrack | — | CPU/GPU | +2–5ms | — |
| Ray triangulation | — | CPU | +1–2ms | — |

### Multi-Stream Feasibility on RTX 3090

- **4 streams @ 30fps**: Comfortable with YOLOv8s TensorRT FP16 (~6GB VRAM)
- **8 streams @ 30fps**: Feasible with YOLOv8n/s, ~6–10GB VRAM (within 24GB)
- **SAHI on all 8 streams**: Tight — apply selectively (ROI-only or 15fps rate)

### Full Pipeline Budget (8 streams, sub-500ms target)

```
RTSP decode:          20–50ms
YOLO batched:          5–15ms
SAHI (selective):     20–80ms
Tracking:              2–5ms
Triangulation:         1–2ms
Network:              10–50ms
─────────────────────────────
Total:              ~60–200ms  ✓ well within 500ms
```

### Edge Hardware Option

- **Jetson AGX Orin (64GB)**: 3–4 streams at 30fps with YOLOv8n INT8
- Deploy 2–3 Jetson AGX Orin units per 4–8 camera cluster for distributed edge inference

---

## Recommended Stack

| Layer | Choice | Rationale |
|---|---|---|
| Detector | YOLOv8s fine-tuned, TensorRT FP16 | Best speed/accuracy, mature deployment |
| Long-range extension | SAHI 2-pass | +7–14% AP for distant small drones |
| Tracker | ByteTrack (Ultralytics built-in) | Temporal consistency, reduces false positives |
| Ranging (primary) | Multi-camera ray triangulation | Most accurate, no depth model needed |
| Ranging (fallback) | Size-based pinhole model | Single-camera fallback |
| GPU server | RTX 3090 or A100 | 8 streams comfortable |
| Edge option | Jetson AGX Orin | Per 3–4 camera cluster |
| Training datasets | VisDrone2019 + MAV-VID + Drone-vs-Bird | |

---

## Open Questions / To Decide

- [ ] **Camera specs**: Focal length + sensor size determine detection range. Need spec sheet for planned cameras.
- [ ] **Camera overlap coverage**: More overlap zones → more triangulation coverage → better accuracy.
- [ ] **Operating hours**: Day-only or 24/7? Thermal cameras dramatically improve night detection (Anti-UAV benchmark evidence).
- [ ] **System architecture**: Centralised GPU server vs. distributed edge (Jetson per camera cluster)?

## Locked MVP Product Decisions

- **Target drone class**: small-to-medium rotary drones
- **Forbidden zones**: not static restricted airspace only; users must be able to define forbidden zones ad hoc in a dashboard
- **Moving zones**: forbidden zones must also be able to move along predetermined routes
- **Positioning method**: triangulation is a core MVP requirement, not optional
- **MVP demo promise**: detect drones with cameras, determine their position with triangulation, overlay their position on a map of Hong Kong, allow the user to define forbidden zones in a dashboard, and show which drones are inside those zones

---

## Key References

- [LMWP-YOLO (Scientific Reports 2025)](https://www.nature.com/articles/s41598-025-95580-z)
- [UAV-DETR (PMC 2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12349633/)
- [SAHI (arXiv 2202.06934)](https://arxiv.org/abs/2202.06934) — [GitHub](https://github.com/obss/sahi)
- [Multi-camera Multi-drone Localization (IEEE 9358454)](https://ieeexplore.ieee.org/document/9358454/)
- [Anti-UAV Multi-Modal Benchmark](https://github.com/ZhaoJ9014/Anti-UAV)
- [Monocular UAV Localisation (arXiv 2311.02908)](https://arxiv.org/pdf/2311.02908)
- [Depth Anything V2 (GitHub)](https://github.com/DepthAnything/Depth-Anything-V2)
- [YOLOv8 Jetson Benchmarks (Seeed Studio)](https://www.seeedstudio.com/blog/2023/03/30/yolov8-performance-benchmarks-on-nvidia-jetson-devices/)
- [Anti-UAV Survey (MDPI Drones 2024)](https://www.mdpi.com/2504-446X/8/9/518)

---

---

## Simulation Environment

### Feasibility Verdict: Yes, realistic in 1–2 weeks

A simulation loop — two fixed virtual cameras → YOLO pipeline → triangulation → forbidden zone check → violation alert — is buildable with existing open-source components. No major custom work required.

---

### Recommended Platform: Webots (hackathon MVP)

For the hackathon MVP, **Webots** is the recommended simulator because it is the lowest-friction path on Arch/CachyOS and is sufficient for the required demo loop.

| Requirement | Webots support | Effort |
|---|---|---|
| 2 fixed cameras, known poses & intrinsics | Camera nodes plus Supervisor access give controlled camera placement and scene-state access | ~2h config |
| Camera frames → Python ML pipeline | Python controllers can read camera frames directly | ~1 day |
| Ground-truth drone position | Supervisor API provides direct scene / robot state access | ~2h |
| Triangulation validation | Use known simulator poses and camera geometry to validate the triangulation pipeline end to end | ~1–2 days |
| Forbidden zones in dashboard | Implement in app/dashboard layer; simulator only needs drone motion + position output | ~1 day |
| Moving forbidden zones | Implement in dashboard/app logic, independent of simulator | ~1 day |

**Longer-term alternative:** PX4 + Gazebo Harmonic + ROS2 is the stronger follow-up stack if the project continues beyond the hackathon and needs a more realistic drone-control architecture.

**Avoid for this sprint:** AirSim-family tools as the main path, Jetson/JetPack host-tooling dependencies, and TensorRT unless it becomes necessary for performance.

---

### RC Controller Integration

**Cleanest path**: FrSky Taranis X9D / RadioMaster (OpenTX or EdgeTX) via USB direct. The transmitter enumerates as a standard USB HID joystick; AirSim reads it natively.

Alternative paths for other TX hardware:
- Any transmitter with trainer port → FPV sim dongle (Skydroid, WS1000) → USB HID
- Spektrum → USB data cable → HID
- DIY: SBUS receiver → STM32/Arduino USB adapter → VJoy virtual joystick

For maximum realism (same flight stack as real drone): use PX4 SITL + QGroundControl joystick bridge instead of AirSim's `simple_flight`. Adds latency and setup complexity; not needed for pipeline validation.

---

### Camera Feed to ML Pipeline — The Critical Bottleneck

This is the single most reported pain point in AirSim. Throughput by method:

| Method | Resolution | FPS | Notes |
|---|---|---|---|
| Synchronous PNG-compressed | 1080p | ~5 FPS | Too slow |
| Synchronous uncompressed RGB | 640×480 | ~15–20 FPS | Marginal, may be enough |
| ZMQ async publisher (custom plugin) | 640×480 | ~60 FPS | Reported in community |
| Cosys-AirSim ROS2 topic | any | ~30 FPS | Clean, no custom code |
| Gazebo/ROS2 image_raw topic | any | ~30 FPS | Zero throughput concerns |

**Recommendation**: Start with uncompressed RGB at 640×480. If YOLO runs well at that resolution (it does — YOLOv8 native input is 640px), this is sufficient. Upgrade to Cosys-AirSim ROS2 path if throughput becomes an issue.

**Domain gap note**: YOLO trained on real drone footage may have lower detection rate on rendered drone meshes. Expect some fine-tuning or detection threshold adjustment on simulated frames.

---

### CachyOS / Arch Linux Compatibility Check

### Short Verdict

**Partly yes.** The **desktop ML stack** (RTX 3090 + NVIDIA driver + CUDA + PyTorch + Ultralytics/SAHI) is viable on CachyOS/Arch. The **simulation stack** is less clean: Unreal/AirSim-family tooling is documented primarily for **Ubuntu 22.04**, and **TensorRT on desktop Arch is unofficial / higher-friction**. **Jetson / JetPack host tooling should be treated as Ubuntu-only, not CachyOS-native.**

### Support Matrix

| Component | CachyOS / Arch verdict | Notes |
|---|---|---|
| NVIDIA driver + CUDA on desktop RTX 3090 | **Works natively** | Strong Arch support via official packages; still higher churn than Ubuntu LTS because CachyOS uses custom kernels and more aggressive updates. |
| PyTorch / Ultralytics YOLOv8 / SAHI | **Works natively** | Python-first stack; easiest part of the system to run on CachyOS. Use venv/conda and keep Python deps isolated from system packages. |
| ByteTrack | **Works with caveats** | Usable, but more likely to hit rolling-release friction because of compiled Python deps. |
| TensorRT on desktop RTX 3090 | **Works with caveats** | Possible, but not a first-class Arch target. Prefer Docker or carefully pinned AUR/manual install. |
| Unreal Engine 5.x on Arch | **Works with caveats** | Possible, but Ubuntu is the documented Linux baseline in most upstream docs; Arch has more manual setup and runtime quirks. |
| AirSim / Cosys-AirSim / Colosseum-family simulation stack | **Works with caveats to painful** | Linux support exists, but the well-documented paths are Ubuntu-first. Cosys-AirSim is the cleanest Linux path; AirSim-family forks are not a clean “just install it on CachyOS” story. |
| ROS2 integration | **Works with caveats** | Better treated as an Ubuntu-pinned environment; newer Arch/CachyOS toolchains can break older simulator wrappers. |
| PX4 SITL + QGroundControl | **Likely works, but better on Ubuntu** | Feasible on Linux, but not needed for first validation sprint and adds more setup complexity on Arch. |
| USB HID RC controller (FrSky Taranis / RadioMaster) | **Likely works natively** | Linux HID/joystick support is fine in principle; expect some calibration / mapping work depending on the controller profile. |
| Jetson AGX Orin / JetPack host tooling | **Do not plan around CachyOS host support** | NVIDIA’s Jetson/JetPack tooling is effectively Ubuntu-host territory. |

### Practical Recommendation

If the team wants the **lowest-risk path**:

- Run **desktop development / inference on CachyOS** only for the ML side:
  - NVIDIA driver
  - CUDA / cuDNN / PyTorch
  - Ultralytics YOLOv8
  - SAHI
  - Python triangulation / polygon logic
- Treat the **simulator** as **Ubuntu-first**:
  - Best choice: **Cosys-AirSim on Ubuntu 22.04**
  - Acceptable fallback: Unreal/AirSim-family tools on Arch only if the team is comfortable debugging Linux graphics/toolchain issues
- Treat **TensorRT** as **container-first** on desktop Arch/CachyOS
- Treat **Jetson / JetPack / SDK Manager** as **Ubuntu-host only**

### Recommended Architecture for This Project

For this specific sprint, the cleanest split is:

1. **CachyOS workstation** for research, Python development, YOLO training/inference, and algorithm work
2. **Ubuntu 22.04 environment** (native install, dual-boot, or VM if GPU passthrough is available) for Unreal/AirSim-family simulation work
3. **Optional Docker** for TensorRT or other NVIDIA vendor-tooling that is less happy on rolling-release Arch

This avoids the two highest-friction combinations:

- **CachyOS + Unreal/AirSim + NVIDIA graphics stack**, and
- **CachyOS + Jetson SDK / JetPack host tooling**

### Main Risks on CachyOS Specifically

- **Kernel / NVIDIA coupling**: CachyOS custom kernels can make NVIDIA module compatibility more fragile than stock Ubuntu LTS.
- **TensorRT packaging quality**: works, but the Arch path is not as clean or officially supported as Ubuntu/Debian.
- **Simulator docs mismatch**: most Unreal/AirSim-family Linux docs assume Ubuntu and older/fixed toolchains.
- **Wayland / graphics edge cases**: Unreal on Linux is generally more predictable on conservative setups than on aggressively tuned rolling distros.

### Key Compatibility References

- ArchWiki — NVIDIA: https://wiki.archlinux.org/title/NVIDIA
- ArchWiki — CUDA / GPGPU: https://wiki.archlinux.org/title/CUDA
- ArchWiki — Docker GPU setup: https://wiki.archlinux.org/title/Docker
- ArchWiki — Unreal Engine 5 on Arch: https://wiki.archlinux.org/title/Unreal_Engine_5
- NVIDIA cuDNN installation guide: https://docs.nvidia.com/deeplearning/cudnn/installation/latest/linux.html
- NVIDIA Container Toolkit install guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
- Cosys-AirSim Linux install docs: https://github.com/Cosys-Lab/Cosys-AirSim/blob/main/docs/install_linux.md
- Project AirSim issue showing Linux/toolchain friction: https://github.com/iamaisim/ProjectAirSim/issues/120
- CachyOS kernel notes: https://wiki.cachyos.org/features/kernel/

### Final Answer to the Question

If the question is **“Will the whole proposed stack work on CachyOS?”** the answer is:

- **ML stack:** **Yes**
- **Simulation stack:** **Yes, but with real caveats**
- **Jetson deployment toolchain:** **No as a primary host plan — use Ubuntu**

So CachyOS is a **good workstation OS for the ML and general development side**, but **not the best single OS to standardize the entire simulation + NVIDIA vendor-tooling stack around**.

---

### Arch / CachyOS-Friendly Equivalent Stack

### Revalidation Result

The earlier incompatibilities are **not fully resolved**.

- **Unreal / AirSim Ubuntu bias:** partially resolved overall, but still active at the simulator layer
- **TensorRT on Arch:** partially resolved, but still higher-friction than Ubuntu/containerized paths
- **Jetson / JetPack host tooling:** still not an Arch-native plan
- **ROS2 on Arch:** no longer a blocker by itself, but simulator wrappers remain Ubuntu-biased

### Best Equivalent Replacement Stack

For an **Arch / CachyOS-compatible equivalent setup**, the strongest replacement is:

**PX4 + Gazebo Harmonic + ROS2 + Python YOLO pipeline**

Why this wins:

- avoids Unreal as a core dependency
- gives a modern ROS2-native Linux simulator path
- keeps realistic drone-control workflows through PX4 SITL
- preserves the project needs: fixed cameras, Python image pipeline, ground-truth state, and no-fly-zone support via PX4 geofence / QGroundControl

### Ranked Alternatives

| Rank | Stack | Score |
|---|---|---:|
| 1 | PX4 + Gazebo Harmonic + ROS2 | 85/100 |
| 2 | Webots + custom geofence / control glue | 81/100 |
| 3 | Gazebo Harmonic + ROS2 only | 76/100 |
| 4 | Isaac Sim + Pegasus | 63/100 |
| 5 | Project AirSim | 55/100 |
| 6 | Cosys-AirSim | 49/100 |
| 7 | Colosseum | 46/100 |

Detailed notes and sources: `OS_COMPATIBILITY.md` (hackathon-first guidance is maintained there)

---

### What Must Be Built From Scratch (not in any repo)

Three components need to be assembled — none are hard:

1. **YOLO+SAHI inference loop** consuming AirSim camera frames (~1 day)
2. **Multi-camera ray triangulation** from 2D bounding box centers to 3D world position — DLT or midpoint algorithm, ~200 lines of Python (~1–2 days)
3. **Forbidden zone polygon** definition + point-in-polygon check in Python (~half a day)

---

### Closest Existing Reference Repos

| Repo | What it covers | Gap |
|---|---|---|
| [aryanshar/swarm-detection](https://github.com/aryanshar/swarm-detection) | AirSim + YOLO + stereo triangulation + ground truth | Cameras are drone-mounted, not fixed; no RC control; no forbidden zone |
| [Cosys-Lab/Cosys-AirSim](https://github.com/Cosys-Lab/Cosys-AirSim) | Best AirSim base, ROS2, thermal, expanded sensors | Needs YOLO and forbidden zone wired in |
| [CodexLabsLLC/Colosseum](https://github.com/CodexLabsLLC/Colosseum) | UE5.4 AirSim successor, active community | Same |
| [microsoft/DroneRescue](https://github.com/microsoft/DroneRescue) | AirSim + Azure Custom Vision drone detection | Azure-dependent, not YOLO |
| [GhaziDhouafli/Object-Detection-Tracking-Drone](https://github.com/GhaziDhouafli/Object-Detection-Tracking-Drone) | YOLO + AirSim detection PoC | Minimal; no positioning |

**swarm-detection** remains a useful triangulation reference, but not the preferred simulator baseline for the hackathon.

---

### Sprint Plan (2-week estimate)

| Day | Work | Owner |
|---|---|---|
| 1 | Install Webots, build a minimal scene with two fixed cameras, confirm Python image retrieval | Sim dev |
| 2 | Add a drone actor, expose ground-truth position through Supervisor, and log synchronized multi-camera observations | Sim dev |
| 3–4 | Wire camera frames into YOLO+SAHI pipeline and confirm detections on rendered frames | ML dev |
| 5–6 | Implement multi-camera triangulation from detections and validate against simulator ground truth | Both |
| 7 | Build dashboard map overlay for Hong Kong plus ad hoc forbidden-zone drawing | App dev |
| 8 | Add moving forbidden zones along predefined routes | App dev |
| 9–10 | End-to-end validation: detection → triangulation → Hong Kong map overlay → zone membership display | Both |

---

## Session Log

### 2026-06-05
- Project initiated: drone airspace monitoring system for Hong Kong
- Researched ML models for drone detection and distance estimation
- Findings: YOLO8s + SAHI for detection; multi-camera triangulation for positioning (primary); size-based pinhole model as fallback
- Key insight: monocular depth networks (DepthAnything etc.) are unreliable for small airborne targets — do not use as primary ranging
- Researched simulation environment feasibility
- Verdict: realistic in 1–2 weeks using AirSim (Colosseum fork) with FrSky Taranis USB for RC control
- Main risk: camera feed throughput (mitigate with uncompressed RGB at 640×480 or Cosys-AirSim ROS2 path)
- Key reference: aryanshar/swarm-detection as architecture template
- Checked CachyOS / Arch Linux compatibility for the proposed stack
- Verdict: desktop ML stack is fine on CachyOS; simulator stack is Ubuntu-first; TensorRT is workable with caveats; Jetson host tooling should be treated as Ubuntu-only
- Recommendation: use CachyOS for Python/ML work, and an Ubuntu 22.04 environment for Unreal/AirSim-family simulation and Jetson-related tooling
- Locked MVP scope decisions after clarifying product requirements
- Target drone class for the MVP: small-to-medium rotary drones
- Forbidden zones are a core dashboard feature: users must be able to define them ad hoc, and zones must also be able to move along predetermined routes
- Triangulation is mandatory for the MVP and is not treated as optional fallback work
- End-to-end MVP promise: detect drones with cameras, triangulate their position, overlay them on a Hong Kong map, and show which drones are inside dashboard-defined forbidden zones
- Re-checked whether the earlier Arch/CachyOS incompatibilities were still current upstream
- Result: most old blockers are only partially resolved, not fully gone; Jetson host tooling remains the clearest unresolved mismatch for native Arch use
- Researched Arch/CachyOS-friendlier equivalents and ranked them
- Best replacement stack for this project: PX4 + Gazebo Harmonic + ROS2 + Python YOLO pipeline
