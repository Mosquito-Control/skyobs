"""Visual smoke-test: run the drone model on an image, video, or live webcam.

Standalone (does NOT POST to System 2). Answers one question: does the model
actually detect drones on a real feed?

  # known drone image (start here)
  python tools/test_camera_detect.py --source samples/drone_1.jpg
  # live webcam (point it at a drone clip on your phone, or a photo)
  python tools/test_camera_detect.py --source 0
  # recorded video
  python tools/test_camera_detect.py --source clip.mp4

Controls (video/webcam): press 'q' to quit. Tune with --conf (e.g. 0.15).
"""

import argparse
import sys
import time

import cv2
from ultralytics import YOLO

_IMAGE_EXTS = {"jpg", "jpeg", "png", "bmp", "webp", "tif", "tiff"}


def _is_image(p: str) -> bool:
    return "." in p and p.lower().rsplit(".", 1)[-1] in _IMAGE_EXTS


def run_image(model, path, conf, imgsz):
    res = model.predict(path, conf=conf, imgsz=imgsz, verbose=False)[0]
    print(f"\n{len(res.boxes)} detection(s) in {path}:")
    for b in res.boxes:
        c = int(b.cls[0])
        print(f"  class={c} conf={float(b.conf[0]):.2f} box={[round(x) for x in b.xyxy[0].tolist()]}")
    cv2.imwrite("detected.jpg", res.plot())
    print("annotated -> detected.jpg")
    cv2.imshow("drone detection — press any key", res.plot())
    cv2.waitKey(0)
    cv2.destroyAllWindows()


def run_stream(model, source, conf, imgsz):
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"ERROR: cannot open source {source!r}")
        sys.exit(1)
    print("running — press 'q' to quit")
    t0, frames, last = time.monotonic(), 0, time.monotonic()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        res = model.predict(frame, conf=conf, imgsz=imgsz, verbose=False)[0]
        frames += 1
        now = time.monotonic()
        if now - last >= 1.0:
            confs = [round(float(b.conf[0]), 2) for b in res.boxes]
            print(f"{frames / (now - t0):5.1f} FPS | {len(res.boxes)} det {confs}")
            last = now
        out = res.plot()
        cv2.putText(out, f"{len(res.boxes)} det", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
        cv2.imshow("drone detection — press q to quit", out)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    cap.release()
    cv2.destroyAllWindows()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="models/yolov8n-drone.onnx")
    ap.add_argument("--source", default="0", help="webcam index, video file, or image file")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()

    print(f"loading {args.model}")
    model = YOLO(args.model, task="detect")
    print(f"classes: {model.names}")

    if _is_image(args.source):
        run_image(model, args.source, args.conf, args.imgsz)
    else:
        src = int(args.source) if args.source.isdigit() else args.source
        run_stream(model, src, args.conf, args.imgsz)


if __name__ == "__main__":
    main()
