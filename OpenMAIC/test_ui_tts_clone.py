"""Test with prompt continuation (reference audio + prompt text) for clone mode."""
import base64
import json
import sys
import time
import urllib.request

API = "http://127.0.0.1:3000/api/generate/tts"

# Use a short reference WAV (sine wave 1s at 16kHz, 16-bit PCM mono)
import struct
import math
sr = 16000
dur = 1.0
samples = []
for i in range(int(sr * dur)):
    samples.append(int(0.3 * 32767 * math.sin(2 * math.pi * 440 * i / sr)))

import io
import wave

buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(b"".join(struct.pack("<h", s) for s in samples))
ref_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

body = {
    "text": "你好，这是一段测试语音。",
    "audioId": "preview-clone",
    "ttsProviderId": "voxcpm-tts",
    "ttsModelId": "VoxCPM2",
    "ttsVoice": "voxcpm:profile:test1",
    "ttsSpeed": 1.0,
    "ttsProviderOptions": {
        "backend": "python-api",
        "voiceMode": "clone",
        "registeredVoiceId": "test1",
        "promptText": "测试参考文本",
        "referenceAudioBase64": ref_b64,
        "referenceAudioMimeType": "audio/wav",
        "referenceAudioName": "ref.wav",
        "cfgValue": 2.0,
        "inferenceTimesteps": 10,
        "normalize": False,
        "denoise": False,
    },
}

req = urllib.request.Request(
    API,
    data=json.dumps(body).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)

t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=360) as resp:
        text = resp.read().decode("utf-8")
        print(f"STATUS: {resp.status}")
        print(f"ELAPSED: {time.time() - t0:.1f}s")
        data = json.loads(text)
        print(f"SUCCESS: {data.get('success')}")
        print(f"AUDIO_ID: {data.get('audioId')}")
        print(f"FORMAT: {data.get('format')}")
        b64 = data.get("base64", "")
        print(f"BASE64_LEN: {len(b64)}")
        if b64:
            audio = base64.b64decode(b64)
            out = r"D:\AItrade\openmaic\OpenMAIC\test_ui_route_clone.wav"
            with open(out, "wb") as f:
                f.write(audio)
            print(f"SAVED: {out} ({len(audio)} bytes)")
except urllib.error.HTTPError as e:
    print(f"HTTP_ERROR: {e.code}")
    print(f"BODY: {e.read().decode('utf-8', errors='replace')[:1000]}")
except Exception as e:
    print(f"ERROR: {e!r}")
    sys.exit(1)
