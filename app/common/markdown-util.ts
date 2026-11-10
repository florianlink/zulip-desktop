export function isMarkdownUploadUrl(url: URL, origin: string): boolean {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== origin ||
    !url.pathname.startsWith("/user_uploads/")
  ) {
    return false;
  }

  try {
    return decodeURIComponent(url.pathname).toLowerCase().endsWith(".md");
  } catch (error: unknown) {
    if (error instanceof URIError) {
      return false;
    }

    throw error;
  }
}
