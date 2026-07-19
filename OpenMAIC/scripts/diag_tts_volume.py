"""Diagnose the volume of every cached TTS output."""
import os
import numpy as np
import soundfile as sf

os.chdir(r"D:\AItrade\openmaic\OpenMAIC\public\audio-cache")
files = sorted(f for f in os.listdir(".") if f.endswith(".wav"))
print(f"file                             dur(s)    peak     rms  crest(dB)  loud(dB)")
print("-" * 80)

results = []
for f in files:
    try:
        audio, sr = sf.read(f, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if len(audio) == 0:
            continue
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(audio ** 2)))
        loud_db = 20 * np.log10(rms) if rms > 0 else float("-inf")
        crest = 20 * np.log10(peak / rms) if rms > 0 else float("inf")
        results.append((f, len(audio) / sr, peak, rms, crest, loud_db))
        print(f"{f:<32} {len(audio) / sr:>7.2f}  {peak:>6.3f}  {rms:>7.4f}  {crest:>8.2f}  {loud_db:>9.2f}")
    except Exception as e:
        print(f"{f}: ERROR {e}")

print("-" * 80)
if results:
    peaks = [r[2] for r in results]
    rmss = [r[3] for r in results]
    louds = [r[5] for r in results]
    print(f"peak:  min={min(peaks):.3f}  max={max(peaks):.3f}  std={np.std(peaks):.3f}  (target=0.89)")
    print(f"rms :  min={min(rmss):.4f}  max={max(rmss):.4f}  std={np.std(rmss):.4f}  (target=0.10-0.15)")
    print(
        f"loud:  min={min(louds):>6.2f} dB  max={max(louds):>6.2f} dB  "
        f"spread={max(louds) - min(louds):.2f} dB  (>=6 dB spread = obviously uneven)"
    )
