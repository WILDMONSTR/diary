import { get, list, put } from "@vercel/blob";

const STORE_PATH = "mellow-diary/shared-data-v1.json";
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS_PER_COLLECTION = 5000;

function send(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(payload);
}

function cleanData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("data must be an object");
  }

  const required = ["plans", "tasks", "runs", "completionEvents"];
  for (const key of required) {
    if (!Array.isArray(input[key])) throw new Error(`data.${key} must be an array`);
  }
  if (input.entries !== undefined && !Array.isArray(input.entries)) {
    throw new Error("data.entries must be an array");
  }

  const data = {
    plans: input.plans,
    tasks: input.tasks,
    runs: input.runs,
    completionEvents: input.completionEvents,
    entries: Array.isArray(input.entries) ? input.entries : [],
  };

  for (const [key, values] of Object.entries(data)) {
    if (values.length > MAX_RECORDS_PER_COLLECTION) {
      throw new Error(`data.${key} exceeds the record limit`);
    }
    if (values.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error(`data.${key} contains an invalid record`);
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > MAX_BYTES) throw new Error("Diary data exceeds the 1 MiB limit");
  return data;
}

async function readSharedDiary() {
  const { blobs = [] } = await list({ prefix: STORE_PATH });
  const blob = blobs.find((item) => item.pathname === STORE_PATH);
  if (!blob) return { exists: false, data: null, updatedAt: null };

  const downloaded = await get(blob.url, { access: "private" });
  if (!downloaded) return { exists: false, data: null, updatedAt: null };

  const rawText = await new Response(downloaded.stream).text();
  const record = JSON.parse(rawText);
  const data = cleanData(record.data ?? record);
  return {
    exists: true,
    data,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const result = await readSharedDiary();
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error("Diary cloud read failed:", error?.message || error);
      return send(res, 503, {
        ok: false,
        error: "중앙 다이어리를 읽지 못했습니다. Blob 연결과 배포 설정을 확인해 주세요.",
      });
    }
  }

  if (req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString("utf8"));
    const data = cleanData(body?.data);
    const updatedAt = new Date().toISOString();
    const contents = JSON.stringify({ schemaVersion: 1, updatedAt, data });

    await put(STORE_PATH, contents, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });

    return send(res, 200, { ok: true, exists: true, updatedAt });
  } catch (error) {
    const message = String(error?.message || "");
    const status = /exceeds|must be|invalid record|data\./i.test(message) ? 400 : 503;
    if (status === 400) {
      console.warn("Diary cloud write rejected:", message);
    } else {
      console.error("Diary cloud write failed:", error?.message || error);
    }
    return send(res, status, {
      ok: false,
      error: status === 400
        ? message
        : "중앙 다이어리에 저장하지 못했습니다. Blob 연결 또는 무료 사용 한도를 확인해 주세요.",
    });
  }
}
