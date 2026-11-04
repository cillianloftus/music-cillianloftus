import type { APIRoute } from 'astro';
import { decodeDefinition, encodeDefinition } from '../../lib/query/builder';
import { interpret, InterpretError } from '../../lib/query/interpret';
import { definitionSchema, type Definition } from '../../lib/query/schema';

/**
 * Natural language in, definition out (ARCHITECTURE.md §4). Behind Access:
 * every call can cost a model run. A form post from /query, answered with a
 * redirect to the builder showing the new definition as chips, so a
 * misreading is fixed by editing a chip, and Back undoes a bad sentence.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const utterance = form.get('utterance')?.toString() ?? '';
  const encoded = form.get('d')?.toString() ?? '';
  const saved = form.get('saved')?.toString();

  let current: Definition | null = null;
  if (encoded && form.get('fresh') !== 'on') {
    try {
      const parsed = definitionSchema.safeParse(decodeDefinition(encoded));
      if (parsed.success) current = parsed.data;
    } catch {
      // Unreadable: interpret from scratch.
    }
  }

  const back = (params: Record<string, string>) =>
    redirect(`/query?${new URLSearchParams({ ...params, ...(saved ? { saved } : {}), asked: utterance.slice(0, 500) })}`, 303);

  try {
    const result = await interpret(utterance, current);
    const params: Record<string, string> = { d: encodeDefinition(result.definition) };
    if (result.snaps.length) params.heard = JSON.stringify(result.snaps);
    return back(params);
  } catch (error) {
    const message = error instanceof InterpretError ? error.message : 'The interpreter is unavailable right now. The filters still work.';
    if (!(error instanceof InterpretError)) console.error('Interpretation failed', error);
    return back({ ...(encoded ? { d: encoded } : {}), ask_error: message });
  }
};
