/**
 * Dev-only diagnostic endpoint: lists all TTS queue tasks together with the
 * on-disk presence of their `.wav` (if completed). Exists so a human can
 * quickly tell "is classroom-played audioId X actually on disk yet?" without
 * spelunking through server logs.
 *
 * This endpoint is intentionally not authenticated. It reveals only file
 * existence (yes/no) and task status — no audio content. The /api prefix
 * makes it usable from the browser console as `fetch('/api/dev/audio-status')`.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listTTSTasks } from '@/lib/server/tts-queue';

const PUBLIC_CACHE_DIR = path.join(process.cwd(), 'public', 'audio-cache');

export async function GET(): Promise<NextResponse> {
  try {
    const tasks = listTTSTasks();
    const enriched = await Promise.all(
      tasks.map(async (t) => {
        const wavPath = path.join(PUBLIC_CACHE_DIR, `${t.id}.wav`);
        let onDisk = false;
        let size = 0;
        try {
          const st = await fs.stat(wavPath);
          onDisk = st.isFile() && st.size > 0;
          size = st.size;
        } catch {
          // not on disk
        }
        return {
          id: t.id,
          status: t.status,
          createdAt: t.createdAt,
          completedAt: t.completedAt,
          onDisk,
          size,
          textPreview: t.input.text.slice(0, 30),
        };
      }),
    );
    // Sort: pending (oldest first) → processing → completed (newest first) → failed
    const order: Record<string, number> = {
      pending: 0,
      processing: 1,
      failed: 2,
      completed: 3,
    };
    enriched.sort((a, b) => {
      const o = order[a.status] - order[b.status];
      if (o !== 0) return o;
      if (a.status === 'completed') {
        return (b.completedAt ?? 0) - (a.completedAt ?? 0);
      }
      return a.createdAt - b.createdAt;
    });
    return NextResponse.json({
      success: true,
      total: enriched.length,
      pending: enriched.filter((t) => t.status === 'pending').length,
      processing: enriched.filter((t) => t.status === 'processing').length,
      completed: enriched.filter((t) => t.status === 'completed').length,
      failed: enriched.filter((t) => t.status === 'failed').length,
      onDisk: enriched.filter((t) => t.onDisk).length,
      tasks: enriched,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
