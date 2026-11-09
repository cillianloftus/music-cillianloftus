import type { APIRoute } from 'astro';
import { serveCover } from '../../../../lib/import/coverart';

/** A cover stored before covers were versioned (art/release/<id>/<size>.jpg). */
export const GET: APIRoute = ({ params, request, locals }) => serveCover(request, locals, params.id, null, params.size);
