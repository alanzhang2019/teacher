"""End-to-end TTS test simulating the UI flow.

1. POST /api/generate/tts (OpenMAIC route, server-side backend override)
2. If the OpenMAIC route is happy with the response, the underlying VoxCPM
   python-api backend was hit and synthesized speech.
"""
import json
import sys
import time
import urllib.request
import urllib.parse
import wave
import io

OPENMAIC_URL = "http://127.0.0.1:3000/api/generate/tts"
VOXCPM_URL = "http://127.0.0.1:8000/health"


def http_json(url, payload, timeout=600):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def main():
    # 0) backend up?
    try:
        with urllib.request.urlopen(VOXCPM_URL, timeout=10) as r:
            print(f"[0] voxcpm /health -> {r.status}: {r.read().decode()}")
    except Exception as e:
        print(f"[0] voxcpm /health FAILED: {e}")
        sys.exit(2)

    # 1) call OpenMAIC tts route (mimic UI store payload)
    payload = {
        "text": "这是一个端到端测试，用来验证 VoxCPM python-api 后端工作正常。",
        "audioId": "test-audio-001",
        "ttsProviderId": "voxcpm-tts",
        "ttsVoice": "voxcpm:auto",
        "ttsModelId": "voxcpm-tts",
        "ttsProviderOptions": {
            # no "backend" field on purpose — server should fall back to env.
            "voicePrompt": "这是一段参考文本，用于克隆音色。",
        },
        "ttsSpeed": 1.0,
    }
    print("[1] POST /api/generate/tts ...")
    t0 = time.time()
    try:
        status, body = http_json(OPENMAIC_URL, payload)
    except Exception as e:
        print(f"[1] FAILED: {e}")
        sys.exit(3)
    dt = time.time() - t0
    print(f"[1] status={status} bytes={len(body)} dt={dt:.1f}s")

    if status != 200:
        print(body.decode("utf-8", errors="replace"))
        sys.exit(4)

    obj = json.loads(body)
    if not obj.get("success"):
        print("response not success:", obj)
        sys.exit(5)

    b64 = obj.get("base64", "")
    fmt = obj.get("format", "")
    audio_id = obj.get("audioId", "")
    if not b64:
        print("no base64 in response:", obj)
        sys.exit(6)

    import base64
    raw = base64.b64decode(b64)
    print(f"[2] decoded {len(raw)} bytes of {fmt} audio (audioId={audio_id})")

    # quick sanity: WAV header
    if fmt == "wav" and raw[:4] == b"RIFF":
        with wave.open(io.BytesIO(raw), "rb") as w:
            print(f"[2] wav: channels={w.getnchannels()} rate={w.getframerate()} frames={w.getnframes()} dur={w.getnframes()/w.getframerate():.2f}s")
    else:
        print(f"[2] (non-wav) header bytes: {raw[:8].hex()}")

    print("OK")


if __name__ == "__main__":
    main()
