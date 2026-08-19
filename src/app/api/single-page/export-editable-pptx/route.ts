import { ApiError } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页可编辑导出占位：501（整套 deck 的可编辑导出已上线，见 deck/[id]/export-editable） */
export const POST = defineApiRoute(async (request) => {
  requireUser(request);
  throw new ApiError('EDITABLE_EXPORT_COMING_SOON', '单页可编辑导出即将上线', 501, false);
}, { mutation: true });
