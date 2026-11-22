import { redirect } from '@sveltejs/kit';

import { GITHUB_CLIENT_ID } from '$lib/config';
import type { PageServerLoad } from './$types';

// Written from SvelteKit 2 knowledge: redirect() to any URL, external or not.
export const load: PageServerLoad = ({ url }) => {
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', new URL('/auth/callback', url.origin).href);
  redirect(302, authorize);
};
