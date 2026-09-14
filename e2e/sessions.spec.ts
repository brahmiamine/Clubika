import { test, expect } from './fixtures';

test('le profil affiche les sessions actives et permet de révoquer cet appareil (issue #29)', async ({ adminPage }) => {
  await adminPage.goto('/club/profil');
  await expect(adminPage.getByRole('heading', { name: 'Sessions actives' })).toBeVisible();
  await expect(adminPage.getByText('cet appareil')).toBeVisible();
  await adminPage.getByRole('button', { name: 'Révoquer' }).click();
  await expect(adminPage.getByRole('heading', { name: 'Sessions actives' })).toBeVisible();
});
