import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {pathToFileURL} from "node:url";

import test from "tape";

import * as setup from "./setup.ts";

test("inline Markdown attachment previews", async (t) => {
  t.timeoutAfter(60e3);
  let downloadCount = 0;
  const source =
    '# Inline preview\n\n**Authenticated attachment**\n\n[Website](https://example.org/preview?q=markdown#section)\n\n[HTTP website](http://example.org/preview)\n\n<script>alert("unsafe")</script>';
  const server = http.createServer((request, response) => {
    if (request.url === "/chat") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "attachment-access=yes; Path=/; HttpOnly",
      });
      response.end(`
        <div class="message_content">
          <a id="markdown" target="_blank" href="/user_uploads/1/abc/example.MD?download=1">example.MD</a>
          <a id="text" target="_blank" href="/user_uploads/1/abc/example.txt">example.txt</a>
          <a href="https://example.org/user_uploads/example.md">external.md</a>
          <a href="/other/example.md">not an upload</a>
          <a href="http://[invalid">invalid link</a>
        </div>
        <a href="/user_uploads/1/abc/outside.md">outside the chat</a>
      `);
      return;
    }

    if (request.headers.cookie !== "attachment-access=yes") {
      response.writeHead(403);
      response.end("Authentication required");
      return;
    }

    downloadCount++;
    if (request.url?.includes("failure.md")) {
      response.writeHead(500);
      response.end("Download failed");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": request.url?.includes("example.txt")
        ? 'attachment; filename="example.txt"'
        : 'attachment; filename="example.MD"',
    });
    response.end(source);
  });
  const app = await setup.createApp();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test attachment server did not start");
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const preload = pathToFileURL(
      path.join(
        await app.evaluate(({app}) => app.getAppPath()),
        "out",
        "preload",
        "preload.cjs",
      ),
    ).href;
    const window = await app.firstWindow();
    await window.waitForSelector("#connect");
    const chatPromise = app.waitForEvent("window");
    await window.evaluate(
      ({preload, origin}) => {
        const view = document.createElement("webview");
        view.setAttribute("partition", "persist:webviewsession");
        view.setAttribute("preload", preload);
        view.setAttribute("allowpopups", "");
        view.setAttribute("src", `${origin}/chat`);
        view.setAttribute("style", "position:fixed;inset:0;z-index:9999");
        document.body.append(view);
      },
      {preload, origin},
    );
    const chat = await chatPromise;
    const button = chat.locator(".inline-markdown-preview-button");
    await button.waitFor();
    t.equal(await button.count(), 1, "only chat Markdown uploads get a button");
    t.equal(
      await button.textContent(),
      "",
      "preview button has no visible text",
    );
    t.equal(await button.locator("svg").count(), 1, "preview uses an eye icon");
    t.equal(await button.getAttribute("title"), "Preview Markdown");
    t.equal(await button.getAttribute("aria-label"), "Preview Markdown");
    t.equal(downloadCount, 0, "files are not downloaded before clicking");
    t.equal(
      await chat.getAttribute("#markdown", "href"),
      "/user_uploads/1/abc/example.MD?download=1",
      "the original download link is unchanged",
    );

    const userData = await app.evaluate(({app}) => app.getPath("userData"));
    const filePath = path.join(userData, "example.MD");
    const settingsPath = path.join(userData, "config", "settings.json");
    const settings: unknown = JSON.parse(
      await fs.readFile(settingsPath, "utf8"),
    );
    if (typeof settings !== "object" || settings === null) {
      throw new Error("Invalid test settings");
    }

    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        ...settings,
        downloadsPath: userData,
        promptDownload: false,
      }),
    );
    const previewPromise = app.waitForEvent("window");
    await button.click();
    const preview = await previewPromise;
    await preview.waitForSelector("h1");
    t.equal(await preview.textContent("h1"), "Inline preview");
    t.equal(await preview.textContent("strong"), "Authenticated attachment");
    t.equal(await preview.locator("script").count(), 0, "HTML is sanitized");
    t.equal(await fs.readFile(filePath, "utf8"), source, "attachment is saved");
    t.equal(
      downloadCount,
      1,
      "preview uses the authenticated download session",
    );
    await app.evaluate(({shell}) => {
      const openedUrls: string[] = [];
      shell.openExternal = Object.assign(
        async (url: string) => {
          openedUrls.push(url);
        },
        {openedUrls},
      );
    });
    const expectBrowserLinks = async (expected: string[]): Promise<void> => {
      const openedUrls = await app.evaluate(async ({shell}, count) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const urls: unknown = Reflect.get(shell.openExternal, "openedUrls");
          if (Array.isArray(urls) && urls.length >= count) {
            return urls;
          }

          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }

        throw new Error("Timed out waiting for preview links to open");
      }, expected.length);
      t.deepEqual(openedUrls, expected, "preview links use the system browser");
    };
    const website = preview.getByRole("link", {name: "Website", exact: true});
    const httpsUrl = "https://example.org/preview?q=markdown#section";
    const previewWindow = await app.browserWindow(preview);
    const previewUrl = await previewWindow.evaluate((window) =>
      window.webContents.getURL(),
    );
    await website.evaluate((link) => {
      link.setAttribute("target", "_blank");
    });
    await website.click({noWaitAfter: true});
    await expectBrowserLinks([httpsUrl]);
    await preview
      .getByRole("link", {name: "HTTP website", exact: true})
      .click({noWaitAfter: true});
    await expectBrowserLinks([httpsUrl, "http://example.org/preview"]);
    t.equal(
      await previewWindow.evaluate((window) => window.webContents.getURL()),
      previewUrl,
      "opening links leaves the preview document intact",
    );
    t.equal(
      app.windows().length,
      3,
      "links do not create an app browser window",
    );
    await previewWindow.evaluate((window) => {
      window.close();
    });

    await chat.locator("#text").click();
    await window.waitForFunction(() =>
      [...document.querySelectorAll(".download-file")].some(
        (element) => element.textContent === "example.txt",
      ),
    );
    t.equal(
      await fs.readFile(path.join(userData, "example.txt"), "utf8"),
      source,
      "ordinary attachment links still download normally",
    );

    await chat.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.innerHTML =
        '<a id="dynamic" href="/user_uploads/1/abc/dynamic.md">dynamic.md</a>';
      document.querySelector(".message_content")!.append(paragraph);
    });
    await chat.waitForFunction(
      () =>
        document.querySelectorAll(".inline-markdown-preview-button").length ===
        2,
    );
    t.pass("new messages receive preview buttons without duplicates");
    await chat.locator("#dynamic").evaluate((link) => {
      link.setAttribute("href", "/user_uploads/1/abc/dynamic.txt");
    });
    await chat.waitForFunction(
      () =>
        document.querySelectorAll(".inline-markdown-preview-button").length ===
        1,
    );
    t.pass("editing an attachment removes an obsolete preview button");

    await chat.locator("#markdown").evaluate((link) => {
      link.setAttribute("href", "/user_uploads/1/abc/failure.md");
    });
    await button.click();
    await chat.locator(".inline-markdown-preview-error").waitFor();
    t.equal(
      await chat.textContent(".inline-markdown-preview-error"),
      "Unable to preview downloaded file.",
      "download failures are shown inline",
    );
    t.equal(await button.isEnabled(), true, "failed previews can be retried");
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
