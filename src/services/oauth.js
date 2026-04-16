/**
 * oauth.js — OAuth PKCE 授权流
 */

export function buildOAuthUrl(config) {
  const auth = new URL(config.oauthAuthUrl);
  const state = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID().replaceAll('-', '');

  localStorage.setItem('oauthState', state);
  localStorage.setItem('oauthVerifier', codeVerifier);

  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', config.oauthClientId);
  auth.searchParams.set('redirect_uri', config.oauthRedirect || location.origin + location.pathname);
  auth.searchParams.set('scope', config.oauthScope || 'openid profile');
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', codeVerifier);
  auth.searchParams.set('code_challenge_method', 'plain');
  return auth.toString();
}

export async function exchangeOAuthCode(code, config) {
  if (!code || !config.oauthTokenUrl) throw new Error('缺少 code 或 token URL');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.oauthClientId,
    redirect_uri: config.oauthRedirect || location.origin + location.pathname,
    code_verifier: localStorage.getItem('oauthVerifier') || '',
  });

  const res = await fetch(config.oauthTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error(`Token 交换失败: ${res.status}`);
  const data = await res.json();
  if (data.access_token) {
    localStorage.setItem('oauthToken', data.access_token);
  }
  return data;
}
