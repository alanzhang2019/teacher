"""Quick TTS volume normalization test.

Submits 3 short clone TTS calls to the local VoxCPM API and reports the
final RMS / peak of each output WAV. After the server-side RMS normalize
fix in server.py, all three should be within ~1 dB of each other on RMS
(= perceived loudness); before the fix, raw output had a 7+ dB spread.
"""
import os
import sys
import wave
import numpy as np
import requests

REF = r'D:\AItrade\openmaic\VoxCPM\examples\example.wav'
URL = 'http://localhost:8000/tts/upload'
TEXTS = [
    '今天天气真不错，阳光明媚。',
    '人工智能技术发展迅速，正在改变各行各业的工作方式。',
    '请同学们翻开课本第三章，我们继续学习牛顿第二定律的应用。',
]


def rms_dbfs(wav_path: str) -> tuple[float, float]:
    with wave.open(wav_path, 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(pcm ** 2)))
    peak = float(np.max(np.abs(pcm)))
    rms_db = 20.0 * np.log10(rms) if rms > 0 else -120.0
    peak_db = 20.0 * np.log10(peak) if peak > 0 else -120.0
    return rms_db, peak_db, sr, len(pcm)


def main() -> int:
    out_dir = r'C:\tmp\voxcpm_vol_test'
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for i, text in enumerate(TEXTS):
        with open(REF, 'rb') as f:
            r = requests.post(
                URL,
                data={
                    'text': text,
                    'cfg_value': '2.0',
                    'inference_timesteps': '10',
                    'normalize': 'False',
                    'denoise': 'False',
                },
                files={'reference_audio': ('example.wav', f, 'audio/wav')},
                timeout=600,
            )
        r.raise_for_status()
        out = os.path.join(out_dir, f'vol_test_{i}.wav')
        with open(out, 'wb') as g:
            g.write(r.content)
        rms_db, peak_db, sr, n = rms_dbfs(out)
        print(f'#{i} text_len={len(text):>3d} size={len(r.content):>7d}  '
              f'rms={rms_db:+6.2f}dBFS  peak={peak_db:+6.2f}dBFS  '
              f'sr={sr} samples={n}  -> {out}')
        results.append((rms_db, peak_db))

    rms_dbs = [r[0] for r in results]
    spread = max(rms_dbs) - min(rms_dbs)
    print()
    print(f'RMS loudness spread across {len(results)} samples: {spread:.2f} dB '
          f'(target < 3 dB for "听起来音量一致")')
    return 0


if __name__ == '__main__':
    sys.exit(main())
