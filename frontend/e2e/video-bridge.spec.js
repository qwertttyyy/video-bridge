import { expect, test } from "@playwright/test";


function attachDiagnostics(page, label) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`${label} console: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`${label} pageerror: ${err.message}`);
  });
  return errors;
}


async function createCall(browser, options = {}) {
  const errors = [];
  const creatorContext = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const joinerContext = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const creator = await creatorContext.newPage();
  const joiner = await joinerContext.newPage();
  errors.push(...attachDiagnostics(creator, "creator"));
  errors.push(...attachDiagnostics(joiner, "joiner"));

  if (options.mockDisplayMediaWithAudio) {
    await creator.addInitScript(() => {
      window.__audioReplaceTrackCount = 0;
      const originalReplaceTrack = RTCRtpSender.prototype.replaceTrack;
      RTCRtpSender.prototype.replaceTrack = function replaceTrackWithCounter(track) {
        if (track?.kind === "audio") {
          window.__audioReplaceTrackCount += 1;
        }
        return originalReplaceTrack.call(this, track);
      };

      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 360;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#102030";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#ffffff";
          ctx.font = "24px sans-serif";
          ctx.fillText("screen share", 24, 48);

          const videoTrack = canvas.captureStream(10).getVideoTracks()[0];
          const audioContext = new AudioContext();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const destination = audioContext.createMediaStreamDestination();
          gain.gain.value = 0.02;
          oscillator.connect(gain);
          gain.connect(destination);
          oscillator.start();

          return new MediaStream([
            videoTrack,
            destination.stream.getAudioTracks()[0],
          ]);
        },
      });
    });
  }

  await creator.goto("/");
  await creator.getByRole("button", { name: "Создать сессию" }).click();
  await expect(creator.locator(".call")).toBeVisible();

  const session = new URL(creator.url()).searchParams.get("session");
  expect(session).toBeTruthy();

  await joiner.goto(`/?session=${session}`);
  await expect(joiner.locator(".call")).toBeVisible();
  await expect(creator.locator(".quality-indicator")).toBeVisible();
  await expect(joiner.locator(".quality-indicator")).toBeVisible();

  return {
    creatorContext,
    joinerContext,
    creator,
    joiner,
    session,
    errors,
    expectNoErrors: () => expect(errors).toEqual([]),
  };
}


test("соединяет двух участников и восстанавливает звонок после перезагрузки вкладки", async ({ browser }) => {
  const call = await createCall(browser);

  await expect(call.creator.locator("video")).toHaveCount(2);
  await expect(call.joiner.locator("video")).toHaveCount(2);

  await call.joiner.reload();
  await expect(call.joiner.locator(".call")).toBeVisible();
  await expect(call.creator.locator(".quality-indicator")).toBeVisible();
  await expect(call.joiner.locator(".quality-indicator")).toBeVisible();
  call.expectNoErrors();

  await call.creatorContext.close();
  await call.joinerContext.close();
});


test("отклоняет третьего участника понятной ошибкой", async ({ browser }) => {
  const call = await createCall(browser);
  const thirdContext = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const third = await thirdContext.newPage();

  await third.goto(`/?session=${call.session}`);

  await expect(third.getByText("Сессия уже заполнена")).toBeVisible();
  call.expectNoErrors();

  await thirdContext.close();
  await call.creatorContext.close();
  await call.joinerContext.close();
});


test("переключает камеру и микрофон без разрыва звонка", async ({ browser }) => {
  const call = await createCall(browser);

  await call.creator.getByTitle("Выключить камеру").click();
  await expect(call.creator.getByTitle("Включить камеру")).toBeVisible();
  await expect(call.joiner.locator(".remote-placeholder")).toBeVisible();

  await call.creator.getByTitle("Включить камеру").click();
  await expect(call.creator.getByTitle("Выключить камеру")).toBeVisible();
  await expect(call.joiner.locator(".quality-indicator")).toBeVisible();

  await call.creator.getByTitle("Выключить микрофон").click();
  await expect(call.creator.getByTitle("Включить микрофон")).toBeVisible();
  await call.creator.getByTitle("Включить микрофон").click();
  await expect(call.creator.getByTitle("Выключить микрофон")).toBeVisible();
  await expect(call.creator.locator(".quality-indicator")).toBeVisible();
  await expect(call.joiner.locator(".quality-indicator")).toBeVisible();
  call.expectNoErrors();

  await call.creatorContext.close();
  await call.joinerContext.close();
});


test("hangup завершает звонок у второго участника без бесконечного реконнекта", async ({ browser }) => {
  const call = await createCall(browser);

  await call.creator.getByTitle("Завершить").click();

  await expect(call.creator.getByRole("button", { name: "Создать сессию" })).toBeVisible();
  await expect(call.joiner.getByText("Собеседник отключился")).toBeVisible();
  call.expectNoErrors();

  await call.creatorContext.close();
  await call.joinerContext.close();
});


test("после закрытия вкладки участника освободившийся слот занимает новый клиент", async ({ browser }) => {
  const call = await createCall(browser);
  await call.joinerContext.close();
  await call.creator.waitForTimeout(300);

  const replacementContext = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const replacement = await replacementContext.newPage();
  call.errors.push(...attachDiagnostics(replacement, "replacement"));

  await replacement.goto(`/?session=${call.session}`);
  await expect(replacement.locator(".quality-indicator")).toBeVisible();
  await expect(call.creator.locator(".quality-indicator")).toBeVisible();
  call.expectNoErrors();

  await replacementContext.close();
  await call.creatorContext.close();
});


test("показывает понятную ошибку для невалидного ключа", async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const page = await context.newPage();
  const errors = attachDiagnostics(page, "invalid-key");

  await page.goto("/?session=bad!");
  await expect(page.getByText("Недопустимый ключ сессии")).toBeVisible();
  expect(errors).toEqual([]);

  await context.close();
});


test("демонстрация экрана с audio track заменяет аудио sender", async ({ browser }) => {
  const call = await createCall(browser, { mockDisplayMediaWithAudio: true });

  await call.creator.getByTitle("Демонстрация экрана").click();

  await expect(call.creator.getByTitle("Остановить демонстрацию")).toBeVisible();
  await expect.poll(
    () => call.creator.evaluate(() => window.__audioReplaceTrackCount),
  ).toBeGreaterThan(0);
  await expect(call.creator.locator(".quality-indicator")).toBeVisible();
  await expect(call.joiner.locator(".quality-indicator")).toBeVisible();

  await call.creator.getByTitle("Остановить демонстрацию").click();
  await expect(call.creator.getByTitle("Демонстрация экрана")).toBeVisible();
  call.expectNoErrors();

  await call.creatorContext.close();
  await call.joinerContext.close();
});
