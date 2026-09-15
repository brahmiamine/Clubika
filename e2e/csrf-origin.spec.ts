import { expect, test } from './fixtures';

test('un POST cookie-authenticated d’origine tierce est refusé (issue #35)', async ({ adminPage }) => {
  const response = await adminPage.request.post('/api/entrainements', {
    headers: { Origin: 'https://evil.example' },
    data: {
      date: '01/01/2099',
      time: '18:00',
      lieu: 'CSRF',
      categorie: 'U15',
      encadrants: [],
    },
  });
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: 'Origine non autorisée' });
});
