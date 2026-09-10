import { request } from '@playwright/test';

export async function loginAs(
  baseURL: string, email: string, password: string
): Promise<string> {
  const ctx = await request.newContext({ baseURL });
  const response = await ctx.post('/api/auth/login', { data: { email, password } });
  if (!response.ok()) {
    throw new Error(`Login failed: ${response.status()} for ${email}`);
  }
  const cookies = response.headers()['set-cookie'] ?? '';
  await ctx.dispose();
  return cookies;
}
