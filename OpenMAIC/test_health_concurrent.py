"""Verify /health stays responsive while a long TTS inference is in flight.

This is the regression test for the watchdog-killed-busy-server bug.
"""
import json
import time
import threading
import urllib.request
import urllib.error

OPENMAIC_URL = "http://127.0.0.1:3000/api/generate/tts"
HEALTH_URL = "http://127.0.0.1:8000/health"


def http_json(url, payload, timeout=600):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def poll_health(stop_event, results):
    while not stop_event.is_set():
        t0 = time.time()
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=5) as r:
                results.append((time.time() - t0, r.status))
        except urllib.error.URLError as e:
            results.append((time.time() - t0, f"ERR: {e}"))
        time.sleep(2)


def main():
    payload = {
        "text": "这是一个并发测试，用来验证在语音合成过程中，健康检查端点仍然能够正常响应。",
        "audioId": "concurrent-test-001",
        "ttsProviderId": "voxcpm-tts",
        "ttsVoice": "voxcpm:auto",
        "ttsModelId": "voxcpm-tts",
        "ttsProviderOptions": {
            "voicePrompt": "用于验证健康检查在推理时仍能响应。",
        },
        "ttsSpeed": 1.0,
    }

    stop = threading.Event()
    results = []
    poll_thread = threading.Thread(target=poll_health, args=(stop, results))
    poll_thread.start()
    print(f"[t=0] T0 main: started /health poller (every 2s)")

    try:
        t0 = time.time()
        status, body = http_json(OPENMAIC_URL, payload)
        dt = time.time() - t0
        print(f"[t={dt:.1f}s] TTS status={status} bytes={len(body)}")
    finally:
        stop.set()
        poll_thread.join(timeout=10)

    # Stats
    n = len(results)
    n_ok = sum(1 for _, s in results if s == 200)
    n_err = n - n_ok
    if results:
        max_dt = max(dt for dt, _ in results)
        min_dt = min(dt for dt, _ in results)
        print(f"[done] /health polls: total={n} ok={n_ok} err={n_err} min_dt={min_dt:.3f}s max_dt={max_dt:.3f}s")
    if n_err == 0 and n > 0:
        print("PASS: /health stayed responsive throughout inference")
    else:
        print(f"FAIL: {n_err}/{n} /health polls failed during inference")
        for dt, s in results:
            if s != 200:
                print(f"  bad poll: dt={dt:.3f}s status={s}")


if __name__ == "__main__":
    main()
