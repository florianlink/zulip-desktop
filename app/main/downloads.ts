import {shell} from "electron/common";
import {
  BrowserWindow,
  type Session,
  type WebContents,
  app,
  dialog,
} from "electron/main";
import fs from "node:fs/promises";
import path from "node:path";

import * as ConfigUtil from "../common/config-util.ts";
import * as LinkUtil from "../common/link-util.ts";
import Logger from "../common/logger-util.ts";
import {isMarkdownUploadUrl} from "../common/markdown-util.ts";
import {t} from "../common/translation-util.ts";
import type {DownloadEntry} from "../common/typed-ipc.ts";

import {downloadFile} from "./handle-external-link.ts";
import {ipcMain, send} from "./typed-ipc-main.ts";

const logger = new Logger({file: "downloads.log"});

export function initializeDownloads(
  session: Session,
  mainContents: WebContents,
): void {
  const activeDownloads = new Map<
    Electron.DownloadItem,
    DownloadEntry | undefined
  >();
  const highlightedDownloads = new Set<string>();
  const getDownloads = (): DownloadEntry[] => {
    const active = [...activeDownloads.values()]
      .filter((download) => download !== undefined)
      .reverse();
    return [
      ...active,
      ...ConfigUtil.getConfigItem("recentDownloads", [])
        .filter(
          (download) =>
            !active.some((item) => item.filePath === download.filePath),
        )
        .map((download) => ({
          ...download,
          highlighted: highlightedDownloads.has(download.filePath),
        })),
    ];
  };
  const notifyDownloads = (show: boolean): void => {
    if (!mainContents.isDestroyed()) {
      send(mainContents, "downloads-updated", getDownloads(), show);
    }
  };

  ipcMain.handle("get-markdown-preview-labels", () => ({
    preview: t.__("Preview Markdown"),
    error: t.__("Unable to preview downloaded file."),
  }));

  ipcMain.handle("preview-markdown-url", async (event, value) => {
    const contents = event.sender;
    const url = new URL(value);
    if (
      event.senderFrame !== contents.mainFrame ||
      contents.getType() !== "webview" ||
      contents.session !== session ||
      !isMarkdownUploadUrl(url, new URL(contents.getURL()).origin)
    ) {
      throw new Error("Only Markdown uploads from this chat can be previewed");
    }

    try {
      const filePath = await new Promise<string>((resolve, reject) => {
        downloadFile({
          contents,
          url: url.href,
          downloadPath: ConfigUtil.getConfigItem(
            "downloadsPath",
            app.getPath("downloads"),
          ),
          async completed(filePath) {
            resolve(filePath);
          },
          failed(state) {
            reject(new Error(`Markdown download ${state}`));
          },
        });
      });
      if (path.extname(filePath).toLowerCase() !== ".md") {
        throw new Error("The downloaded file is not a Markdown file");
      }

      send(mainContents, "preview-markdown-download", filePath);
    } catch (error: unknown) {
      logger.error("Unable to download Markdown preview", error);
      throw error;
    }
  });

  function validateDownload(
    senderFrame: Electron.WebFrameMain | null,
    filePath: string,
  ): void {
    if (
      senderFrame !== mainContents.mainFrame ||
      typeof filePath !== "string" ||
      !ConfigUtil.getConfigItem("recentDownloads", []).some(
        (download) => download.filePath === filePath,
      ) ||
      [...activeDownloads.values()].some(
        (download) => download?.filePath === filePath,
      )
    ) {
      throw new Error("Cannot access a file outside the download history");
    }
  }

  ipcMain.handle("get-recent-downloads", (event) => {
    if (event.senderFrame !== mainContents.mainFrame) {
      throw new Error("Download history is only available to the app window");
    }

    return getDownloads();
  });

  ipcMain.handle("open-download", async (event, filePath) => {
    validateDownload(event.senderFrame, filePath);

    const error = await shell.openPath(filePath);
    if (error) {
      logger.error("Unable to open downloaded file", filePath, error);
    }

    return error;
  });

  ipcMain.handle("delete-download", async (event, filePath) => {
    validateDownload(event.senderFrame, filePath);
    const window = BrowserWindow.fromWebContents(mainContents);
    if (!window) {
      throw new Error("Cannot confirm file deletion without the app window");
    }

    const {response} = await dialog.showMessageBox(window, {
      type: "warning",
      buttons: [t.__("Delete"), t.__("Cancel")],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: t.__("Are you sure you want to delete {{{fileName}}}?", {
        fileName: path.basename(filePath),
      }),
      detail: t.__("The file will be moved to the trash.") + "\n" + filePath,
    });
    if (response !== 0) {
      return;
    }

    validateDownload(event.senderFrame, filePath);
    try {
      await shell.trashItem(filePath);
      ConfigUtil.setConfigItem(
        "recentDownloads",
        ConfigUtil.getConfigItem("recentDownloads", []).filter(
          (download) => download.filePath !== filePath,
        ),
      );
      highlightedDownloads.delete(filePath);
      notifyDownloads(false);
    } catch (error: unknown) {
      logger.error("Unable to delete downloaded file", filePath, error);
      throw error;
    }
  });

  ipcMain.handle("read-markdown-download", async (event, filePath) => {
    validateDownload(event.senderFrame, filePath);
    if (path.extname(filePath).toLowerCase() !== ".md") {
      throw new Error("Only Markdown downloads can be previewed");
    }

    return fs.readFile(filePath, "utf8");
  });

  ipcMain.handle("open-markdown-preview", async (event, filePath, html) => {
    validateDownload(event.senderFrame, filePath);
    if (
      typeof html !== "string" ||
      path.extname(filePath).toLowerCase() !== ".md"
    ) {
      throw new Error("Only Markdown downloads can be previewed");
    }

    const cssPath = ConfigUtil.getConfigItem("customCSS", null);
    const customCss = cssPath ? await fs.readFile(cssPath, "utf8") : "";
    const preview = new BrowserWindow({
      title: path.basename(filePath),
      width: 900,
      height: 700,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    });
    preview.setMenu(null);
    preview.webContents.setIgnoreMenuShortcuts(true);
    preview.webContents.on("zoom-changed", (_event, direction) => {
      preview.webContents.zoomLevel += direction === "in" ? 0.5 : -0.5;
    });
    preview.webContents.on("before-input-event", (event, input) => {
      if (
        input.type !== "keyDown" ||
        (!input.control && !input.meta) ||
        input.alt
      ) {
        return;
      }

      switch (input.key) {
        case "+":
        case "=": {
          event.preventDefault();
          preview.webContents.zoomLevel += 0.5;
          break;
        }

        case "-": {
          event.preventDefault();
          preview.webContents.zoomLevel -= 0.5;
          break;
        }

        case "0": {
          event.preventDefault();
          preview.webContents.zoomLevel = 0;
          break;
        }

        default: {
          break;
        }
      }
    });
    preview.on("page-title-updated", (titleEvent) => {
      titleEvent.preventDefault();
    });
    const openLink = (value: string): void => {
      const url = new URL(value);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
        logger.warn("Blocked Markdown preview link", url.protocol);
        return;
      }

      void LinkUtil.openBrowser(url).catch((error: unknown) => {
        logger.error("Unable to open Markdown preview link", error);
      });
    };
    preview.webContents.on("will-navigate", (navigationEvent, url) => {
      navigationEvent.preventDefault();
      openLink(url);
    });
    preview.webContents.setWindowOpenHandler(({url}) => {
      openLink(url);
      return {action: "deny"};
    });
    const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:where(.downloads-preview) { max-width: 800px; margin: 24px auto; padding: 0 24px; font: 12px/1.5 sans-serif; overflow-wrap: anywhere; } :where(.downloads-preview img) { max-width: 100%; } :where(.downloads-preview pre) { overflow: auto; } </style></head><body class="downloads-preview"><article class="downloads-preview-content">${html}</article></body></html>`;
    try {
      await preview.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
      );
      if (customCss) {
        await preview.webContents.insertCSS(customCss);
      }
    } catch (error: unknown) {
      preview.destroy();
      throw error;
    }
  });

  ipcMain.handle("reveal-download", async (event, filePath) => {
    validateDownload(event.senderFrame, filePath);
    try {
      await fs.access(filePath);
      shell.showItemInFolder(filePath);
    } catch (error: unknown) {
      logger.error("Unable to reveal downloaded file", filePath, error);
      throw error;
    }
  });

  session.on("will-download", (_event, item) => {
    activeDownloads.set(item, undefined);
    const updateDownload = (): void => {
      if (!activeDownloads.has(item)) {
        return;
      }

      const filePath = item.getSavePath();
      if (!filePath) {
        return;
      }

      const total = item.getTotalBytes();
      const progress =
        total > 0
          ? Math.min(100, Math.floor((item.getReceivedBytes() / total) * 100))
          : null;
      const previous = activeDownloads.get(item);
      if (previous?.filePath === filePath && previous.progress === progress) {
        return;
      }

      activeDownloads.set(item, {
        filePath,
        fileName: path.basename(filePath),
        progress,
      });
      notifyDownloads(previous === undefined);
    };
    item.on("updated", updateDownload);
    // Other will-download listeners may still need to choose the save path.
    queueMicrotask(updateDownload);
    item.once("done", (_doneEvent, state) => {
      activeDownloads.delete(item);
      item.removeListener("updated", updateDownload);
      if (state === "completed") {
        const filePath = item.getSavePath();
        const downloads = [
          {filePath, fileName: path.basename(filePath)},
          ...ConfigUtil.getConfigItem("recentDownloads", []).filter(
            (download) => download.filePath !== filePath,
          ),
        ];
        ConfigUtil.setConfigItem("recentDownloads", downloads);
        highlightedDownloads.add(filePath);
      }

      notifyDownloads(state === "completed");
    });
  });
}
