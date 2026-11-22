/**
 * What a URL carries that must never be printed or recorded: userinfo and
 * credential-looking parameters. Kept apart from the HTTP client so the
 * config schema can apply the same rule without importing the client.
 */

/**
 * A parameter is a credential when its name, lowercased with separators
 * removed, contains one of these stems (`sig` covers `signature`), starts
 * with a cloud provider's signing prefix, or is exactly `code` (an OAuth
 * authorization code; matching it inside `encode` or `zipcode` would mostly
 * be noise). The match is broad on purpose: a list of names always misses
 * one, and `keyword` or `author` shown as `***` costs nothing.
 */
const CREDENTIAL_STEMS = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'key',
  'sig',
  'auth',
  'credential',
  'session',
  'jwt',
];
const CREDENTIAL_PREFIXES = ['xamz', 'xgoog'];

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function isCredentialName(name: string): boolean {
  const normalized = decodeName(name)
    .toLowerCase()
    .replace(/[\s._-]+/g, '');
  return (
    normalized === 'code' ||
    CREDENTIAL_STEMS.some((stem) => normalized.includes(stem)) ||
    CREDENTIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * `name=value` in a query, a fragment (OAuth implicit flows put tokens
 * there), or a path parameter (`;jsessionid=`), found in the text as
 * written so nothing else in the URL is re-encoded.
 */
const URL_PARAMETER = /([?&#;])([^=&#;?\s]+)=([^&#;?\s]*)/g;

/**
 * What in a URL is a credential: `userinfo` for a user name or password,
 * then the name of each credential-looking parameter. Empty for a URL safe
 * to request and record. The HTTP client refuses a requested URL that has
 * any, and the config schema refuses one in every URL-valued key.
 */
export function urlCredentials(url: URL): string[] {
  return [
    ...(url.username !== '' || url.password !== '' ? ['userinfo'] : []),
    ...[...`${url.pathname}${url.search}${url.hash}`.matchAll(URL_PARAMETER)]
      .map((match) => match[2] ?? '')
      .filter(isCredentialName),
  ];
}

/**
 * A URL safe to print: userinfo replaced by `***`, and the value of every
 * credential-looking parameter in the query, the fragment, or the path
 * replaced by `***`. Text that is not a URL gets the same treatment.
 */
export function redactUrl(value: string | URL): string {
  let text = String(value);

  try {
    const url = new URL(text);
    if (url.username !== '' || url.password !== '') {
      url.username = '***';
      url.password = '';
      text = url.href;
    }
  } catch {
    text = text.replace(/\/\/[^/@\s]*@/, '//***@');
  }

  return text.replace(URL_PARAMETER, (match, separator: string, name: string) =>
    isCredentialName(name) ? `${separator}${name}=***` : match
  );
}
