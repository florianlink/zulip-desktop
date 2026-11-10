import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import type {ElectronApplication} from "playwright-core";
import test from "tape";

import * as setup from "./setup.ts";

async function setCustomCss(
  app: ElectronApplication,
  css: string | null,
): Promise<void> {
  const userData = await app.evaluate(({app}) => app.getPath("userData"));
  const cssPath = path.join(userData, "downloads.css");
  if (css !== null) {
    await fs.writeFile(cssPath, css);
  }

  const settingsPath = path.join(userData, "config", "settings.json");
  const settings: unknown = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  if (typeof settings !== "object" || settings === null) {
    throw new Error("Invalid test settings");
  }

  await fs.writeFile(
    settingsPath,
    JSON.stringify({...settings, customCSS: css === null ? "" : cssPath}),
  );
}

async function download(
  app: ElectronApplication,
  url: string,
  fileName: string,
  cancel = false,
): Promise<string> {
  const filePath = path.join(
    await app.evaluate(({app}) => app.getPath("userData")),
    fileName,
  );
  return app.evaluate(
    async ({session}, {url, filePath, cancel}) => {
      const downloads = session.fromPartition("persist:webviewsession");
      return new Promise<string>((resolve, reject) => {
        downloads.once("will-download", (_event, item) => {
          item.setSavePath(filePath);
          item.once("done", (_doneEvent, state) => {
            if (state === (cancel ? "cancelled" : "completed")) {
              resolve(filePath);
            } else {
              reject(new Error(`Unexpected download state: ${state}`));
            }
          });
          if (cancel) {
            item.cancel();
          }
        });
        downloads.downloadURL(url);
      });
    },
    {url, filePath, cancel},
  );
}

async function waitForRevealCount(
  app: ElectronApplication,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const revealedPaths: unknown = await app.evaluate(({shell}) =>
      Reflect.get(shell.showItemInFolder, "revealedPaths"),
    );
    if (Array.isArray(revealedPaths) && revealedPaths.length === count) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }

  throw new Error(`Timed out waiting for ${count} folder reveals`);
}

test("recent downloads popup", async (t) => {
  t.timeoutAfter(60e3);
  const fileName = `${"long-filename-".repeat(12)}.txt`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    });
    response.end("Downloaded file contents");
  });
  let app = await setup.createApp();
  const showFromMenu = async () => {
    await app.evaluate(({Menu}) => {
      const item = Menu.getApplicationMenu()!
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === "Recent Downloads")!;
      item.click();
    });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test download server did not start");
    }

    const url = `http://127.0.0.1:${address.port}/file`;
    let window = await app.firstWindow();
    await window.waitForSelector("#connect");
    t.equal(await window.isVisible("#downloads-panel"), false);
    await showFromMenu();
    await window.waitForSelector("#downloads-panel");
    t.equal(
      await window.textContent("#downloads-list"),
      "No recent downloads.",
    );
    await window.click("#close-downloads");

    await download(app, url, "cancelled.txt", true);
    t.equal(
      await window.isVisible("#downloads-panel"),
      false,
      "cancelled download does not show the popup",
    );

    const filePath = await download(app, url, fileName);
    await window.waitForSelector(".download-file");
    t.equal(await fs.readFile(filePath, "utf8"), "Downloaded file contents");
    t.equal(await window.textContent(".download-file"), fileName);
    t.equal(
      await window
        .locator(".download-file")
        .evaluate((element) => getComputedStyle(element).fontSize),
      "12px",
      "download filenames use compact text",
    );
    t.equal(
      await window
        .locator(".downloads-heading")
        .evaluate((element) => getComputedStyle(element).fontSize),
      "14px",
      "download heading uses compact text",
    );
    t.ok(
      await window.$eval(".download-file", (element) => {
        const style = getComputedStyle(element);
        return (
          style.textOverflow === "ellipsis" &&
          style.whiteSpace === "nowrap" &&
          element.scrollWidth > element.clientWidth
        );
      }),
      "long filenames are truncated with ellipsis",
    );
    t.equal(await window.getAttribute(".download-file", "title"), filePath);

    await app.evaluate(({shell}) => {
      const revealedPaths: string[] = [];
      shell.showItemInFolder = Object.assign(
        (filePath: string) => {
          revealedPaths.push(filePath);
        },
        {revealedPaths},
      );
    });
    const revealButton = window.locator(".reveal-download");
    await window.locator("#downloads-heading").hover();
    t.equal(
      await revealButton.evaluate(
        (element) => getComputedStyle(element).opacity,
      ),
      "0",
      "folder icon is hidden when the row is not hovered",
    );
    await window.locator(".download-row").hover();
    t.equal(
      await revealButton.evaluate(
        (element) => getComputedStyle(element).opacity,
      ),
      "1",
      "folder icon appears on hover",
    );
    t.equal(
      await revealButton.getAttribute("aria-label"),
      `Show ${fileName} in folder`,
    );
    await revealButton.click();
    await waitForRevealCount(app, 1);
    t.deepEqual(
      await app.evaluate(({shell}) =>
        Reflect.get(shell.showItemInFolder, "revealedPaths"),
      ),
      [filePath],
      "folder icon reveals the selected file",
    );
    await window.locator("#downloads-heading").hover();
    await revealButton.focus();
    t.equal(
      await revealButton.evaluate(
        (element) => getComputedStyle(element).opacity,
      ),
      "1",
      "folder icon is visible to keyboard users",
    );
    await window.keyboard.press("Enter");
    await waitForRevealCount(app, 2);
    t.deepEqual(
      await app.evaluate(({shell}) =>
        Reflect.get(shell.showItemInFolder, "revealedPaths"),
      ),
      [filePath, filePath],
      "keyboard activation reveals the file",
    );

    await app.evaluate(({shell}, expectedPath) => {
      shell.openPath = async (filePath) => {
        if (filePath !== expectedPath) {
          throw new Error("Wrong downloaded file opened");
        }

        return "Test open error";
      };
    }, filePath);
    await window.click(".download-file");
    await window.waitForSelector("#downloads-error");
    t.ok(
      (await window.textContent("#downloads-error"))!.includes(
        "Test open error",
      ),
      "file click calls openPath and surfaces errors",
    );
    await app.evaluate(({shell}) => {
      shell.openPath = async () => "";
    });
    await window.click(".download-file");
    t.equal(
      await window.isVisible("#downloads-error"),
      false,
      "successfully opening a file clears the error",
    );
    await window.keyboard.press("Escape");
    t.equal(await window.isVisible("#downloads-panel"), false);

    await download(app, url, "newest.txt");
    await window.waitForSelector(".download-file");
    t.deepEqual(
      await window.locator(".download-file").allTextContents(),
      ["newest.txt", fileName],
      "newest download is first",
    );
    await window.locator(".download-row").first().hover();
    await window.locator(".reveal-download").first().click();
    await waitForRevealCount(app, 3);
    t.deepEqual(
      await app.evaluate(({shell}) =>
        Reflect.get(shell.showItemInFolder, "revealedPaths"),
      ),
      [filePath, filePath, path.join(path.dirname(filePath), "newest.txt")],
      "each folder icon reveals its own file",
    );
    await download(app, url, "newest.txt");
    t.equal(
      await window.locator(".download-file").count(),
      2,
      "downloading to the same path does not duplicate history",
    );

    app = await setup.restartApp(app);
    window = await app.firstWindow();
    await window.waitForSelector("#connect");
    t.equal(
      await window.isVisible("#downloads-panel"),
      false,
      "history does not automatically open on startup",
    );
    await showFromMenu();
    await window.waitForSelector(".download-file");
    t.deepEqual(
      await window.locator(".download-file").allTextContents(),
      ["newest.txt", fileName],
      "history survives restarting the app",
    );
    await fs.unlink(path.join(path.dirname(filePath), "newest.txt"));
    await window.locator(".download-row").first().hover();
    await window.locator(".reveal-download").first().click();
    await window.waitForSelector("#downloads-error");
    t.equal(
      await window.textContent("#downloads-error"),
      "Unable to show downloaded file in folder.",
      "revealing a removed file displays an error",
    );
    await window.locator(".download-file").first().click();
    await window.waitForFunction(() =>
      document
        .querySelector("#downloads-error")
        ?.textContent?.includes("Unable to open downloaded file:"),
    );
    t.ok(
      await window.textContent("#downloads-error"),
      "opening a removed file displays an error",
    );
    await setCustomCss(
      app,
      ".downloads-panel { font-size: 10px; } .downloads-panel .download-file { color: rgb(1, 2, 3); }",
    );
    await showFromMenu();
    await window.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".download-file")!).fontSize ===
        "10px",
    );
    t.equal(
      await window
        .locator(".download-file")
        .first()
        .evaluate((element) => getComputedStyle(element).color),
      "rgb(1, 2, 3)",
      "uploaded CSS styles download classes",
    );
    await setCustomCss(app, null);
    await showFromMenu();
    await window.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".download-file")!).fontSize ===
        "12px",
    );
    t.pass("removing uploaded CSS restores compact defaults");
  } finally {
    await setup.endTest(app);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }
});

test("Markdown download preview", async (t) => {
  t.timeoutAfter(60e3);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {"Content-Type": "application/octet-stream"});
    response.end(
      '# Preview heading\n\n**Bold text**\n\n| File | Status |\n| --- | --- |\n| Example | Done |\n\n<script>window.injected = true</script><img src="x" onerror="window.injected = true">',
    );
  });
  const app = await setup.createApp();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test download server did not start");
    }

    const url = `http://127.0.0.1:${address.port}/file`;
    const window = await app.firstWindow();
    await window.waitForSelector("#connect");
    await download(app, url, "ordinary.txt");
    await window.waitForSelector(".download-file");
    t.equal(await window.locator(".preview-download").count(), 0);

    const filePath = await download(app, url, "example.MD");
    const previewButton = window.locator(".preview-download");
    await previewButton.waitFor({state: "attached"});
    t.equal(
      await previewButton.getAttribute("aria-label"),
      "Preview example.MD",
    );
    await window.locator(".download-row").first().hover();
    const previewPromise = app.waitForEvent("window");
    await previewButton.click();
    const preview = await previewPromise;
    await preview.waitForSelector("h1");
    t.equal(await preview.textContent("h1"), "Preview heading");
    t.equal(await preview.textContent("strong"), "Bold text");
    t.equal(await preview.locator("script").count(), 0);
    t.equal(await preview.locator("[onerror]").count(), 0);
    t.equal(
      await preview
        .locator(".downloads-preview-content td")
        .first()
        .evaluate((element) => getComputedStyle(element).fontSize),
      "12px",
      "Markdown tables inherit compact preview text",
    );
    t.equal(
      await app.evaluate(({BrowserWindow}) =>
        BrowserWindow.getAllWindows()
          .find((item) => item.getTitle() === "example.MD")
          ?.getTitle(),
      ),
      "example.MD",
      "preview window title is the filename",
    );
    const previewWindow = await app.browserWindow(preview);
    const pressZoomKey = async (keyCode: string, shift = false) => {
      await previewWindow.evaluate(
        (window, {keyCode, shift}) => {
          const modifiers = shift ? ["control", "shift"] : ["control"];
          window.webContents.sendInputEvent({
            type: "keyDown",
            keyCode,
            modifiers,
          });
          window.webContents.sendInputEvent({
            type: "keyUp",
            keyCode,
            modifiers,
          });
        },
        {keyCode, shift},
      );
    };
    const wheel = async (deltaY: number, control: boolean) => {
      await previewWindow.evaluate(
        async (window, {deltaY, control}) => {
          const previousZoom = window.webContents.zoomLevel;
          window.focus();
          window.webContents.focus();
          window.webContents.sendInputEvent({
            type: "mouseMove",
            x: 100,
            y: 100,
          });
          window.webContents.sendInputEvent({
            type: "mouseWheel",
            x: 100,
            y: 100,
            deltaX: 0,
            deltaY,
            wheelTicksY: Math.sign(deltaY),
            canScroll: true,
            hasPreciseScrollingDeltas: false,
            modifiers: control ? ["control"] : [],
          });
          if (control) {
            const deadline = Date.now() + 2000;
            while (
              window.webContents.zoomLevel === previousZoom &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => {
                setTimeout(resolve, 20);
              });
            }
          }
        },
        {deltaY, control},
      );
    };
    t.equal(
      await previewWindow.evaluate((window) => window.isMenuBarVisible()),
      false,
      "preview has no menu bar",
    );
    await preview.keyboard.press("Alt");
    t.equal(
      await previewWindow.evaluate((window) => window.isMenuBarVisible()),
      false,
      "Alt does not reveal a preview menu",
    );
    const originalZoom = await previewWindow.evaluate(
      (window) => window.webContents.zoomLevel,
    );
    await pressZoomKey("=");
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.zoomLevel),
      originalZoom + 0.5,
      "Ctrl plus zooms in without a menu",
    );
    await pressZoomKey("-");
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.zoomLevel),
      originalZoom,
      "Ctrl minus zooms out",
    );
    await pressZoomKey("+", true);
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.zoomLevel),
      originalZoom + 0.5,
      "Ctrl Shift plus also zooms in",
    );
    await pressZoomKey("0");
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.zoomLevel),
      0,
      "Ctrl zero resets zoom",
    );
    await wheel(120, true);
    t.ok(
      (await previewWindow.evaluate((window) => window.webContents.zoomLevel)) >
        0,
      "Ctrl wheel zooms in",
    );
    await wheel(-120, true);
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.zoomLevel),
      0,
      "Ctrl wheel zooms out",
    );
    await wheel(-120, false);
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.zoomLevel),
      0,
      "wheel without Ctrl does not change zoom",
    );
    await preview.close();
    await setCustomCss(
      app,
      ".downloads-preview { font-size: 10px; } .downloads-preview-content table { color: rgb(1, 2, 3); }",
    );
    const styledPreviewPromise = app.waitForEvent("window");
    await previewButton.click();
    const styledPreview = await styledPreviewPromise;
    await styledPreview.waitForSelector("table");
    await styledPreview.waitForFunction(
      () => getComputedStyle(document.body).fontSize === "10px",
    );
    t.equal(
      await styledPreview
        .locator("table")
        .evaluate((element) => getComputedStyle(element).color),
      "rgb(1, 2, 3)",
      "uploaded CSS styles the Markdown preview",
    );
    await styledPreview.close();
    await setCustomCss(app, null);
    await fs.unlink(filePath);
    await previewButton.click();
    await window.waitForSelector("#downloads-error");
    t.equal(
      await window.textContent("#downloads-error"),
      "Unable to preview downloaded file.",
      "previewing a removed file displays an error",
    );
  } finally {
    await setup.endTest(app);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }
});
