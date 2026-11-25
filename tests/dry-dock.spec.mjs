import { expect, test } from '@playwright/test';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../dist', import.meta.url));
const contentTypes = new Map([
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.woff2', 'font/woff2'],
]);

async function openBuild(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://protivoves.test/**', async route => {
    const { pathname } = new URL(route.request().url());
    const path = resolve(build, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!path.startsWith(build + sep)) {
      await route.abort();
      return;
    }
    await route.fulfill({ path, contentType: contentTypes.get(extname(path)) });
  });
  await page.goto('http://protivoves.test/');
  await expect(page.getByRole('heading', { name: 'Противовес' })).toBeVisible();
  return errors;
}

async function capture(page, name) {
  if (!process.env.PROTIVOVES_SCREENSHOTS) return;
  await page.screenshot({ path: resolve(process.env.PROTIVOVES_SCREENSHOTS, name) });
}

test('портретная дуэль принимает касание, ставится на паузу и начинается заново', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = await openBuild(page);
  await capture(page, 'menu-360x640.png');
  await page.getByRole('button', { name: /Начать дуэль/ }).tap();
  await page.getByRole('button', { name: 'Пропустить' }).tap();
  await expect(page.getByText('Дойди до боевой зоны')).toBeVisible();

  const touch = await context.newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 490, id: 1 }] });
  await expect(page.locator('#stick')).toBeVisible();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160, y: 428, id: 1 }] });
  await expect(page.getByText('Победи сторожа')).toBeVisible();
  await capture(page, 'm01-360x640.png');

  const pause = await page.getByRole('button', { name: 'Пауза' }).boundingBox();
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 160, y: 428, id: 1 }, { x: pause.x + 24, y: pause.y + 24, id: 2 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: 160, y: 428, id: 1 }] });
  await expect(page.getByRole('dialog', { name: 'Пауза' })).toBeVisible();
  await expect(page.locator('#stick')).toBeHidden();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole('dialog', { name: 'Пауза' })).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить' }).tap();
  await expect(page.getByText('Победи сторожа')).toBeVisible();
  await expect(page.locator('#stick')).toBeHidden();
  await page.getByRole('button', { name: 'Пауза' }).tap();
  await page.getByRole('button', { name: 'Повторить', exact: true }).tap();
  await expect(page.getByText('Дойди до боевой зоны')).toBeVisible();
  await expect(page.locator('#player-hp')).toHaveText('100');
  expect(errors).toEqual([]);
  await context.close();
});

test('карта, выбор оружия и восстановление прогресса работают после перезагрузки', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openBuild(page);
  await page.getByRole('button', { name: 'Кампания' }).click();
  await expect(page.getByRole('button', { name: /^Грузовой проход/ })).toBeDisabled();
  await capture(page, 'campaign-390x844.png');
  await page.getByRole('button', { name: /^Сухой док/ }).click();
  await expect(page.getByLabel('Оружие').locator('option[value="W2"]')).toBeDisabled();

  const fixture = {
    version: 1,
    completed: Object.fromEntries(['M01', 'M02', 'M03', 'M04'].map(id => [
      id, { stars: [true, true, true], difficulty: 'normal' },
    ])),
    weapon: 'W1', difficulty: 'normal', sound: false, reducedMotion: true,
  };
  await page.evaluate(profile => new Promise((resolve, reject) => {
    const db = indexedDB.open('protivoves', 1);
    db.onerror = () => reject(db.error);
    db.onsuccess = () => {
      const tx = db.result.transaction('campaign', 'readwrite');
      const store = tx.objectStore('campaign');
      store.put(profile, 'previous');
      store.put({ version: 99 }, 'current');
      tx.oncomplete = () => { db.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), fixture);
  await page.reload();
  await expect(page.getByText('Восстановлен последний сохранённый прогресс.')).toBeVisible();
  await page.getByRole('button', { name: 'Кампания' }).click();
  const boss = page.getByRole('button', { name: /^Доковый мастер/ });
  await expect(boss).toBeEnabled();
  await boss.click();
  await page.getByLabel('Оружие').selectOption('W2');
  await expect(page.getByText('Клинок 0,75 м · короткое окно восстановления')).toBeVisible();
  await page.getByLabel('Сложность').selectOption('master');
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const db = indexedDB.open('protivoves', 1);
    db.onsuccess = () => {
      const read = db.result.transaction('campaign').objectStore('campaign').get('current');
      read.onsuccess = () => { db.result.close(); resolve(read.result); };
    };
  }))).toMatchObject({ weapon: 'W2', difficulty: 'master' });
  await page.reload();
  await page.getByRole('button', { name: 'Кампания' }).click();
  await boss.click();
  await expect(page.getByLabel('Оружие')).toHaveValue('W2');
  await expect(page.getByLabel('Сложность')).toHaveValue('master');
  await page.getByRole('button', { name: 'Начать миссию' }).click();
  await expect(page.getByText('Дойди до боевой зоны')).toBeVisible();
  await page.keyboard.down('w');
  await expect(page.getByText('Победи Докового мастера')).toBeVisible();
  await page.keyboard.up('w');
  await expect(page.locator('#enemy-bar')).toHaveAttribute('max', '154');
  await capture(page, 'm04-390x844.png');
  await page.getByRole('button', { name: 'Пауза' }).click();
  await page.getByRole('button', { name: 'К карте' }).click();
  await expect(page.getByRole('dialog', { name: 'Вернуться к карте?' })).toBeVisible();
  await page.getByRole('button', { name: 'К карте' }).click();
  await expect(boss).toBeEnabled();
  expect(errors).toEqual([]);
});

test('тренировка воспроизводит оба исхода одного контакта в готовой сборке', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openBuild(page);
  await page.getByRole('button', { name: 'Тренировка опоры' }).click();
  await expect(page.getByText('Сторож сделал шаг восстановления')).toBeVisible();
  const planted = await page.locator('#drill-measurement').textContent();
  expect(planted).toMatch(/10,0 м\/с .*20 урона/);
  await page.getByRole('button', { name: 'Перенос веса' }).click();
  await expect(page.locator('#drill-result')).toHaveText('Сторож потерял опору');
  const transfer = await page.locator('#drill-measurement').textContent();
  expect(transfer?.split(' · ')[0]).toBe(planted?.split(' · ')[0]);
  expect(transfer).toMatch(/20 урона/);
  await capture(page, 'support-transfer-390x844.png');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Пауза' })).toBeVisible();
  await page.getByRole('button', { name: 'Управление' }).click();
  await expect(page.getByRole('dialog', { name: 'Управление' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Пауза' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Управление' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('клавиатура делает доворот, а Escape останавливает дуэль', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 670 });
  const errors = await openBuild(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /Начать дуэль/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Пропустить' }).click();
  await page.keyboard.down('w');
  await expect(page.getByText('Доверни для удара')).toBeVisible();
  // The gesture needs at least nine simulated ticks of movement before a turn.
  await page.waitForTimeout(360);
  await page.keyboard.down('d');
  await page.keyboard.up('w');
  await expect(page.getByText('Отпусти для стойки')).toBeVisible({ timeout: 2000 });
  await page.keyboard.up('d');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Пауза' })).toBeVisible();
  expect(errors).toEqual([]);
});
