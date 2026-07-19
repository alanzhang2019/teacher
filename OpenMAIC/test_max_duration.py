"""Quick test: trigger a /api/generate/tts request with normal text (auto mode)
to verify whether the new maxDuration=1500s is now in effect.
"""
import json
import time
import urllib.request

OPENMAIC_URL = "http://127.0.0.1:3000/api/generate/tts"


def http_json(url, payload, timeout=300):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


payload = {
    "text": "测试一下新的 maxDuration 是否生效。",
    "audioId": "max-duration-check-001",
    "ttsProviderId": "voxcpm-tts",
    "ttsVoice": "voxcpm:auto",
    "ttsModelId": "voxcpm-tts",
    "ttsProviderOptions": {
        "voicePrompt": "natural classroom voice",
    },
    "ttsSpeed": 1.0,
}
print("POST /api/generate/tts ...")
t0 = time.time()
try:
    status, body = http_json(OPENMAIC_URL, payload, timeout=400)
except urllib.error.HTTPError as e:
    print(f"HTTPError: {e.code} {e.reason} (elapsed {time.time()-t0:.1f}s)")
    print(e.read().decode()[:500])
    raise SystemExit(1)
print(f"status={status} bytes={len(body)} dt={time.time()-t0:.1f}s")
