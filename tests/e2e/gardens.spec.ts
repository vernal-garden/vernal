import { test, expect } from '@playwright/test';
import { resetTestDb, createTestUser, closePool } from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

test.describe('garden API — authenticated user', () => {
  let userEmail: string;
  let userPassword: string;

  test.beforeAll(async () => {
    const user = await createTestUser({
      email: 'garden-user@example.com', password: 'Garden123!'
    });
    userEmail = user.email;
    userPassword = user.password;
  });

  // The built-in `request` fixture is test-scoped, not shared with beforeAll —
  // logging in here (not in beforeAll) re-authenticates on the exact fixture
  // instance each test actually uses.
  test.beforeEach(async ({ request }) => {
    await request.post('/api/auth/login',
      { data: { email: userEmail, password: userPassword } });
  });

  test('create a garden', async ({ request }) => {
    const response = await request.post('/api/gardens', {
      data: { name: 'My Backyard', style: 'grid', zone: '7b',
              growingMethod: 'raised_bed' },
    });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.name).toBe('My Backyard');
    expect(body.style).toBe('grid');
    expect(body.id).toBeTruthy();
  });

  test('list gardens includes the one just created', async ({ request }) => {
    const response = await request.get('/api/gardens');
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).data.length).toBeGreaterThan(0);
  });

  test('create a bed in the garden', async ({ request }) => {
    const { data } = await (await request.get('/api/gardens')).json();
    const gardenId = data[0].id;
    const response = await request.post(`/api/gardens/${gardenId}/beds`, {
      data: { type: 'grid', label: 'Raised Bed 1',
              grid: { x: 0, y: 0, cols: 4, rows: 8 } },
    });
    expect(response.status()).toBe(201);
    expect((await response.json()).label).toBe('Raised Bed 1');
  });

  test('second user cannot access first user\'s garden', async ({ request }) => {
    const { data } = await (await request.get('/api/gardens')).json();
    const gardenId = data[0].id;
    const other = await createTestUser({ email: 'intruder@example.com' });
    await request.post('/api/auth/login',
      { data: { email: other.email, password: other.password } });
    const response = await request.get(`/api/gardens/${gardenId}`);
    expect(response.status()).toBe(404);
  });
});
