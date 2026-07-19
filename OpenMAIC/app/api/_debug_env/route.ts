export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    TTS_VOXCPM_BACKEND: process.env.TTS_VOXCPM_BACKEND ?? null,
    TTS_VOXCPM_BASE_URL: process.env.TTS_VOXCPM_BASE_URL ?? null,
    ALLOW_LOCAL_NETWORKS: process.env.ALLOW_LOCAL_NETWORKS ?? null,
  });
}
