import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MentionsLegalesPage from '@/app/mentions-legales/page';
import ConfidentialitePage from '@/app/confidentialite/page';
import CguPage from '@/app/cgu/page';

describe('pages légales (issue #12)', () => {
  it('affiche mentions légales sans inventer d’éditeur', () => {
    const html = renderToStaticMarkup(<MentionsLegalesPage />);
    expect(html).toContain('Mentions légales');
    expect(html).toMatch(/identité de l’éditeur n’est pas configurée/i);
    expect(html).toContain('https://www.cnil.fr/fr/plaintes');
    expect(html).not.toMatch(/\[nom\]|lorem ipsum/i);
  });

  it('liste les traitements et le canal des droits', () => {
    const html = renderToStaticMarkup(<ConfidentialitePage />);
    expect(html).toContain('Confidentialité');
    expect(html).toContain('Fiches sans compte');
    expect(html).toContain('Chat');
    expect(html).toContain('href="/exercice-des-droits"');
    expect(html).toContain('Non qualifiée');
  });

  it('présente des CGU factuelles, pas un contrat validé', () => {
    const html = renderToStaticMarkup(<CguPage />);
    expect(html).toContain('Conditions d’utilisation');
    expect(html).toMatch(/revue humaine et juridique/i);
    expect(html).toMatch(/consentement universel/i);
  });
});
