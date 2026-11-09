import type { APIRoute } from 'astro';
import { serveCover } from '../../../../../lib/import/coverart';

/** A cover, one version of it (art/release/<id>/<version>/<size>.jpg). */
export const GET: APIRoute = ({ params, request, locals }) => serveCover(request, locals, params.id, params.version ?? '', params.size);
