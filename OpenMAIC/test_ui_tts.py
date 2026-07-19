"""Test the full Next.js TTS API endpoint with the python-api backend."""
import json
import sys
import time
import urllib.request

API = "http://127.0.0.1:3000/api/generate/tts"

body = {
    "text": "你好，这是一段测试语音。",
    "audioId": "preview",
    "ttsProviderId": "voxcpm-tts",
    "ttsModelId": "VoxCPM2",
    "ttsVoice": "voxcpm:auto",
    "ttsSpeed": 1.0,
    "ttsProviderOptions": {
        "backend": "python-api",
        "voiceMode": "prompt",
        "voicePrompt": "年轻女性，声音清亮",
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
            import base64
            audio = base64.b64decode(b64)
            out = r"D:\AItrade\openmaic\OpenMAIC\test_ui_route.wav"
            with open(out, "wb") as f:
                f.write(audio)
            print(f"SAVED: {out} ({len(audio)} bytes)")
except urllib.error.HTTPError as e:
    print(f"HTTP_ERROR: {e.code}")
    print(f"BODY: {e.read().decode('utf-8', errors='replace')}")
except Exception as e:
    print(f"ERROR: {e!r}")
    sys.exit(1)
