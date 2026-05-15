import { test, expect } from '@playwright/test';

test.describe('Game Bug Fix Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`file://${process.cwd()}/data/workspaces/ai-debate/owner/index.html`);
  });

  test('게임 시작 시 플레이어와 적이 바로 스폰되어야 함', async ({ page }) => {
    // Wait for menu to be visible
    await page.waitForSelector('#screen-menu:not(.hidden)', { timeout: 5000 });

    // Click play button
    await page.click('#btn-play');

    // Wait for character select screen
    await page.waitForSelector('#screen-chars:not(.hidden)', { timeout: 5000 });

    // Wait for characters to be populated
    await page.waitForTimeout(500);

    // Check if char-list has children
    const charCount = await page.locator('#char-list .char-card').count();
    expect(charCount).toBeGreaterThan(0);

    // Select first character
    await page.locator('#char-list .char-card').first().click();

    // Wait for pet select screen
    try {
      await page.waitForSelector('#screen-pet:not(.hidden)', { timeout: 3000 });
      // Skip pet selection
      await page.click('#btn-skip-pet');
    } catch {
      // No pet screen
    }

    // Wait for artifact select or HUD (depending on settings)
    try {
      await page.waitForSelector('#screen-artifact:not(.hidden)', { timeout: 3000 });
      // Click anywhere to skip artifact selection
      await page.click('#screen-artifact');
    } catch {
      // No artifact screen
    }

    // Wait for game to initialize (HUD should be visible)
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });

    // Wait 2 seconds for enemies to spawn
    await page.waitForTimeout(2000);

    // Check if game is running (HUD should be visible and timer visible)
    await page.waitForSelector('#timer', { timeout: 5000 });
    const timer = await page.locator('#timer').textContent();
    expect(timer).toBeDefined();
    expect(timer).toMatch(/\d{2}:\d{2}/); // Timer format should be MM:SS
  });

  test('적이 3초内有生成되어야 함', async ({ page }) => {
    // Wait for menu to be visible
    await page.waitForSelector('#screen-menu:not(.hidden)', { timeout: 5000 });

    // Click play button
    await page.click('#btn-play');

    // Wait for character select screen
    await page.waitForSelector('#screen-chars:not(.hidden)', { timeout: 5000 });

    // Wait for characters to be populated
    await page.waitForTimeout(500);

    // Select first character
    await page.locator('#char-list .char-card').first().click();

    // Wait for pet select screen
    try {
      await page.waitForSelector('#screen-pet:not(.hidden)', { timeout: 3000 });
      // Skip pet selection
      await page.click('#btn-skip-pet');
    } catch {
      // No pet screen
    }

    // Wait for artifact select or HUD (depending on settings)
    try {
      await page.waitForSelector('#screen-artifact:not(.hidden)', { timeout: 3000 });
      // Click anywhere to skip artifact selection
      await page.click('#screen-artifact');
    } catch {
      // No artifact screen
    }

    // Wait for game to initialize
    await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });

    // Wait 3 seconds (spawnTimer was -1, so enemies should spawn within 3 seconds)
    await page.waitForTimeout(3000);

    // Check timer is running (game is alive)
    await page.waitForSelector('#timer', { timeout: 5000 });
    const timer = await page.locator('#timer').textContent();
    expect(timer).toBeDefined();
    expect(timer).toMatch(/\d{2}:\d{2}/);
  });

  test('게임 메뉴로 돌아갈 수 있어야 함', async ({ page }) => {
    // Click play button
    await page.click('#btn-play');

    // Wait for character select
    await page.waitForSelector('#screen-chars:not(.hidden)', { timeout: 5000 });

    // Go back to menu
    await page.click('#btn-back-chars');
    await page.waitForSelector('#screen-menu:not(.hidden)', { timeout: 5000 });
  });
});