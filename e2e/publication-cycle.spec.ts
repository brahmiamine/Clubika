import { randomBytes } from 'node:crypto';
import { authedContext, createAccount, expect, test } from './fixtures';

/**
 * Parcours E2E n°1, 2 et 3 de l'issue #207 : un événement créé par l'administrateur ne doit
 * apparaître dans /mon-planning qu'après publication globale, la personne affectée doit
 * pouvoir y répondre une fois publié, et la fonction réellement affectée doit y être affichée
 * (issue #210).
 */
test('un dirigeant ne voit rien avant publication puis répond après (issue #207)', async ({ browser, club, adminPage }) => {
  const lieu = `Terrain E2E ${randomBytes(4).toString('hex')}`;
  const encadrant = await createAccount('dirigeant', club.clubId, ['encadrant']);
  const dirigeantContext = await authedContext(browser, encadrant);
  const dirigeantPage = await dirigeantContext.newPage();

  try {
    const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const date = `${String(futureDate.getDate()).padStart(2, '0')}/${String(futureDate.getMonth() + 1).padStart(2, '0')}/${futureDate.getFullYear()}`;

    const createResponse = await adminPage.request.post('/api/entrainements', {
      data: {
        date,
        time: '18:00',
        lieu,
        categorie: 'U15',
        encadrants: [{ nom: encadrant.user.nom, personId: encadrant.user.id, personType: 'encadrant' }],
      },
    });
    expect(createResponse.ok()).toBe(true);

    // Avant publication : le brouillon n'est visible que côté admin, jamais dans
    // /mon-planning (contrat central de la publication globale, issue #197).
    await dirigeantPage.goto('/mon-planning');
    await expect(dirigeantPage.getByText(lieu)).toHaveCount(0);

    const publishResponse = await adminPage.request.post('/api/planning/publication-all');
    expect(publishResponse.ok()).toBe(true);

    // Après publication : l'événement apparaît, avec la fonction réellement affectée
    // (issue #210), et peut être accepté.
    await dirigeantPage.reload();
    await expect(dirigeantPage.getByText(lieu)).toBeVisible();
    await expect(dirigeantPage.getByText('Encadrant', { exact: true })).toBeVisible();

    await dirigeantPage.getByRole('button', { name: 'Accepter' }).click();
    await expect(dirigeantPage.getByText('Affectation acceptée')).toBeVisible();
    await expect(dirigeantPage.getByText('Acceptée', { exact: true })).toBeVisible();
  } finally {
    await dirigeantContext.close();
    await encadrant.cleanup();
  }
});
