"""Simulate what the UI sends - no denoise field, no promptText for voxcpm:auto."""
import json
import sys
import time
import urllib.request
import base64

OPENMAIC_URL = "http://127.0.0.1:3000/api/generate/tts"

with open(r"D:\AItrade\openmaic\VoxCPM\examples\reference_speaker.wav", "rb") as f:
    ref_b64 = base64.b64encode(f.read()).decode("ascii")


def http_json(url, payload, timeout=1500):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


# Simulate what a real UI request looks like (based on dev.log observation):
# - voiceMode: "clone"
# - promptText: "你好世界" (or similar)
# - referenceAudioBase64
# - NO denoise field (relies on default false)
payload = {
    "text": "这是模拟 UI 实际请求的测试。",
    "audioId": "simulated-ui-001",
    "ttsProviderId": "voxcpm-tts",
    "ttsVoice": "voxcpm:auto",
    "ttsModelId": "voxcpm-tts",
    "ttsProviderOptions": {
        "voiceMode": "clone",
        "voicePrompt": "natural classroom voice",
        "promptText": "你好，世界。",
        "referenceAudioBase64": ref_b64,
        "referenceAudioMimeType": "audio/wav",
        "referenceAudioName": "reference_speaker.wav",
        "cfgValue": 2.0,
        "inferenceTimesteps": 10,
        "normalize": False,
        # NOTE: no denoise field — should default to false
    },
    "ttsSpeed": 1.0,
}

print("POST /api/generate/tts (UI default, no denoise field)...")
t0 = time.time()
status, body = http_json(OPENMAIC_URL, payload)
dt = time.time() - t0
print(f"status={status} bytes={len(body)} dt={dt:.1f}s")
if status != 200:
    print(body.decode("utf-8", errors="replace"))
    sys.exit(1)
obj = json.loads(body)
print(f"success={obj.get('success')} format={obj.get('format')} base64len={len(obj.get('base64', ''))}")
