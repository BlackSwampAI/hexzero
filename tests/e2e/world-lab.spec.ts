import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { experimentExportDocumentSchema } from '@hexzero/shared';

async function openMoreActions(page: Parameters<typeof test>[0]['page']) {
  const menu = page.locator('details.overflow-menu');
  if (
    !(await menu.evaluate((element) => (element as HTMLDetailsElement).open))
  ) {
    await page.getByLabel('More World Lab actions').click();
  }
}

test('keeps long swarm activity scrollable inside the bottom dock', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Current swarm architecture' }),
  ).toBeVisible();
  const dock = page.locator('.bottom-dock.activity-dock');
  await dock.evaluate((element) => {
    const panel = element.querySelector<HTMLElement>(
      ':scope > .swarm-activity',
    );
    if (!panel) throw new Error('Swarm activity panel is missing');
    for (let index = 0; index < 30; index += 1) {
      const entry = document.createElement('p');
      entry.textContent = `Committed swarm tick ${index + 1}`;
      panel.append(entry);
    }
  });
  const log = page.getByRole('tabpanel', { name: 'Swarm activity' });
  await expect(log).toHaveCSS('overflow-y', 'auto');
  expect(
    await log.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await log.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const dockBox = await dock.boundingBox();
  expect(dockBox?.height ?? Infinity).toBeLessThanOrEqual(211);
});

test('runs a deterministic swarm tick and exports safe telemetry', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const isolatedApiOrigin = process.env.PLAYWRIGHT_API_ORIGIN;
  if (isolatedApiOrigin) {
    await page.route('**/api/game/**', async (route) => {
      const original = new URL(route.request().url());
      const path = original.pathname.slice('/api/game'.length);
      await route.continue({
        url: `${isolatedApiOrigin}${path}${original.search}`,
      });
    });
  }

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'World Lab' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Current swarm architecture' }),
  ).toContainText('zero-swarm-v1');
  const worldMap = page.getByTestId('world-map');
  await expect(worldMap).toBeVisible();
  await expect(worldMap).toHaveAttribute('data-overlay-status', 'ready');
  await expect(
    page.getByRole('tabpanel', { name: 'Swarm activity' }),
  ).toContainText('Agent Zero strategy');

  await page.getByRole('button', { name: 'Single tick' }).click();
  await expect(
    page.getByRole('button', { name: 'Experiment details. Tick 1, paused' }),
  ).toBeVisible();
  await expect(
    page.getByRole('tabpanel', { name: 'Swarm activity' }),
  ).toContainText('1 committed ticks');

  await openMoreActions(page);
  await page.getByRole('button', { name: 'Export' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Experiment export' });
  await expect(exportDialog).toContainText('Swarm exports include all agents');
  await exportDialog.getByRole('button', { name: 'Preview' }).click();
  await expect(exportDialog).toContainText('Export preview updated');
  await exportDialog.getByRole('button', { name: 'Generate export' }).click();
  await expect(exportDialog).toContainText('Export ready');
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download JSON' }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exported = experimentExportDocumentSchema.parse(
    JSON.parse(await readFile(downloadedPath!, 'utf8')),
  );
  expect(exported.schemaVersion).toBe(11);
  expect(exported.experiment.scenario?.swarmArchitectureVersion).toBe(
    'zero-swarm-v1',
  );
  expect(exported.swarmTicks).toHaveLength(1);
  expect(exported.providerAttempts).toEqual(expect.any(Array));
});
