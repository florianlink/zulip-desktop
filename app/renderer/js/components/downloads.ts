import fs from "node:fs/promises";

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

import type {Config} from "../../../common/config-util.ts";
import * as ConfigUtil from "../../../common/config-util.ts";
import {html} from "../../../common/html.ts";
import Logger from "../../../common/logger-util.ts";
import {t} from "../../../common/translation-util.ts";
import {ipcRenderer} from "../typed-ipc-renderer.ts";

const logger = new Logger({file: "downloads.log"});
const markdown = new MarkdownIt({html: true});

export class DownloadsView {
  private readonly panel: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly error: HTMLParagraphElement;
  private previousFocus: Element | null = null;
  private readonly customStyle = document.createElement("style");
  private cssRevision = 0;

  constructor() {
    this.panel = document.createElement("aside");
    this.panel.id = "downloads-panel";
    this.panel.className = "downloads-panel";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-labelledby", "downloads-heading");
    this.panel.innerHTML = html`
      <header class="downloads-header">
        <h2 id="downloads-heading" class="downloads-heading">
          ${t.__("Recent Downloads")}
        </h2>
        <button id="close-downloads" class="downloads-close" type="button">
          ${t.__("Close")}
        </button>
      </header>
      <p id="downloads-error" class="downloads-error" role="alert" hidden></p>
      <ul id="downloads-list" class="downloads-list"></ul>
    `.html;
    this.list = this.panel.querySelector<HTMLUListElement>("#downloads-list")!;
    this.error =
      this.panel.querySelector<HTMLParagraphElement>("#downloads-error")!;
    document.body.append(this.panel);
    document.head.append(this.customStyle);

    this.panel
      .querySelector("#close-downloads")!
      .addEventListener("click", () => {
        this.hide();
      });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.panel.hidden) {
        this.hide();
      }
    });

    ipcRenderer.on("downloads-updated", (_event, downloads) => {
      this.render(downloads);
      void this.show(false);
    });
    ipcRenderer.on("show-recent-downloads", () => {
      void this.open();
    });
    ipcRenderer.on("preview-markdown-download", (_event, filePath) => {
      void this.previewFile(filePath);
    });
  }

  private async open(): Promise<void> {
    try {
      this.render(await ipcRenderer.invoke("get-recent-downloads"));
    } catch (error: unknown) {
      logger.error("Unable to load download history", error);
      this.showError(t.__("Unable to load download history."));
    }

    await this.show(true);
  }

  private async show(focus: boolean): Promise<void> {
    if (this.panel.hidden) {
      this.previousFocus = document.activeElement;
    }

    this.panel.hidden = false;
    if (focus) {
      this.panel.querySelector("button")!.focus();
    }

    const revision = ++this.cssRevision;
    try {
      const cssPath = ConfigUtil.getConfigItem("customCSS", null);
      const css = cssPath ? await fs.readFile(cssPath, "utf8") : "";
      if (revision === this.cssRevision) {
        this.customStyle.textContent = css;
      }
    } catch (error: unknown) {
      logger.error("Unable to load custom CSS for downloads", error);
      if (revision === this.cssRevision) {
        this.customStyle.textContent = "";
        this.showError(t.__("Unable to load custom CSS for downloads."));
      }
    }
  }

  private hide(): void {
    this.panel.hidden = true;
    if (
      this.panel.contains(document.activeElement) &&
      this.previousFocus instanceof HTMLElement &&
      this.previousFocus.isConnected
    ) {
      this.previousFocus.focus();
    }
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private render(downloads: Config["recentDownloads"]): void {
    this.list.replaceChildren();
    this.error.hidden = true;
    if (downloads.length === 0) {
      const empty = document.createElement("li");
      empty.className = "downloads-empty";
      empty.textContent = t.__("No recent downloads.");
      this.list.append(empty);
    }

    for (const download of downloads) {
      const item = document.createElement("li");
      item.className = "download-row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "download-file";
      button.textContent = download.fileName;
      button.title = download.filePath;
      button.addEventListener("click", () => {
        void this.openFile(download.filePath);
      });
      if (download.fileName.toLowerCase().endsWith(".md")) {
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.className = "preview-download";
        previewButton.title = t.__("Preview Markdown");
        previewButton.setAttribute(
          "aria-label",
          t.__("Preview {{{fileName}}}", {fileName: download.fileName}),
        );
        const previewIcon = document.createElement("span");
        previewIcon.className = "material-icons download-icon";
        previewIcon.setAttribute("aria-hidden", "true");
        previewIcon.textContent = "visibility";
        previewButton.append(previewIcon);
        previewButton.addEventListener("click", () => {
          void this.previewFile(download.filePath);
        });
        item.append(button, previewButton);
      } else {
        item.append(button);
      }

      const revealButton = document.createElement("button");
      revealButton.type = "button";
      revealButton.className = "reveal-download";
      revealButton.title = t.__("Show in folder");
      revealButton.setAttribute(
        "aria-label",
        t.__("Show {{{fileName}}} in folder", {fileName: download.fileName}),
      );
      const icon = document.createElement("span");
      icon.className = "material-icons download-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "folder_open";
      revealButton.append(icon);
      revealButton.addEventListener("click", () => {
        void this.revealFile(download.filePath);
      });
      item.append(revealButton);
      this.list.append(item);
    }

    this.list.scrollTop = 0;
  }

  private async previewFile(filePath: string): Promise<void> {
    this.error.hidden = true;
    try {
      const source = await ipcRenderer.invoke(
        "read-markdown-download",
        filePath,
      );
      const sanitizedHtml = DOMPurify.sanitize(markdown.render(source));
      await ipcRenderer.invoke(
        "open-markdown-preview",
        filePath,
        sanitizedHtml,
      );
    } catch (error: unknown) {
      logger.error("Unable to preview downloaded file", error);
      this.showError(t.__("Unable to preview downloaded file."));
      await this.show(true);
    }
  }

  private async revealFile(filePath: string): Promise<void> {
    this.error.hidden = true;
    try {
      await ipcRenderer.invoke("reveal-download", filePath);
    } catch (error: unknown) {
      logger.error("Unable to reveal downloaded file", error);
      this.showError(t.__("Unable to show downloaded file in folder."));
    }
  }

  private async openFile(filePath: string): Promise<void> {
    this.error.hidden = true;
    try {
      const error = await ipcRenderer.invoke("open-download", filePath);
      if (error) {
        this.showError(t.__("Unable to open downloaded file:") + " " + error);
      }
    } catch (error: unknown) {
      logger.error("Unable to open downloaded file", error);
      this.showError(t.__("Unable to open downloaded file."));
    }
  }
}
