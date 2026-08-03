import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';
import { mockSceneContentResponse } from '../fixtures/test-data/scene-content';
import { createMockSceneActionsResponse } from '../fixtures/test-data/scene-actions';

const SETTINGS_STORAGE = createSettingsStorage();

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-timeout-test',
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

test.describe('Timeout-specific error UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('generation-preview shows i18n-translated timeout message when 2nd scene gets 504 TIMEOUT', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockSceneOutlinesStream();

    let callCount = 0;
    await page.route('**/api/generate/scene-content', async (route) => {
      callCount++;
      if (callCount === 1) {
        // scene-content is now an SSE endpoint; emit a single `result` event.
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
      // Server maps AbortError → 504 TIMEOUT (still plain JSON for sync errors)
      await route.fulfill({
        status: 504,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          errorCode: 'TIMEOUT',
          error: 'Scene generation timed out. Please try again.',
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

    // /generation-preview redirects to /classroom/<id> once scene 1 finishes.
    await page.waitForURL(/\/classroom\//, { timeout: 30_000 });

    // The /classroom/ page is on scene 1 by default. The 2nd scene (which is
    // the one that failed with 504 TIMEOUT) only renders the failure UI when
    // we navigate to it. Click "Next scene" until the failure UI appears.
    const nextBtn = page.getByRole('button', {
      name: /next scene|下一场景|下一頁|次のシーン|следующая сцена/i,
    });
    const errorDetail = page.getByText(
      /Scene generation timed out\.|场景生成超时，|場景生成逾時|シーン生成がタイムアウト|장면 생성 시간이 초과|A geração da cena excedeu|Превышено время ожидания|انتهت مهلة توليد المشهد/,
    );

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
    expect(
      visible,
      'Failed-scene timeout UI did not appear after navigating to next scene',
    ).toBe(true);

    // "Generation failed" label and Retry button must be present.
    const failureLabel = page.locator('text=/Generation failed|生成失败/');
    await expect(failureLabel.first()).toHaveCount(1, { timeout: 5_000 });

    const retryBtn = page.getByRole('button', { name: /^retry$|^重试$|^重試$/i });
    await expect(retryBtn).toHaveCount(1, { timeout: 5_000 });

    await page.screenshot({
      path: 'test-results/in-classroom-failure-timeout-i18n.png',
      fullPage: false,
    });
  });
});
