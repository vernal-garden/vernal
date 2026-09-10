import { test, expect } from '@playwright/test';
import { resetTestDb, createTestUser, createTestGarden, createTestSeed, closePool }
  from './helpers/db';

test.beforeAll(resetTestDb);
test.afterAll(closePool);

test('add a planting to a bed and retrieve it', async ({ request }) => {
  const user = await createTestUser({
    email: 'planting-user@example.com', password: 'Plant123!'
  });
  await request.post('/api/auth/login',
    { data: { email: user.email, password: user.password } });

  const gardenId = await createTestGarden(user.id, 'Planting Test Garden');
  const seedId = await createTestSeed(user.id, 'Genovese Basil');

  const bedResp = await request.post(`/api/gardens/${gardenId}/beds`, {
    data: { type: 'grid', label: 'Herb Bed',
            grid: { x: 0, y: 0, cols: 4, rows: 8 } },
  });
  expect(bedResp.status()).toBe(201);
  const bed = await bedResp.json();

  const plantingResp = await request.post(
    `/api/gardens/${gardenId}/beds/${bed.id}/plantings`,
    { data: { seedId, quantity: 3, plantingDate: '2026-05-01',
              cell: { x: 0, y: 0 } } }
  );
  expect(plantingResp.status()).toBe(201);
  const planting = await plantingResp.json();
  expect(planting.seedId).toBe(String(seedId));
  expect(planting.quantity).toBe(3);

  const list = await (await request.get(
    `/api/gardens/${gardenId}/beds/${bed.id}/plantings`
  )).json();
  expect(list.data.some((p: { id: string }) => p.id === planting.id)).toBe(true);
});
