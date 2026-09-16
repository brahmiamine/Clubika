import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function workflowSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/tenant-offboarding.yml'),
    'utf8',
  );
}

describe('tenant offboarding workflow (issue #25)', () => {
  it('désactive le job planifié tant que la cible n’est pas explicitement activée', () => {
    const workflow = workflowSource();
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' || vars.CLUBIKA_SCHEDULE_ENABLED == 'true'",
    );
  });

  it('garde un préflight sans journaliser le secret', () => {
    const workflow = workflowSource();
    expect(workflow).toContain('CLUBIKA_BASE_URL');
    expect(workflow).toContain('CLUBIKA_CRON_SECRET');
    expect(workflow).toContain('Authorization: Bearer ${CRON_SECRET}');
    expect(workflow).not.toContain('echo "$CRON_SECRET"');
    expect(workflow).not.toContain('echo "${CRON_SECRET}"');
  });
});
