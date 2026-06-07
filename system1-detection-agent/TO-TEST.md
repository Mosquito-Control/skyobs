What to test first (in priority order)

  1. Bearing vector correctness — most urgent, silent failure mode

  Wrong ENU vectors produce completely wrong GPS positions with zero error output from System 2. The axis remapping
  (Unity left-handed → ENU right-handed) and the quaternion rotation are the most likely places for a subtle sign
  error. Test this as soon as Unity sends its first datagram:

  # Run with --dump to print raw datagrams without POSTing
  python -m system1.main --dump

  # Then manually compute: take one camera's rot_q and center_px,
  # run sim_bearing() by hand, compare the result direction against
  # where you expect the drone to be relative to the camera.

  2. Camera ID mapping — high, also silent

  If unity_name in cameras.yaml doesn't match what Unity actually puts in cameras[].name in the datagram, events
  are silently dropped. The --dump output will show the real names — verify they match before the first live test.

  3. Timestamp → System 2 time-window matching

  System 2 only triangulates detections within a 1-second window. If two cameras' events are timestamped
  differently (e.g., one uses t_unix_ms from UDP and another uses system clock), they'll never land in the same
  window. Since both sim-mode cameras get the same t_unix_ms from the same datagram, this is correct by design —
  but worth verifying with a DB query after the first live run:

  -- Both cam_pair events should appear with identical timestamps
  SELECT cam_pair, timestamp, inserted_at FROM positions ORDER BY inserted_at DESC LIMIT 10;

  4. End-to-end smoke test last

  Only after 1–3 are confirmed: put a drone in the Unity scene, let System 1 run, and verify a row appears in the
  positions table with a plausible lat/lon/alt.

