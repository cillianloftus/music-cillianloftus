import type { APIRoute } from 'astro';
import { servePicture, waitUntilOf } from '../../../../lib/art-serve';

/** Serves a stored artist picture from R2. Named for where it came from and never written over, so it never changes. */
export const GET: APIRoute = ({ params, request, locals }) => {
  const file = params.file ?? '';
  if (!/^[0-9a-f]{16}\.jpg$/.test(file) || !/^[0-9a-f-]{1,64}$/i.test(params.id ?? '')) {
    return new Response('Not found', { status: 404 });
  }
  return servePicture(request, [`art/artist/${params.id}/${file}`], waitUntilOf(locals));
};
