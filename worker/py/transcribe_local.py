#!/usr/bin/env python3
"""Local transcription for Orb.IT: faster-whisper (CTranslate2), no network or API key needed.

Usage: transcribe_local.py AUDIO_F32LE_16K MODEL_DIR LANGUAGE

AUDIO is raw little-endian float32 mono at 16 kHz (the worker decodes it with ffmpeg).
Prints one JSON object on stdout:
  {"model": "...", "language": "en", "segments": [{"start":0.0,"end":1.2,"text":"...","avg_logprob":-0.2,
   "no_speech_prob":0.01}]}

There is no speaker separation: speakers stay unlabelled until a producer assigns them, exactly as with
OpenAI whisper-1. Use Deepgram when the instance needs automatic speaker separation.
"""
import json
import sys

import numpy as np

SR = 16000


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    audio_path, model_dir, language = sys.argv[1], sys.argv[2], sys.argv[3]
    from faster_whisper import WhisperModel

    audio = np.fromfile(audio_path, dtype=np.float32)
    log(f"audio seconds: {len(audio) / SR:.1f}")
    model = WhisperModel(model_dir, device="cpu", compute_type="int8")
    # English is pinned; Pidgin, mixed and Twi are left to detection.
    lang = "en" if language == "en" else None
    it, info = model.transcribe(audio, language=lang, vad_filter=False, condition_on_previous_text=False)
    segs = []
    total = max(1.0, len(audio) / SR)
    for s in it:
        text = s.text.strip()
        if not text:
            continue
        segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text,
                     "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob})
        log(f"progress {min(99, int(100 * s.end / total))}")
    print(json.dumps({"model": f"faster-whisper:{model_dir.rstrip('/').split('/')[-1]}",
                      "language": info.language, "segments": segs}))


if __name__ == "__main__":
    main()
