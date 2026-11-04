import type { APIRoute } from 'astro';
import { safeReturnPath } from '../../lib/ratings';
import { THEME_COOKIE, themeFrom } from '../../lib/theme';

/** The no-JavaScript path for the theme toggle. */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData();
  cookies.set(THEME_COOKIE, themeFrom(form.get('theme')?.toString()), {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    secure: true,
  });
  return redirect(safeReturnPath(form.get('return_to'), '/'), 303);
};
