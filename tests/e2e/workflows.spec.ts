import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('owner and invited worker complete a persisted invoice, claim and receipt journey', async ({ page, browser }) => {
  const unique = Date.now();
  await page.goto('/register');
  await page.getByLabel('Your name', { exact: true }).fill('Alex Builder');
  await page.getByLabel('Company name').fill(`Soleil Studio ${unique}`);
  await page.getByLabel('Email address').fill(`owner-${unique}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('Soleil-proof-password-24!');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Alex');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Alex');

  await page.goto('/app/workers');
  await page.getByRole('button', { name: 'Add contractor', exact: true }).first().click();
  const contractor = page.getByRole('dialog');
  await contractor.getByLabel('Full name').fill('Avery Worker');
  await contractor.getByLabel('Email address').fill(`worker-${unique}@example.test`);
  await contractor.getByLabel('Receiving account').fill('FtmJd6F49F4wSvmKULfnQHMDEz6xXAE31GS44hhEfpzf');
  await contractor.getByRole('button', { name: 'Add contractor', exact: true }).click();
  await expect(contractor).not.toBeVisible();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await page.getByRole('button', { name: 'Generate private link' }).click();
  const invitation = await page.getByLabel('Private invitation link').inputValue();
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  const workerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3101' });
  const worker = await workerContext.newPage();
  await worker.goto(invitation);
  await worker.getByLabel('Create a password').fill('Worker-proof-password-24!');
  await worker.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(worker).toHaveURL(/\/app\/portal$/);
  await worker.getByRole('button', { name: 'Confirm demo recipient' }).click();
  await expect(worker.getByText('Confirmed in demo', { exact: true })).toBeVisible();
  await worker.goto('/app/treasury');
  await expect(worker).toHaveURL(/\/app\/portal$/);

  await page.goto('/app/treasury');
  await page.getByRole('button', { name: 'Add demo funds', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Amount', { exact: true }).fill('3000');
  await page.getByRole('dialog').getByRole('button', { name: 'Add demo funds', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.goto('/app/invoices');
  await page.getByRole('button', { name: 'New invoice' }).click();
  const invoice = page.getByRole('dialog');
  await invoice.getByLabel('Work description').fill('Accepted design milestone');
  await invoice.getByLabel('Amount in demo asset').fill('100');
  await invoice.getByRole('button', { name: 'Create draft invoice' }).click();
  await expect(invoice).not.toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pay now', exact: true })).toBeEnabled();

  await worker.reload();
  await worker.getByRole('button', { name: 'Claim payment' }).click();
  await expect(worker.getByRole('button', { name: 'Claim payment' })).toHaveCount(0);
  await worker.getByRole('button', { name: /View receipt for/ }).click();
  await expect(worker.getByRole('dialog')).toContainText(/simulat/i);
  const downloadPromise = worker.waitForEvent('download');
  await worker.getByRole('button', { name: 'Download JSON' }).click();
  const download = await downloadPromise;
  const receipt = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(receipt.mode).toBe('demo');
  expect(receipt.amount).toBe('100000000');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pay now', exact: true })).toHaveCount(0);
  await workerContext.close();
});

test('demo routes, reserve error, provider handoff and ledger export work', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByText('Accounting simulation', { exact: true }).click(); await page.getByRole('button', { name: 'Employer demo' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Jamie');
  for (const route of ['invoices', 'workers', 'treasury', 'company', 'activity', 'settings', 'testnet']) {
    await page.goto(`/app/${route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await expect(page.getByText('Verified testnet settlement')).toBeVisible();
  await expect(page.getByText('Solana: actual SBF execution')).toBeVisible();
  await page.goto('/app/treasury');
  await page.getByRole('button', { name: 'Withdraw surplus', exact: true }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Amount', { exact: true }).fill('999999999');
  await modal.getByRole('button', { name: 'Withdraw surplus', exact: true }).click();
  await expect(modal.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
  await page.goto('/app/company');
  const readinessBefore = (await (await page.request.get('/api/bootstrap')).json()).company;
  await page.locator('.provider-option').filter({ hasText: 'Stablecorp' }).getByRole('button', { name: 'Explore', exact: true }).click();
  const formation = page.getByRole('dialog');
  await formation.getByRole('checkbox').check();
  await formation.getByRole('button', { name: 'Prepare provider link' }).click();
  await expect(formation.getByRole('link', { name: 'Open provider website' })).toHaveAttribute('href', /stablecorp/);
  await expect(formation).toContainText('Your business readiness status remains separate from this link.');
  await page.keyboard.press('Escape');
  const readinessAfter = (await (await page.request.get('/api/bootstrap')).json()).company;
  expect(readinessAfter.formationStatus).toBe('handoff_requested');
  for (const field of ['taxIdStatus', 'verificationStatus', 'bankingStatus', 'paymentsStatus']) expect(readinessAfter[field]).toBe(readinessBefore[field]);
  await expect(page.locator('.readiness-grid')).toContainText(/Handoff requested/i);
  await page.goto('/app/activity');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export ledger CSV' }).click();
  const download = await downloadPromise;
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv).toContain('created_at'); expect(csv).toContain('LOCAL_SIMULATION');
  await page.screenshot({ path: '.runtime/activity-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('public verifier independently recognizes the recorded live Tempo vault @network', async ({ page }) => {
  test.setTimeout(90_000);
  const proof = JSON.parse(readFileSync('public/testnet-evidence.json', 'utf8'));
  await page.goto(`/verify?vault=${proof.vault}&paymentId=${proof.paymentId}`);
  await page.getByRole('button', { name: 'Verify commitment' }).click();
  await expect(page.getByText('Compiled vault code matched')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Settled', { exact: true })).toBeVisible();
  await expect(page.getByText(proof.recipient, { exact: true })).toBeVisible();
  await page.screenshot({ path: '.runtime/verifier-desktop.png', fullPage: true });
});

test('mobile layout and keyboard dialog controls remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.screenshot({ path: '.runtime/login-mobile.png', fullPage: true });
  await page.getByText('Accounting simulation', { exact: true }).click(); await page.getByRole('button', { name: 'Employer demo' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.screenshot({ path: '.runtime/dashboard-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.goto('/app/invoices');
  await page.getByRole('button', { name: 'New invoice' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({ path: '.runtime/invoice-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('native lab executes a fresh real Tempo proof through the browser RPC relay @network', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByText('Accounting simulation', { exact: true }).click(); await page.getByRole('button', { name: 'Employer demo' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await page.goto('/app/testnet');
  await page.getByRole('button', { name: 'Run a fresh on-chain proof' }).click();
  await expect(page.getByText('Verified: recipient delivery, zero unpaid liability and duplicate rejection.')).toBeVisible({ timeout: 150_000 });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export proof', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs('.runtime/browser-tempo-proof.json');
  const proof = JSON.parse(readFileSync('.runtime/browser-tempo-proof.json', 'utf8'));
  expect(proof.verified).toBe(true); expect(proof.chainId).toBe(42431);
  expect(proof.recipientBalance).toBe('300000000'); expect(proof.committedAfter).toBe('0');
  expect(proof.caller.toLowerCase()).not.toBe(proof.employer.toLowerCase());
  await page.screenshot({ path: '.runtime/native-lab-desktop.png', fullPage: true });
});

test('exhausted simulated strategy can be closed without creating recovered funds', async ({ page }) => {
  await page.goto('/'); await page.getByText('Accounting simulation', { exact: true }).click(); await page.getByRole('button', { name: 'Employer demo' }).click();
  await expect(page).toHaveURL(/\/app$/); await page.goto('/app/treasury');
  const solana = page.locator('.treasury-card').filter({ has: page.locator('.rail-solana') });
  await solana.getByRole('button', { name: 'Allocate surplus', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Amount', { exact: true }).fill('500');
  await page.getByRole('dialog').getByRole('button', { name: 'Allocate demo surplus', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await solana.getByRole('button', { name: 'Simulate loss', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Amount', { exact: true }).fill('500');
  await page.getByRole('dialog').getByRole('button', { name: 'Simulate strategy loss', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const before = (await (await page.request.get('/api/bootstrap')).json()).vaults.find((vault: { rail: string }) => vault.rail === 'solana');
  expect(before.strategyValue).toBe('0'); expect(before.riskMode).toBe('protected');
  await solana.getByRole('button', { name: 'Close exhausted simulation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const after = (await (await page.request.get('/api/bootstrap')).json()).vaults.find((vault: { rail: string }) => vault.rail === 'solana');
  expect(after.strategyPrincipal).toBe('0'); expect(after.riskMode).toBe('normal'); expect(after.balance).toBe(before.balance);
});

test('a separate unauthenticated caller settles a shared funded commitment @network', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await page.goto('/'); await page.getByText('Accounting simulation', { exact: true }).click(); await page.getByRole('button', { name: 'Employer demo' }).click();
  await expect(page).toHaveURL(/\/app$/); await page.goto('/app/testnet');
  await page.getByRole('button', { name: 'Create funded testnet commitment' }).click();
  const funded = page.getByRole('region', { name: 'Funded native commitment' });
  await expect(funded).toBeVisible({ timeout: 120_000 });
  const link = await funded.getByRole('link', { name: 'Verify and claim independently' }).getAttribute('href');
  const workerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3101' });
  const worker = await workerContext.newPage();
  const workspaceRequests: string[] = [];
  worker.on('request', request => { if (/\/api\/(auth|config|bootstrap)/.test(request.url())) workspaceRequests.push(request.url()); });
  await worker.goto(link!);
  await worker.getByRole('button', { name: 'Verify commitment' }).click();
  await expect(worker.getByText('Due', { exact: true })).toBeVisible({ timeout: 60_000 });
  await worker.getByRole('button', { name: 'Settle to fixed recipient' }).click();
  await expect(worker.getByText('Settled', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(worker.getByRole('status')).toContainText('Confirmed on Tempo Moderato:');
  expect(workspaceRequests).toEqual([]);
  await worker.screenshot({ path: '.runtime/independent-claim-desktop.png', fullPage: true });
  await workerContext.close();
});
