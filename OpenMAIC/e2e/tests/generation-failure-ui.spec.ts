import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';
import { mockSceneContentResponse } from '../fixtures/test-data/scene-content';
import { createMockSceneActionsResponse } from '../fixtures/test-data/scene-actions';

const SETTINGS_STORAGE = createSettingsStorage();

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-classroom-failure-test',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

test.describe('In-Classroom Scene Generation Failure UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('displays specific error message in canvas when 2nd scene fails with 429 rate limit', async ({
    page,
    mockApi,
  }) => {
    // Outline streaming succeeds
    await mockApi.mockSceneOutlinesStream();

    let sceneContentCallCount = 0;
    // First scene content succeeds; second fails with 429; subsequent also fail.
    await page.route('**/api/generate/scene-content', async (route) => {
      sceneContentCallCount++;
      const body = route.request().postDataJSON() as { outline?: { id?: string } };
      const outlineId = body?.outline?.id ?? '';

      if (sceneContentCallCount === 1) {
        // First scene: success
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...mockSceneContentResponse,
            effectiveOutline: mockOutlines[0],
          }),
        });
        return;
      }
      // Subsequent scenes: fail with 429
      await route.fulfill({
        status: 429,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          errorCode: 'RATE_LIMITED',
          error: 'Upstream rate limit reached. Please try again shortly.',
        }),
      });
    });

    // First scene actions succeeds
    await page.route('**/api/generate/scene-actions', async (route) => {
      let id = 'test-stage';
      try {
        const body = route.request().postDataJSON();
        if (body?.stageId) id = body.stageId;
      } catch {
        // fallback
      }
      const sceneActions = createMockSceneActionsResponse(id);
      // scene-actions is now an SSE endpoint; emit a single `result` event.
      const sseBody =
        `data: ${JSON.stringify({
          type: 'result',
          scene: sceneActions.scene,
          previousSpeeches: sceneActions.previousSpeeches,
        })}\n\n`;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: sseBody,
      });
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await page.waitForURL(/\/classroom\//, { timeout: 30_000 });

    const nextBtn = page.getByRole('button', {
      name: /next scene|下一场景|下一頁|次のシーン|следующая сцена/i,
    });
    let errorDetail = page.getByText(/upstream rate limit reached/i);
    let visible = false;
    for (let i = 0; i < 12; i++) {
      try {
        await nextBtn.click({ timeout: 1_500, force: true });
      } catch {}
      try {
        await expect(errorDetail).toBeVisible({ timeout: 2_000 });
        visible = true;
        break;
      } catch {}
      await page.waitForTimeout(2_000);
    }
    expect(visible, 'Failed-scene error UI did not appear after navigating to next scene').toBe(true);

    const failureLabel = page.locator('text=/Generation failed|生成失败/');
    await expect(failureLabel.first()).toHaveCount(1, { timeout: 5_000 });

    const retryBtn = page.getByRole('button', { name: /^retry$|^重试$|^重試$/i });
    await expect(retryBtn).toHaveCount(1, { timeout: 5_000 });

    await page.screenshot({
      path: 'test-results/in-classroom-failure-429.png',
      fullPage: false,
    });
  });

  test('displays authentication error message in canvas when 2nd scene fails with 401', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockSceneOutlinesStream();

    let callCount = 0;
    await page.route('**/api/generate/scene-content', async (route) => {
      callCount++;
      if (callCount === 1) {
        // First scene: success (SSE)
        const sseBody =
          `data: ${JSON.stringify({
            type: 'result',
            content: mockSceneContentResponse.content,
            effectiveOutline: mockOutlines[0],
          })}\n\n`;
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
          body: sseBody,
        });
        return;
      }
      await route.fulfill({
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          errorCode: 'UPSTREAM_ERROR',
          error: 'Upstream authentication or authorization failed.',
        }),
      });
    });

    await page.route('**/api/generate/scene-actions', async (route) => {
      let id = 'test-stage';
      try {
        const body = route.request().postDataJSON();
        if (body?.stageId) id = body.stageId;
      } catch {}
      const sceneActions = createMockSceneActionsResponse(id);
      // scene-actions is now an SSE endpoint; emit a single `result` event.
      const sseBody =
        `data: ${JSON.stringify({
          type: 'result',
          scene: sceneActions.scene,
          previousSpeeches: sceneActions.previousSpeeches,
        })}\n\n`;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: sseBody,
      });
    });

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    await page.waitForURL(/\/classroom\//, { timeout: 30_000 });

    const nextBtn = page.getByRole('button', {
      name: /next scene|下一场景|下一頁|次のシーン|следующая сцена/i,
    });
    let errorDetail = page.getByText(/upstream authentication or authorization failed/i);
    let visible = false;
    for (let i = 0; i < 12; i++) {
      try {
        await nextBtn.click({ timeout: 1_500, force: true });
      } catch {}
      try {
        await expect(errorDetail).toBeVisible({ timeout: 2_000 });
        visible = true;
        break;
      } catch {}
      await page.waitForTimeout(2_000);
    }
    expect(visible, 'Failed-scene error UI did not appear after navigating to next scene').toBe(true);

    // "Generation failed" label and Retry button exist in the DOM next to the
    // error detail; use attached-state checks since the parent flex container
    // measures as zero-area for Playwright at the moment the overlay first
    // mounts (false-negative on `toBeVisible`).
    const failureLabel = page.locator('text=/Generation failed|生成失败/');
    await expect(failureLabel.first()).toHaveCount(1, { timeout: 5_000 });

    const retryBtn = page.getByRole('button', { name: /^retry$|^重试$|^重試$/i });
    await expect(retryBtn).toHaveCount(1, { timeout: 5_000 });

    await page.screenshot({
      path: 'test-results/in-classroom-failure-401.png',
      fullPage: false,
    });
  });
});
