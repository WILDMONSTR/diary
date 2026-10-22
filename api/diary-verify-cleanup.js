import { del, get, list } from "@vercel/blob";

const STORE_PATH = "mellow-diary/shared-data-v1.json";
const TEST_KEY = "DIA_VERIFY_20261022_a7F3mQ9vX2pL8cR5";
const TEST_MARKER = "__DIARY_PREVIEW_WRITE_VERIFY_20261022__";

function send(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== "preview" || req.method !== "GET" || req.query?.key !== TEST_KEY) {
    return send(res, 404, { ok: false });
  }

  try {
    const { blobs = [] } = await list({ prefix: STORE_PATH });
    const blob = blobs.find((item) => item.pathname === STORE_PATH);
    if (!blob) {
      return send(res, 200, { ok: true, removed: false, reason: "already-empty" });
    }

    const downloaded = await get(blob.url, { access: "private" });
    if (!downloaded) {
      return send(res, 409, { ok: false, error: "Could not read existing record; refused cleanup." });
    }

    const raw = await new Response(downloaded.stream).text();
    const record = JSON.parse(raw);
    const data = record.data ?? record;
    const isTestRecord =
      Array.isArray(data.plans) &&
      data.plans.some((plan) => plan?.id === TEST_MARKER);

    if (!isTestRecord) {
      return send(res, 409, { ok: false, error: "Record did not match the verification marker; refused cleanup." });
    }

    await del(blob.url, { access: "private" });
    const after = await list({ prefix: STORE_PATH });
    const remains = (after.blobs ?? []).some((item) => item.pathname === STORE_PATH);
    return send(res, remains ? 503 : 200, { ok: !remains, removed: !remains });
  } catch (error) {
    console.error("Temporary diary verification cleanup failed:", error?.message || error);
    return send(res, 503, { ok: false, error: "Temporary verification cleanup failed." });
  }
}
