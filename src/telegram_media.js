const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function updatesFrom(event) {
  if (event?.kind === "album") return event.updates ?? [];
  if (event?.payload?.kind === "album") return event.payload.updates ?? [];
  const update = event?.payload?.update ?? event?.update ?? event;
  return update ? [update] : [];
}

function largestPhoto(update) {
  const message = update?.message ?? update?.edited_message;
  const photos = message?.photo;
  if (!Array.isArray(photos) || !photos.length) return null;
  return photos.at(-1)?.file_id ?? null;
}

export function createTelegramMediaResolver({ botToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  async function resolveFile(fileId) {
    if (!botToken?.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required for photo extraction");
    const metadataResponse = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    if (!metadataResponse.ok) throw new Error("Telegram getFile request failed");
    const metadata = await metadataResponse.json();
    const filePath = metadata?.result?.file_path;
    if (!metadata?.ok || typeof filePath !== "string") throw new Error("Telegram returned no file path");

    const imageResponse = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    if (!imageResponse.ok) throw new Error("Telegram image download failed");
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Telegram image exceeds the 5 MB limit");
    const mediaType = imageResponse.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    if (!new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]).has(mediaType)) {
      throw new Error("Unsupported Telegram image type");
    }
    return { mediaType, data: bytes.toString("base64") };
  }

  return {
    async resolve(event) {
      if (Array.isArray(event?.images)) return structuredClone(event.images);
      const fileIds = updatesFrom(event).map(largestPhoto).filter(Boolean);
      if (fileIds.length < 1 || fileIds.length > 4) {
        throw new TypeError("Photo extraction requires 1-4 Telegram images");
      }
      return Promise.all(fileIds.map(resolveFile));
    },
  };
}
