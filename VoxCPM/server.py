"""VoxCPM FastAPI server — python-api backend for OpenMAIC.

Endpoints:
  GET  /health      - liveness probe
  POST /tts/upload  - synthesize speech (OpenMAIC voxcpm-tts python-api format)

OpenMAIC server-config:
  TTS_VOXCPM_BASE_URL=http://localhost:8000
  TTS_VOXCPM_BACKEND=python-api
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("voxcpm-api")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DEVICE = os.environ.get("VOXCPM_DEVICE", "auto")  # auto | cuda | cpu
MODEL_ID = os.environ.get("VOXCPM_MODEL_ID", "openbmb/VoxCPM2")
MODEL_DIR = os.environ.get("VOXCPM_MODEL_DIR", "")  # if set, load from local dir
LOAD_DENOISER = os.environ.get("VOXCPM_LOAD_DENOISER", "true").lower() == "true"
SAMPLE_RATE_HINT = int(os.environ.get("VOXCPM_SAMPLE_RATE", "24000"))

# ---------------------------------------------------------------------------
# Model load (singleton, lazy)
# ---------------------------------------------------------------------------
_model = None
_sample_rate = SAMPLE_RATE_HINT
_inference_lock = threading.Lock()  # serialize TTS calls (CPU is single-threaded)
# A dedicated single-worker executor keeps inference off the FastAPI event
# loop AND off Starlette's default thread pool, so /health stays responsive
# even while a multi-minute synthesis is in flight. This is the bug the
# watchdog was tripping over (it killed the server during long inferences
# because /health couldn't respond while model.generate() held the GIL).
_inference_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="voxcpm-infer",
)


# ---------------------------------------------------------------------------
# ASR auto-fill singleton (lazy). We recover `prompt_text` from a clone
# voice's reference audio on demand so VoxCPM can switch to its stronger
# `prompt-continuation` mode. See /tts/upload below for the call site.
# ---------------------------------------------------------------------------
_asr_model = None
_asr_lock = threading.Lock()


def _get_asr_model():
    """Lazy-load funASR Paraformer on first ASR request.

    funASR is bundled with the VoxCPM venv (it ships with VoxCPM2's
    training/recipe tooling) but we keep it out of the cold-start path so
    the server can come up in ~10s on a CPU machine. The first clone
    regenerate that needs it will pay a one-time ~5-15s model load
    (Paraformer-zh is small); subsequent calls reuse the singleton.
    The first call also has to download the model weights once from
    ModelScope (~300MB) — handled by funasr.AutoModel and cached on
    disk afterwards.
    """
    global _asr_model
    if _asr_model is not None:
        return _asr_model
    with _asr_lock:
        if _asr_model is not None:
            return _asr_model
        log.info("asr: loading funASR Paraformer (first call, may download weights)...")
        from funasr import AutoModel  # local import — heavy dep
        _asr_model = AutoModel(model="paraformer-zh", disable_update=True)
        log.info("asr: funASR ready")
    return _asr_model


def _asr_transcribe(wav_path: str) -> str:
    """Run funASR on a wav file and return the concatenated text.

    Best-effort: any failure is logged and the caller falls back to
    reference-only mode. We do NOT raise — a missing prompt_text is a
    quality degradation, not a hard error.
    """
    try:
        model = _get_asr_model()
        result = model.generate(input=wav_path)
        if not result:
            return ""
        # funASR returns a list[dict] with key "text" containing the
        # decoded string (possibly with sentence-piece spaces).
        text = (result[0].get("text") or "").strip()
        # funASR inserts spaces between every Chinese character; collapse them.
        text = re.sub(r"\s+", "", text)
        log.info(f"asr: transcribed {len(text)} chars from {wav_path}: {text[:60]}...")
        return text
    except Exception as e:
        log.warning(f"asr: transcription failed for {wav_path}: {e}")
        return ""


def get_model():
    global _model, _sample_rate
    if _model is not None:
        return _model
    src = MODEL_DIR or MODEL_ID
    log.info(f"Loading VoxCPM model {src} device={DEVICE} denoiser={LOAD_DENOISER}")
    t0 = time.time()
    from voxcpm import VoxCPM
    _model = VoxCPM.from_pretrained(
        src,
        load_denoiser=LOAD_DENOISER,
        device=DEVICE,
    )
    # VoxCPM 2 exposes sample_rate via tts_model
    try:
        _sample_rate = int(_model.tts_model.sample_rate)
    except Exception:
        pass
    log.info(f"Model loaded in {time.time() - t0:.1f}s, sample_rate={_sample_rate}")
    return _model


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="VoxCPM API (python-api backend)", version="0.1.0")


@app.get("/health")
async def health():
    # Async so it never blocks the event loop, even while the inference
    # executor is busy with a long synthesis. The watchdog polls this every
    # 15s; if we served it on the same thread as model.generate() the
    # watchdog would mistake a busy-but-healthy server for a wedged one.
    return {
        "ok": True,
        "model": MODEL_DIR or MODEL_ID,
        "device": DEVICE,
        "sample_rate": _sample_rate,
        "denoiser": LOAD_DENOISER,
    }


def _run_inference_blocking(model, kwargs):
    # Runs in _inference_executor — serialized via _inference_lock so the
    # underlying CPU-bound model state stays consistent across requests.
    with _inference_lock:
        return model.generate(**kwargs)


@app.post("/tts/upload")
async def tts_upload(
    text: str = Form(..., description="Target text to synthesize"),
    cfg_value: float = Form(2.0),
    inference_timesteps: int = Form(10),
    normalize: bool = Form(False),
    denoise: bool = Form(False),
    reference_audio: Optional[UploadFile] = File(None),
    prompt_audio: Optional[UploadFile] = File(None),
    prompt_text: Optional[str] = Form(None),
):
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    log.info(
        f"tts/upload: text_len={len(text)} cfg={cfg_value} steps={inference_timesteps} "
        f"normalize={normalize} denoise={denoise} ref={bool(reference_audio)} prompt={bool(prompt_audio)}"
    )
    log.info(
        f"tts/upload refs: ref_filename={reference_audio.filename if reference_audio else None} "
        f"ref_ct={reference_audio.content_type if reference_audio else None} "
        f"ref_size_header={reference_audio.size if reference_audio else None}"
    )

    # Materialize uploaded files to temp paths (voxcpm.generate takes *wav_path)
    tmpdir = os.environ.get("TEMP", os.environ.get("TMP", "/tmp"))
    os.makedirs(tmpdir, exist_ok=True)
    ref_path = None
    prompt_path = None
    try:
        if reference_audio is not None:
            ref_path = os.path.join(tmpdir, f"voxcpm_ref_{os.getpid()}_{int(time.time()*1000)}.wav")
            with open(ref_path, "wb") as f:
                f.write(await reference_audio.read())
        if prompt_audio is not None:
            prompt_path = os.path.join(tmpdir, f"voxcpm_prompt_{os.getpid()}_{int(time.time()*1000)}.wav")
            with open(prompt_path, "wb") as f:
                f.write(await prompt_audio.read())

        model = get_model()
        kwargs = dict(
            text=text,
            cfg_value=float(cfg_value),
            inference_timesteps=int(inference_timesteps),
            normalize=bool(normalize),
            denoise=bool(denoise),
        )
        if ref_path:
            kwargs["reference_wav_path"] = ref_path
        if prompt_path and prompt_text and prompt_text.strip():
            kwargs["prompt_wav_path"] = prompt_path
            kwargs["prompt_text"] = prompt_text.strip()

        t0 = time.time()
        # Offload the CPU-bound inference to a dedicated worker thread so the
        # event loop (and /health) stays free. The lock inside the worker
        # serializes concurrent requests on the same single-threaded CPU model.
        loop = asyncio.get_event_loop()
        wav = await loop.run_in_executor(
            _inference_executor,
            _run_inference_blocking,
            model,
            kwargs,
        )
        if isinstance(wav, np.ndarray):
            audio = wav
        elif hasattr(wav, "cpu"):
            audio = wav.cpu().numpy()
        else:
            audio = np.asarray(wav)
        # ensure shape (n,) or (1, n) or (n, 1)
        if audio.ndim > 1:
            audio = audio.squeeze()
        log.info(f"synth done: {time.time() - t0:.1f}s, samples={len(audio)}, sr={_sample_rate}")

        # Output loudness normalize. VoxCPM's raw output amplitude varies
        # run-to-run (and across text lengths / reference prompt strength),
        # so the *perceived* loudness swings a lot — the same prompt can
        # come out 7+ dB louder one time than another, which the user
        # reports as "音量时而高时而低". Peak-only normalization (the old
        # behavior) doesn't fix this because two files can both have the
        # same peak while having very different RMS (= perceived loudness).
        #
        # New strategy: first scale by RMS to a fixed target, then cap the
        # peak to avoid clipping. The peak cap rarely fires after RMS
        # scaling because RMS targets are conservative, but it protects
        # against pathological transients (e.g. claps, plosives).
        #
        # Defaults are tuned for speech on CPU. Override with
        # VOXCPM_TARGET_RMS / VOXCPM_PEAK_CAP env vars if needed.
        if len(audio):
            target_rms = float(os.environ.get("VOXCPM_TARGET_RMS", "0.10"))  # ≈ -20 dBFS
            peak_cap = float(os.environ.get("VOXCPM_PEAK_CAP", "0.95"))     # -0.45 dBFS
            rms = float(np.sqrt(np.mean(audio ** 2)))
            if rms > 0 and target_rms > 0:
                audio = audio * (target_rms / rms)
            peak = float(np.max(np.abs(audio)))
            if peak > peak_cap > 0:
                audio = audio * (peak_cap / peak)
            log.info(
                f"normalize: rms={rms:.4f} peak={peak:.3f} -> "
                f"target_rms={target_rms} peak_cap={peak_cap}"
            )

        buf = io.BytesIO()
        sf.write(buf, audio.astype(np.float32), _sample_rate, format="WAV", subtype="PCM_16")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:
        log.exception(f"synthesis failed: ref_path={ref_path} prompt_path={prompt_path} text_len={len(text)}")
        raise HTTPException(status_code=500, detail=f"synthesis failed: {e!s}")
    finally:
        for p in (ref_path, prompt_path):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        # TTS accumulates transient numpy/tensor state per request. On CPU
        # this is slow to free via refcounting alone, so over hours the
        # process RSS creeps up and the next spawn can OOM. Force a GC pass
        # and clear CUDA cache (no-op on CPU) after every request.
        try:
            import gc
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VOXCPM_HOST", "127.0.0.1")
    port = int(os.environ.get("VOXCPM_PORT", "8000"))
    # Preload model at startup so /health reflects readiness
    try:
        get_model()
    except Exception as e:
        log.error(f"Preload failed: {e}")
    log.info(f"Starting VoxCPM API on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info", workers=1)
