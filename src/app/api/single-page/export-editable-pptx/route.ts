import { exportEditablePptx } from '@/lib/server/exports';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 可编辑导出占位：501 EDITABLE_EXPORT_COMING_SOON */
export const POST = defineApiRoute(async (request) => {
  requireUser(request);
  exportEditablePptx();
}, { mutation: true });
