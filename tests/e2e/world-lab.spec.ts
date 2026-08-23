import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { experimentExportDocumentSchema } from '@hexzero/shared';

const EMBER_ID = '128f3f38-6b7d-4db7-9e95-751b4ce2681e';
const CIPHER_ID = '89ce9ddb-611f-4a46-8f7b-36e656494aa2';
const MINGLE_PERSONALITY =
  'You are a social coalition-builder. Seek agents, initiate and continue conversations, propose alliances, answer offers, negotiate borders, and coordinate captures against dominant rivals. Prefer cooperation and public diplomacy over silent expansion, but protect your own territory and leave an alliance that repeatedly ignores or exploits you. Make concrete proposals rather than merely announcing actions.';

test('runs the complete deterministic World Lab browser flow', async ({
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
  const openRouterRequests: string[] = [];
  const browserFailures: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('openrouter.ai'))
      openRouterRequests.push(request.url());
  });
  page.on('requestfailed', (request) => {
    browserFailures.push(
      `request failed: ${request.method()} ${request.url()} · ${request.failure()?.errorText ?? 'unknown'}`,
    );
  });
  page.on('pageerror', (error) => {
    browserFailures.push(`page error: ${error.message}`);
  });

  await page.goto('/');
  const openActions = async () => {
    const menu = page.locator('details.overflow-menu');
    if (
      !(await menu.evaluate((element) => (element as HTMLDetailsElement).open))
    )
      await page.getByLabel('More World Lab actions').click();
  };

  try {
    await expect(page.getByText('Deterministic test model')).toBeVisible({
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nBrowser failures:\n${browserFailures.join('\n') || 'none captured'}`,
    );
  }

  await expect(page.getByRole('heading', { name: 'World Lab' })).toBeVisible();
  await openActions();
  await page.getByRole('button', { name: 'World setup' }).click();
  const setupDialog = page.getByRole('dialog', { name: 'World Setup' });
  await setupDialog.getByLabel('Communication range (km)').fill('7.5');
  await setupDialog.getByRole('button', { name: 'Preview' }).click();
  await setupDialog
    .getByRole('button', { name: 'Apply / Create Experiment' })
    .click();
  await expect(setupDialog).toBeHidden();
  const worldMap = page.getByTestId('world-map');
  await expect(worldMap).toBeVisible();
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole('tabpanel', { name: 'Public world chat' }),
    ).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewportHeight: window.innerHeight,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      shellTop: document
        .querySelector('.world-lab-shell')!
        .getBoundingClientRect().top,
      shellBottom: document
        .querySelector('.world-lab-shell')!
        .getBoundingClientRect().bottom,
      shellHeight: document
        .querySelector('.world-lab-shell')!
        .getBoundingClientRect().height,
      dockBottom: document
        .querySelector('.bottom-dock')!
        .getBoundingClientRect().bottom,
      dockHeight: document
        .querySelector('.bottom-dock')!
        .getBoundingClientRect().height,
      mapHeight: document
        .querySelector('[data-testid="world-map"]')!
        .getBoundingClientRect().height,
    }));
    expect(layout.htmlOverflow).toBe('hidden');
    expect(layout.bodyOverflow).toBe('hidden');
    expect(layout.shellTop).toBe(0);
    expect(layout.shellHeight).toBe(layout.viewportHeight);
    expect(layout.shellBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.dockBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.dockHeight).toBeGreaterThanOrEqual(160);
    expect(layout.dockHeight).toBeLessThanOrEqual(211);
    expect(layout.mapHeight).toBeGreaterThan(layout.dockHeight);
    await page.mouse.wheel(0, 1_000);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopMapBox = await worldMap.boundingBox();
  const desktopDockBox = await page.locator('.bottom-dock').boundingBox();
  expect(desktopMapBox?.width ?? 0).toBeGreaterThan(450);
  expect(desktopMapBox?.height ?? 0).toBeGreaterThan(300);
  expect(desktopDockBox?.height ?? Infinity).toBeLessThanOrEqual(211);
  await expect(worldMap).toHaveAttribute('data-overlay-status', 'ready');
  await expect(worldMap).toHaveAttribute('data-rendered-h3-cell-count', '127');
  await expect(worldMap).toHaveAttribute(
    'data-rendered-infected-cell-count',
    '0',
  );
  await expect(
    page.getByText(/H3 overlay ready · 127\/127 rendered cells · 8 agents/),
  ).toBeVisible();
  await expect(page.getByTestId('infected-count')).toHaveText(
    '0 rendered infected',
  );
  await expect(worldMap).toHaveAttribute('data-controller-colors', '');
  await expect(page.getByLabel('Selected hex details')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Scoreboard' }).click();
  await expect(page.getByLabel('Territory scoreboard')).toContainText('Rook0');
  await expect(page.getByLabel('Territory scoreboard')).toContainText(
    'Mingle0',
  );

  await expect(
    page.getByRole('checkbox', { name: 'Follow latest' }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Collapse activity' }).click();
  await expect(page.locator('.bottom-dock')).toHaveCSS('height', '54px');
  await page.getByRole('button', { name: 'Expand activity' }).click();
  await page.getByRole('tab', { name: 'Event log' }).click();
  await expect(
    page.getByRole('list', { name: 'World event log' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Public chat' }).click();

  const markers = page.getByRole('button', { name: /Select agent/ });
  await expect(markers).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) {
    await expect(markers.nth(index)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Select agent Ember' }).click();
  await expect(page.getByRole('heading', { name: /Ember/ })).toBeVisible();
  const defaultPersonality =
    'You are a forceful expansionist who wants the largest personal territory. Infect open cells aggressively, capture exposed rival territory, and use public messages to pressure or warn competitors. Alliances are temporary strategic tools: propose or accept them when they help contain a stronger rival, honor them while useful, and leave openly when they block expansion. Respond to direct proposals instead of silently ignoring them.';
  const customPersonality =
    'Infect every open current cell, then move decisively to an adjacent open cell.';
  await expect(
    page.getByText(defaultPersonality, { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  const personalityEditor = page.getByRole('textbox', {
    name: 'Personality directive',
  });
  await personalityEditor.fill(customPersonality);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(
    page.getByText(customPersonality, { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Single tick' }).click();
  await expect(page.getByRole('heading', { name: /Ember/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Event log' }).click();
  const tickActivity = page.getByText(/Infection .* direct message accepted/);
  await expect(tickActivity).toHaveCount(8);
  await expect(tickActivity.first()).toBeVisible();
  await expect(page.getByLabel('Direct-message history')).toContainText(
    'Sent Rook',
  );
  const latestObservation = page.getByText('Latest structured observation');
  await latestObservation.click();
  await expect(
    page
      .locator('details')
      .filter({ hasText: 'Latest structured observation' }),
  ).toContainText(customPersonality);
  await expect(worldMap).toHaveAttribute('data-rendered-h3-cell-count', '127');
  await expect(worldMap).toHaveAttribute(
    'data-rendered-infected-cell-count',
    '8',
  );
  await expect(page.getByTestId('infected-count')).toHaveText(
    '8 rendered infected',
  );

  await page.getByRole('button', { name: 'Select agent Rook' }).click();
  await expect(page.getByLabel('Direct-message history')).toContainText(
    'Received Ember',
  );
  await page.getByRole('button', { name: 'Single tick' }).click();
  const recipientObservation = page.getByText('Latest structured observation');
  await recipientObservation.click();
  await expect(
    page
      .locator('details')
      .filter({ hasText: 'Latest structured observation' }),
  ).toContainText('inbound: Ember → Rook');
  await expect(worldMap).toHaveAttribute('data-controller-colors', /#b2d3a8/);
  await page.getByRole('tab', { name: 'Scoreboard' }).click();
  await expect(page.getByLabel('Territory scoreboard')).toContainText('Ember1');
  await page.getByRole('tab', { name: 'Agent' }).click();
  await page.getByRole('button', { name: 'Single tick' }).click();
  await page.getByRole('tab', { name: 'Scoreboard' }).click();
  await expect(page.getByLabel('Alliance and territory panel')).toContainText(
    'Mingle',
  );
  await expect(page.getByLabel('Alliance and territory panel')).toContainText(
    'Solace',
  );
  await expect(
    page.getByText('Mingle and Solace formed an alliance.').first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Select agent Mingle' }),
  ).toHaveAttribute('data-effective-color', '#0072B2');
  await expect(
    page.getByRole('button', { name: 'Select agent Solace' }),
  ).toHaveAttribute('data-effective-color', '#0072B2');
  await page.getByRole('button', { name: 'Single tick' }).click();
  await page.getByRole('tab', { name: /Private comms/ }).click();
  const privateComms = page.getByRole('tabpanel', {
    name: 'Private communications',
  });
  await expect(privateComms).toContainText('Meet near the center');
  await privateComms.getByRole('button', { name: 'Alliance' }).click();
  await expect(privateComms).toContainText('Coordinate privately');
  await privateComms.getByRole('button', { name: 'Direct' }).click();
  await expect(privateComms).toContainText('Meet near the center');
  const rookParticipants = privateComms.getByRole('button', { name: 'Rook' });
  await expect(rookParticipants).toHaveCount(3);
  await rookParticipants.first().click();
  await expect(page.getByRole('heading', { name: /Rook/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Event log' }).click();
  await expect(
    page.getByRole('list', { name: 'World event log' }),
  ).not.toContainText('Coordinate privately');
  await page.getByRole('tab', { name: 'Agent' }).click();
  await expect(page.getByLabel('Agent inspector')).toContainText(
    'World action: wait · accepted',
  );

  let captured = false;
  for (let index = 0; index < 60 && !captured; index += 1) {
    await page.getByRole('button', { name: 'Single tick' }).click();
    captured = await page
      .getByText(/captured .* from/)
      .first()
      .isVisible();
  }
  expect(captured).toBe(true);
  await expect(worldMap).toHaveAttribute('data-controller-colors', /#b2d3a8/);
  await page.getByRole('tab', { name: 'Scoreboard' }).click();
  await expect(page.getByLabel('Territory scoreboard')).toContainText('Ember2');
  await expect(page.getByLabel('Territory scoreboard')).toContainText('Rook1');
  await expect(page.getByLabel('Territory scoreboard')).toContainText(
    'Cipher0',
  );
  const agentRoster = page.getByLabel('Agent roster');
  await agentRoster.getByRole('button', { name: /^Ember / }).click();
  await expect(page.getByLabel('Recent territory changes')).toContainText(
    'Gained',
  );
  await agentRoster.getByRole('button', { name: /^Cipher / }).click();
  await expect(page.getByLabel('Recent territory changes')).toContainText(
    'Lost',
  );
  await openActions();
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('checkbox', { name: 'Cipher', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Cipher', exact: true }),
  ).toBeChecked();
  const exportDialog = page.getByRole('dialog', { name: 'Experiment export' });
  const exportGeometry = await exportDialog.evaluate((dialog) => ({
    right: dialog.getBoundingClientRect().right,
    bottom: dialog.getBoundingClientRect().bottom,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyOverflow: getComputedStyle(document.body).overflow,
    dialogScrollWidth: dialog.scrollWidth,
    dialogClientWidth: dialog.clientWidth,
  }));
  expect(exportGeometry.right).toBeLessThanOrEqual(
    exportGeometry.viewportWidth,
  );
  expect(exportGeometry.bottom).toBeLessThanOrEqual(
    exportGeometry.viewportHeight,
  );
  expect(exportGeometry.dialogScrollWidth).toBe(
    exportGeometry.dialogClientWidth,
  );
  expect(exportGeometry.bodyScrollWidth).toBe(exportGeometry.bodyClientWidth);
  expect(exportGeometry.bodyOverflow).toBe('hidden');
  for (const action of ['move', 'infect', 'wait']) {
    await page.getByRole('checkbox', { name: action, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByLabel('Export preview')).toContainText('0 turns');
  await expect(page.getByLabel('Export preview')).toContainText('1 matched');
  await page.getByRole('button', { name: 'Generate export' }).click();
  await expect(page.getByText(/Export ready/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON' }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exported = experimentExportDocumentSchema.parse(
    JSON.parse(await readFile(downloadedPath!, 'utf8')),
  );
  expect(exported.schemaVersion).toBe(10);
  expect(exported.filters.level).toBe('minimal');
  expect(exported.selection.selectedAgentIds).toEqual([CIPHER_ID]);
  expect(exported.turns).toEqual([]);
  expect(exported.controlChanges).toMatchObject([
    {
      controllerAgentId: EMBER_ID,
      previousControllerAgentId: CIPHER_ID,
    },
  ]);
  expect(exported.selection.matchingControlChangeCount).toBe(1);
  expect(exported.metrics?.byAgent[0]?.metrics).toMatchObject({
    totalTurns: 0,
    territoryLostThroughCapture: 1,
  });
  expect(exported.metrics?.aggregate.knownCostCredits).toBe(0);
  expect(exported.metrics?.aggregate.turnsWithUnknownCost).toBe(0);
  expect(exported.turns.map(({ turnNumber }) => turnNumber)).toEqual(
    exported.turns
      .map(({ turnNumber }) => turnNumber)
      .toSorted((a, b) => a - b),
  );

  await page.getByRole('button', { name: 'Close export' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Experiment export' }),
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Select agent Cipher' }),
  ).toHaveClass(/selected/);

  page.once('dialog', (dialog) => dialog.accept());
  await openActions();
  await page.getByRole('button', { name: 'Reset world' }).click();
  await expect(
    page.getByRole('button', {
      name: 'Experiment details. Tick 0, paused',
    }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: /Cipher/ })).toBeVisible();
  await page.getByRole('button', { name: 'Select agent Ember' }).click();
  await expect(
    page.getByText(customPersonality, { exact: true }),
  ).toBeVisible();
  await expect(worldMap).toHaveAttribute('data-rendered-h3-cell-count', '127');
  await expect(worldMap).toHaveAttribute(
    'data-rendered-infected-cell-count',
    '0',
  );
  await expect(page.getByTestId('infected-count')).toHaveText(
    '0 rendered infected',
  );
  await expect(worldMap).toHaveAttribute('data-controller-colors', '');
  await expect(page.getByLabel('Selected hex details')).toHaveCount(0);
  await expect(markers).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) {
    await expect(markers.nth(index)).toBeVisible();
  }
  await expect(
    page.getByText('Development world loaded with 8 agents.'),
  ).toBeVisible();
  await expect(
    page.getByText('No direct messages for this agent yet.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Single tick' }).click();
  await expect(
    page.getByRole('button', {
      name: 'Experiment details. Tick 1, paused',
    }),
  ).toBeVisible();
  const resetTickActivity = page.getByText(
    /Infection .* direct message accepted/,
  );
  await expect(resetTickActivity).toHaveCount(8);
  await expect(resetTickActivity.first()).toBeVisible();
  await page.getByRole('button', { name: 'Single tick' }).click();
  await expect(
    page.getByRole('button', {
      name: 'Experiment details. Tick 2, paused',
    }),
  ).toBeVisible();
  await expect(worldMap).toHaveAttribute(
    'data-rendered-infected-cell-count',
    '8',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await openActions();
  await page
    .getByRole('button', { name: 'Restore default personalities' })
    .click();
  await expect(
    page.getByText(defaultPersonality, { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Select agent Mingle' }).click();
  await expect(
    page.getByText(MINGLE_PERSONALITY, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Experiment details. Tick 2, paused',
    }),
  ).toBeVisible();
  await expect(worldMap).toHaveAttribute('data-rendered-h3-cell-count', '127');
  await expect(worldMap).toHaveAttribute(
    'data-rendered-infected-cell-count',
    '8',
  );
  await expect(markers).toHaveCount(8);
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(worldMap).toBeVisible();
  const narrowMapBox = await worldMap.boundingBox();
  expect(narrowMapBox?.width ?? 0).toBeGreaterThan(700);
  expect(narrowMapBox?.height ?? 0).toBeGreaterThan(350);
  await expect(page.getByLabel('Agent roster')).toBeHidden();
  await page.getByRole('tab', { name: 'Public chat' }).click();
  await expect(
    page.getByRole('tabpanel', { name: 'Public world chat' }),
  ).toBeVisible();
  expect(openRouterRequests).toEqual([]);
});
