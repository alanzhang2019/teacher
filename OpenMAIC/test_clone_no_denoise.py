"""Compare: clone mode with/without denoise + inference_timesteps"""
import json
import sys
import time
import urllib.request

OPENMAIC_URL = "http://127.0.0.1:3000/api/generate/tts"

# Use the example.wav shipped with VoxCPM as the reference audio
import base64
with open(r"D:\AItrade\openmaic\VoxCPM\examples\reference_speaker.wav", "rb") as f:
    ref_b64 = base64.b64encode(f.read()).decode("ascii")
print(f"reference audio: {len(ref_b64)} chars b64")


def http_json(url, payload, timeout=1500):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


# Test: clone mode + denoise=false, 10 timesteps
payload = {
    "text": "你好，这是一个克隆模式、关闭降噪的测试。",
    "audioId": "clone-no-denoise",
    "ttsProviderId": "voxcpm-tts",
    "ttsVoice": "voxcpm:auto",
    "ttsModelId": "voxcpm-tts",
    "ttsProviderOptions": {
        "voiceMode": "clone",
        "voicePrompt": "natural classroom voice",  # required by route for voxcpm:auto
        "promptText": "你好，世界。",
        "referenceAudioBase64": ref_b64,
        "referenceAudioMimeType": "audio/wav",
        "referenceAudioName": "reference_speaker.wav",
        "denoise": False,
        "cfgValue": 2.0,
        "inferenceTimesteps": 10,
        "normalize": False,
    },
    "ttsSpeed": 1.0,
}

print("POST /api/generate/tts (clone + denoise=false, 10 steps)...")
t0 = time.time()
status, body = http_json(OPENMAIC_URL, payload)
dt = time.time() - t0
print(f"status={status} bytes={len(body)} dt={dt:.1f}s")
if status != 200:
    print(body.decode("utf-8", errors="replace"))
    sys.exit(1)
obj = json.loads(body)
print(f"success={obj.get('success')} format={obj.get('format')} audioId={obj.get('audioId')} base64len={len(obj.get('base64', ''))}")
