# OS Compatibility and Equivalent Stack Research

## Short Verdict

**CachyOS / Arch Linux is workable for this project, but only if we optimize for hackathon speed instead of forcing the original AirSim-first plan.**

The earlier incompatibilities are **not fully gone**:

- **Unreal / AirSim Ubuntu bias:** partially resolved overall, still active at the simulator layer
- **TensorRT on Arch:** partially resolved, still higher-friction than Ubuntu/containerized paths
- **Jetson / JetPack host tooling:** still not an Arch-native plan
- **ROS2 on Arch:** no longer a blocker by itself, but simulator wrappers remain Ubuntu-biased

That means the right move for a hackathon is:

> **Use Webots as the primary simulator because it is the lowest-friction path on Arch/CachyOS.**

Keep **PX4 + Gazebo Harmonic + ROS2** as the stronger “more realistic drone stack” option if the project continues after the hackathon.

---

## Revalidation of Earlier Blockers

### Unreal / AirSim Ubuntu bias

**Status: Partially resolved, still active**

- Unreal itself is no longer the blocker: ArchWiki documents UE5 on Arch and the AUR package is current.
- AirSim-family tooling is still Ubuntu-centered upstream. The older AirSim Linux docs remain Ubuntu 18.04-era, while newer AirSimExtensions docs still center Ubuntu 22.04 and recommend Docker/WSL2 when host setup is painful.

Sources:
- https://wiki.archlinux.org/title/Unreal_Engine_5
- https://aur.archlinux.org/packages/unreal-engine
- https://github.com/microsoft/AirSim/blob/0b2db65ff1bb78d1a36fd16c71e54de9f0735197/docs/build_linux.md#L1-L45
- https://microsoft.github.io/AirSimExtensions/build_linux/

### TensorRT on Arch friction

**Status: Partially resolved, still active**

- TensorRT is no longer impossible on Arch: NVIDIA now has pip-based installation paths and the Arch AUR package is current.
- Arch/CachyOS is still not a first-class supported OS in NVIDIA docs, and recent AUR comments still show rolling compiler/CUDA friction.

Sources:
- https://docs.nvidia.com/deeplearning/tensorrt/latest/installing-tensorrt/install-pip.html
- https://aur.archlinux.org/packages/tensorrt
- https://aur.archlinux.org/packages/tensorrt#comment-1073197

### Jetson / JetPack Ubuntu host requirement

**Status: Unresolved for native Arch host**

- JetPack components can now be installed on-device via apt, so “Ubuntu for everything” is too strong.
- NVIDIA SDK Manager host support still does not list Arch/CachyOS.

Sources:
- https://docs.nvidia.com/jetson/agx-orin-devkit/user-guide/latest/setup_jetpack.html
- https://docs.nvidia.com/sdk-manager/system-requirements/index.html

### ROS2 / simulator toolchain caveats

**Status: Partially resolved, still active**

- ROS2 itself can be used on Arch through community packaging.
- The simulator wrapper layer is still Ubuntu-biased, especially around AirSim-family integrations.

Sources:
- https://aur.archlinux.org/packages/ros2-kilted
- https://wiki.archlinux.org/title/ROS
- https://microsoft.github.io/AirSimExtensions/airsim_ros_pkgs/
- https://github.com/microsoft/AirSim/pull/5058

---

## Compatibility Matrix

| Component | Verdict on CachyOS / Arch | Notes |
|---|---|---|
| NVIDIA driver + CUDA on desktop RTX 3090 | **Works natively** | Strong Arch support, but more churn than Ubuntu LTS because CachyOS uses custom kernels and faster-moving packages. |
| PyTorch / Ultralytics YOLOv8 / SAHI | **Works natively** | Cleanest part of the stack on CachyOS. Best installed in a venv or conda environment. |
| ByteTrack | **Works with caveats** | Usable, but compiled Python dependencies are more fragile on rolling-release systems. |
| TensorRT on desktop RTX 3090 | **Works with caveats** | Possible, but still not a first-class Arch target. Prefer Docker or a pinned install if needed later. |
| Unreal Engine 5.x | **Works with caveats** | Possible on Arch, but not the easiest hackathon route. |
| AirSim / Cosys-AirSim / Colosseum-family simulation stack | **Works with caveats to painful** | Linux support exists, but the well-documented paths remain Ubuntu-first. |
| Webots | **Works well** | Best fit for a fast Arch/CachyOS hackathon setup because it avoids Unreal and provides a direct camera + Python workflow. |
| PX4 + Gazebo Harmonic + ROS2 | **Works with caveats** | Best long-term equivalent stack, but more moving parts than Webots for a hackathon. |
| USB HID RC controller (FrSky Taranis / RadioMaster) | **Likely works natively** | Linux joystick/HID support is fine in principle; calibration/mapping may still be needed. |
| Jetson AGX Orin / JetPack host tooling | **Do not plan around CachyOS host support** | Treat Jetson SDK / JetPack host tooling as Ubuntu-host territory. |

---

## Equivalent Stack Ranking

### Best for hackathon speed

| Rank | Stack | Score | Why it ranks here |
|---|---|---:|---|
| 1 | **Webots + Python YOLO pipeline + custom geofence/control glue** | **88/100** | Lowest-friction Arch/CachyOS path: easiest simulator setup, strong camera + supervisor APIs, and the shortest route to “working demo by hackathon deadline.” |
| 2 | **PX4 + Gazebo Harmonic + ROS2** | **85/100** | Better drone-native architecture and geofence story, but slower to assemble under hackathon time pressure. |
| 3 | **Gazebo Harmonic + ROS2 only** | **76/100** | Strong Linux and ROS2 base, but weaker if you want realistic drone-control workflows quickly. |
| 4 | **Isaac Sim + Pegasus** | **63/100** | Technically powerful but too heavy and Ubuntu/container-oriented for the hackathon-first goal. |
| 5 | **Project AirSim** | **55/100** | Familiar AirSim-style APIs, but still too Ubuntu/Unreal-centric. |
| 6 | **Cosys-AirSim** | **49/100** | Good features, but still inherits Unreal/AirSim Linux friction. |
| 7 | **Colosseum** | **46/100** | Still too much Unreal/Vulkan friction for an Arch-first hackathon recommendation. |

### If the project continues after the hackathon

The strongest long-term equivalent stack remains:

> **PX4 + Gazebo Harmonic + ROS2 + Python YOLO pipeline**

because it better matches a real drone-control workflow and has a cleaner no-fly-zone path through PX4 geofencing.

Sources:
- https://github.com/gazebosim/docs/blob/f4fc3e91078aacda6e1dbf8d60e004bac4a1de6c/harmonic/install.md#L1-L57
- https://github.com/gazebosim/docs/blob/f4fc3e91078aacda6e1dbf8d60e004bac4a1de6c/harmonic/ros2_overview.md#L3-L17
- https://github.com/PX4/PX4-Autopilot/blob/77edb0dda6dc69566bad65d909b556824c549320/docs/en/sim_gazebo_gz/index.md#L8-L75
- https://github.com/PX4/PX4-Autopilot/blob/77edb0dda6dc69566bad65d909b556824c549320/docs/en/flying/geofence.md#L3-L32

---

## Recommended Hackathon Setup: Webots

### Why Webots wins for the hackathon

- no Unreal dependency
- simpler Linux install story
- direct Python controller support
- camera access and ground-truth access are both built in
- enough fidelity for a convincing fixed-camera demo

### Recommended setup path on Arch / CachyOS

**Preferred:** use the official Linux **tarball**, unpack it locally, and run Webots directly.

Why this is best:

- upstream explicitly recommends tarball/snap for non-Ubuntu distributions
- tarball requires no root install
- avoids Ubuntu-specific package assumptions

Sources:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/installation-procedure.md#L15-L19
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/installation-procedure.md#L80-L98

### Why not Snap or Docker first

- Snap is sandboxed and awkward for extra Python/native dependencies
- Docker is more useful for CI/headless or tightly sandboxed setups than for a hackathon GUI + camera + ML workflow

Sources:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/installation-procedure.md#L120-L140
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/installation-procedure.md#L144-L168

### Practical workflow

1. Download the latest official Linux tarball and extract it somewhere simple.
2. Set `WEBOTS_HOME` to that extracted folder.
3. Launch Webots from a shell.
4. Create a Python venv for ML dependencies (`numpy`, `opencv-python`, inference stack).
5. Launch Webots from that shell so its Python controller resolves the correct `python`, or override it in `runtime.ini` / shebang.

Sources:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/using-python.md#L17-L24
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/using-python.md#L52-L57

### Camera frames to Python ML

- enable the camera in the controller loop
- prefer `camera.getImage()` for speed
- the raw image is **BGRA** bytes
- `getImageArray()` exists, but is slower and less ideal for a hackathon inference loop

Sources:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/reference/camera.md#L131-L139
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/reference/camera.md#L898-L911

### Ground-truth position

Use a **Supervisor** controller on the same robot that runs the camera logic.

- easiest handle: `getSelf()`
- read the robot’s `translation` field and poll it each step
- this keeps camera access and ground-truth access in one controller

Sources:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/supervisor-programming.md#L7-L15
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/supervisor-programming.md#L25-L27
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/supervisor-programming.md#L40-L52
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/supervisor-programming.md#L173-L181

### Segmentation / label ground truth

If you want quick label generation for debugging or demo overlays:

- add a `Recognition` node to the camera
- set `segmentation TRUE`
- enable recognition and segmentation
- read `getRecognitionSegmentationImage()`

Important detail: recognition must be enabled, but the camera itself does **not** have to be enabled for segmentation.

Source:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/reference/camera.md#L1195-L1215

### Practical gotchas

- Webots is OpenGL-heavy; native NVIDIA/AMD drivers matter more than CachyOS tweaks.
- Supervisor cannot read another robot’s internal device data, so keep camera + pose on the same robot/controller.
- Wayland can still be annoying on Arch; if the GUI behaves badly, prefer X11 for the hackathon.
- ROS2 support exists, but it is extra setup. Skip it unless you actually need ROS2 during the hackathon.

Sources:
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/guide/installation-procedure.md#L21-L23
- https://github.com/cyberbotics/webots/blob/3d7ebe8a2a6b72fb7f72e44f73b1befea8ef209d/docs/reference/supervisor.md#L3-L6
- https://github.com/cyberbotics/webots/issues/6905
- https://github.com/cyberbotics/webots_ros2/blob/master/README.md

---

## Final Recommendation

If the question is:

### “What should we use for the hackathon?”

Use:

> **Webots + Python YOLO pipeline + Supervisor-based ground truth + simple custom no-fly-zone logic**

Why:

- fastest path to a working demo on Arch/CachyOS
- least setup friction
- no Unreal dependency
- no mandatory ROS2 dependency

### “What should we use if this becomes a more serious follow-up project?”

Use:

> **PX4 + Gazebo Harmonic + ROS2 + Python YOLO pipeline**

Why:

- better drone-native architecture
- stronger control/geofence story
- cleaner long-term robotics stack

### What we should avoid for the hackathon

- AirSim-family tools as the primary path
- Jetson / JetPack host-tooling dependencies
- TensorRT unless we truly need it during the event

Those three add the most friction for the least hackathon benefit.
