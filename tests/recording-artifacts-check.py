#!/usr/bin/env python3
"""Independent exact-byte/rational-container checks; synthetic media, NOT live QA.
Usage: python3 tests/recording-artifacts-check.py ARTIFACT_DIR [ARTIFACT_DIR ...]
"""
import hashlib
import json
import pathlib
import subprocess
import sys
from fractions import Fraction


def hashed(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def check(path):
    meta = json.loads(path.read_text())
    stem = path.name.removesuffix(".metadata.json")
    video = path.with_name(stem + "." + meta["settings"]["format"])
    timeline = path.with_name(stem + ".timeline.jsonl")
    assert hashed(video) == meta["video"], video
    assert hashed(timeline) == meta["timeline"], timeline
    rows = [json.loads(line) for line in timeline.read_text().splitlines()]
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_frames", "-of", "json", str(video)
    ]))
    assert len(probe["streams"]) == 1
    stream = probe["streams"][0]
    assert stream["codec_type"] == "video"
    if meta["settings"]["format"] != "gif":
        assert stream["codec_name"] == "h264" and stream["pix_fmt"] == "yuv420p"
    tb = Fraction(stream["time_base"])
    pts = [int(f["best_effort_timestamp"]) * tb * 1000 for f in probe["frames"] if f["media_type"] == "video"]
    end = int(stream["duration_ts"]) * tb * 1000
    assert len(pts) == len(rows) and pts[0] == 0
    assert (stream["width"], stream["height"]) == (meta["width"], meta["height"])
    for n, (row, p) in enumerate(zip(rows, pts)):
        duration = (pts[n+1] if n+1 < len(pts) else end) - p
        assert row["output_frame"] == n+1 and row["export_id"] == meta["export_id"]
        if meta["schema_version"] == 2:
            assert Fraction(row["pts_ms"]) == p and Fraction(row["duration_ms"]) == duration
        else:
            # Schema1 historically stores floating presentation approximations.
            assert abs(row["pts_ms"] - float(p)) < .01 and abs(row["duration_ms"] - float(duration)) < .01
    raw = meta.get("source_manifest_json")
    source = json.loads(raw) if raw else None
    if source:
        assert hashlib.sha256(raw.encode()).hexdigest() == meta["source_manifest_sha256"]
    final_rows = []
    if meta["schema_version"] == 2:
        assert meta["duration_ms"] == end
        if source:
            assert source["protocol_version"] == meta["source_protocol_version"] == 2
            assert source["backend"] == meta["backend"] == "cdp_capture_screenshot"
            assert meta["partial"] == (source["state"] == "failed")
            assert meta.get("observed_source_end_ms") == (source["end"]["duration_ms"] if source["end"]["duration_observed"] else None)
            ids = [f["observation"]["request_id"] for f in source["frames"]]
            assert len(ids) == len(set(ids))
            previous = 0
            for frame in source["frames"]:
                obs = frame["observation"]
                assert previous <= obs["request_started_ms"] <= obs["response_received_ms"] == frame["t_ms"] <= obs["geometry_validated_ms"] <= source["end"]["duration_ms"]
                previous = obs["geometry_validated_ms"]
            for n, row in enumerate(rows):
                ref = row["source"]
                frame = source["frames"][ref["seq"]-1]
                assert ref == {key: frame[key] for key in ("seq", "t_ms", "observation")}
                assert row["normalization_hold"] == (n > 0 and rows[n-1]["source"]["seq"] == ref["seq"])
                if row["final_observation_visibility"]:
                    final_rows.append(n)
                    assert n == len(rows)-1 and frame["observation"]["purpose"] == "final"
                    q = 10 if meta["settings"]["format"] == "gif" else 1
                    exact = Fraction(frame["t_ms"])
                    assert Fraction(row["pts_ms"]) == -((-exact)//q)*q and row["duration_ms"] == q
                    assert 0 <= end-Fraction(source["end"]["duration_ms"]) < 2*q
                    assert not any(r["source"]["seq"] == ref["seq"] for r in rows[:n])
            if source["end"]["final_observation"]["disposition"] == "persisted_without_end":
                assert meta["partial"] and "observed_source_end_ms" not in meta
                assert source["end"]["stop_requested_ms"] is None and source["end"]["counters"] is None
                assert source["end"]["cutoff"]["provenance"] == "durable_lower_bound"
            if source["end"]["reason"] == "deadline":
                assert not final_rows and end <= source["end"]["duration_ms"]
            if source["frames"][-1]["observation"]["purpose"] == "final":
                assert any(r["source"]["seq"] == source["frames"][-1]["seq"] for r in rows)
        else:
            assert meta["provenance"] == "offline_unverified" and "backend" not in meta
            assert all("source" not in r and not r["final_observation_visibility"] for r in rows)
    else:
        assert meta["schema_version"] == 1 and source["protocol_version"] == 1
        assert "backend" not in source and source["clock"]["origin"] == "before_start_screencast"
        assert all(r["schema_version"] == 1 and "source" not in r and "final_observation_visibility" not in r for r in rows)
    return {"video": str(video), "schema_version": meta["schema_version"], "format": meta["settings"]["format"], "sha256": meta["video"]["sha256"], "end_ms": str(end), "partial": meta["partial"], "frames": len(rows), "final_visibility_rows": final_rows}


if __name__ == "__main__":
    paths = sorted({p for root in sys.argv[1:] for p in pathlib.Path(root).rglob("*.metadata.json")})
    assert paths, "explicit artifact directories must contain actual media sidecars"
    results = [check(p) for p in paths]
    print(json.dumps({"status": "pass", "scope": "Synthetic media only; not live feature acceptance", "artifacts": results}, ensure_ascii=False, indent=2))
