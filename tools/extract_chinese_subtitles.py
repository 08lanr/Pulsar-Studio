from pathlib import Path
from difflib import SequenceMatcher
import re
import sys

import cv2
from rapidocr_onnxruntime import RapidOCR


VIDEO = Path(r"C:\Users\ruobi\Downloads\Video Project 2.mp4")
OUT = Path(r"C:\Users\ruobi\OneDrive\Desktop\Github\Pulsar-Studio\video_output")
SAMPLE_SECONDS = 1.0
CHINESE = re.compile(r"[\u3400-\u9fff]")


def clean_text(text):
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"^[^\u3400-\u9fff]+|[^\u3400-\u9fff！？。，、：；“”‘’…—]+$", "", text)
    return text


def stamp(seconds):
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".codex-tools" / "ocr"))
    cap = cv2.VideoCapture(str(VIDEO))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    duration = total / fps
    engine = RapidOCR()
    samples = []
    sample_every = max(1, round(fps * SAMPLE_SECONDS))
    frame_no = 0
    max_frames = round(min(duration, 300.0) * fps)
    while frame_no < max_frames:
        ok = cap.grab()
        if not ok:
            break
        if frame_no % sample_every:
            frame_no += 1
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break
        t = frame_no / fps
        h, w = frame.shape[:2]
        crop = frame[int(h * 0.78):int(h * 0.995), :]
        crop = cv2.resize(crop, (960, crop.shape[0] // 2), interpolation=cv2.INTER_AREA)
        result, _ = engine(crop)
        candidates = []
        if result:
            for box, text, score in result:
                cleaned = clean_text(text)
                if score >= 0.45 and CHINESE.search(cleaned):
                    y = sum(pt[1] for pt in box) / 4
                    candidates.append((y, cleaned, score))
        candidates.sort(key=lambda x: x[0])
        # The burned-in Chinese line is above the English translation. Join split OCR boxes.
        text = "".join(item[1] for item in candidates)
        samples.append((t, text))
        if int(t * 10) % 200 == 0:
            print(f"processed {t:.1f}/{min(duration, 300):.1f}s", flush=True)
        frame_no += 1
    cap.release()

    segments = []
    current = None
    for t, text in samples:
        if not text:
            if current and t - current["last"] > 0.8:
                segments.append(current)
                current = None
            continue
        if current and SequenceMatcher(None, current["text"], text).ratio() >= 0.72:
            if len(text) > len(current["text"]):
                current["text"] = text
            current["last"] = t
        else:
            if current:
                segments.append(current)
            current = {"start": t, "last": t, "text": text}
    if current:
        segments.append(current)

    # Remove very short OCR noise and repeated adjacent detections.
    cleaned = []
    for seg in segments:
        if len(seg["text"]) < 2:
            continue
        seg["end"] = min(seg["last"] + SAMPLE_SECONDS, 300.0)
        if cleaned and seg["text"] == cleaned[-1]["text"] and seg["start"] - cleaned[-1]["end"] < 1.0:
            cleaned[-1]["end"] = seg["end"]
        else:
            cleaned.append(seg)

    OUT.mkdir(parents=True, exist_ok=True)
    for clip in range(5):
        base = clip * 60
        rows = [s for s in cleaned if s["start"] < base + 60 and s["end"] > base]
        txt_lines = []
        srt_lines = []
        for idx, seg in enumerate(rows, 1):
            start = max(0, seg["start"] - base)
            end = min(60, seg["end"] - base)
            txt_lines.append(f"[{stamp(start).replace(',', '.')[:-1]}] {seg['text']}")
            srt_lines.extend([str(idx), f"{stamp(start)} --> {stamp(end)}", seg["text"], ""])
        stem = f"Video_Project_2_clip_{clip + 1:02d}_Chinese_subtitles"
        (OUT / f"{stem}.txt").write_text("\n".join(txt_lines) + "\n", encoding="utf-8-sig")
        (OUT / f"{stem}.srt").write_text("\n".join(srt_lines), encoding="utf-8-sig")
        print(f"clip {clip + 1}: {len(rows)} subtitle lines")


if __name__ == "__main__":
    main()
