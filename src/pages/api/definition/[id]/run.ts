import type { APIRoute } from 'astro';
import { getDefinition } from '../../../../lib/definitions';
import { runDefinition } from '../../../../lib/query/run';

/** Public and read-only: runs a saved definition without the model. */
export const GET: APIRoute = async ({ params }) => {
  const saved = await getDefinition(params.id!);
  if (!saved) return Response.json({ error: 'Not found' }, { status: 404 });

  const results = await runDefinition(saved.definition, {
    userId: saved.user_id,
    pins: saved.pins,
    excludes: saved.excludes,
  });

  return Response.json({
    id: saved.id,
    name: saved.name,
    definition: saved.definition,
    results,
  });
};
