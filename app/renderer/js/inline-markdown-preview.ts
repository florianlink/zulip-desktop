import {isMarkdownUploadUrl} from "../../common/markdown-util.ts";

import {ipcRenderer} from "./typed-ipc-renderer.ts";

export async function initializeInlineMarkdownPreviews(): Promise<void> {
  const labels = await ipcRenderer.invoke("get-markdown-preview-labels");
  const controls = new Map<HTMLAnchorElement, HTMLSpanElement>();
  const selector = ".message_content a[href]";

  const update = (): void => {
    for (const [link, control] of controls) {
      if (
        !link.matches(selector) ||
        !link.isConnected ||
        !URL.canParse(link.href) ||
        !isMarkdownUploadUrl(new URL(link.href), location.origin)
      ) {
        control.remove();
        controls.delete(link);
      }
    }

    for (const link of document.querySelectorAll<HTMLAnchorElement>(selector)) {
      if (
        controls.has(link) ||
        !URL.canParse(link.href) ||
        !isMarkdownUploadUrl(new URL(link.href), location.origin)
      ) {
        continue;
      }

      const control = document.createElement("span");
      control.className = "inline-markdown-preview";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inline-markdown-preview-button";
      button.title = labels.preview;
      button.setAttribute("aria-label", labels.preview);
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "16");
      icon.setAttribute("height", "16");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.8");
      const outline = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      outline.setAttribute("d", "M2 12Q12 0 22 12Q12 24 2 12Z");
      const pupil = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      pupil.setAttribute("cx", "12");
      pupil.setAttribute("cy", "12");
      pupil.setAttribute("r", "3");
      icon.append(outline, pupil);
      button.append(icon);
      const errorMessage = document.createElement("span");
      errorMessage.className = "inline-markdown-preview-error";
      errorMessage.setAttribute("role", "alert");
      errorMessage.hidden = true;
      control.append(button, errorMessage);
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        errorMessage.hidden = true;
        try {
          await ipcRenderer.invoke("preview-markdown-url", link.href);
        } catch (error: unknown) {
          console.error("Unable to preview Markdown attachment", error);
          errorMessage.textContent = labels.error;
          errorMessage.hidden = false;
        } finally {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
      link.after(control);
      controls.set(link, control);
    }
  };

  update();
  new MutationObserver(update).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "class"],
  });
}
