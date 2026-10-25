import { createHmac, timingSafeEqual } from "node:crypto";
import { get, list, put } from "@vercel/blob";

const USER_STORE_PREFIX = "mellow-diary/users/";
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS_PER_COLLECTION = 5000;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function send(res, status, payload) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function authenticateRequest(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    throw httpError(401, "로그인이 필요합니다. 로그인한 뒤 다시 시도해 주세요.");
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || "");
  if (!supabaseUrl || !publishableKey) {
    console.error("Diary API auth configuration is missing.");
    throw httpError(503, "인증 서버 설정이 준비되지 않았습니다. 배포 환경변수를 확인해 주세요.");
  }

  let response;
  try {
    response = await fetch(supabaseUrl + "/auth/v1/user", {
      method: "GET",
      headers: {
        apikey: publishableKey,
        Authorization: "Bearer " + match[1],
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      cache: "no-store",
    });
  } catch (error) {
    console.error("Supabase user verification request failed:", error?.message || error);
    throw httpError(503, "인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 400) {
      throw httpError(401, "로그인 세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.");
    }
    console.error("Supabase user verification returned status:", response.status);
    throw httpError(503, "인증 서버에서 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const user = await response.json().catch(() => null);
  if (!user || typeof user.id !== "string" || !USER_ID_PATTERN.test(user.id)) {
    throw httpError(401, "유효한 계정을 확인하지 못했습니다. 다시 로그인해 주세요.");
  }

  return user;
}

function userStorePath(userId) {
  // This ID is taken only from the Supabase Auth response, never from request data.
  if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
    throw httpError(401, "유효한 계정 ID가 아닙니다.");
  }
  return USER_STORE_PREFIX + userId.toLowerCase() + "/diary-data-v1.json";
}

const BLOB_POINTER_URL_KEY = "personal_diary_blob_url";
const BLOB_POINTER_SIGNATURE_KEY = "personal_diary_blob_signature";

function signBlobPointer(userId, blobUrl) {
  const secret = String(process.env.BLOB_READ_WRITE_TOKEN || "");
  if (!secret || typeof blobUrl !== "string" || !blobUrl) return null;
  return createHmac("sha256", secret).update(userId + "\n" + blobUrl, "utf8").digest("hex");
}

function getVerifiedBlobPointer(user) {
  const metadata = user?.user_metadata || {};
  const blobUrl = metadata[BLOB_POINTER_URL_KEY];
  const signature = metadata[BLOB_POINTER_SIGNATURE_KEY];
  if (typeof blobUrl !== "string" || !blobUrl.startsWith("https://") ||
      typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return null;

  const expected = signBlobPointer(user.id, blobUrl);
  if (!expected || expected.length !== signature.length) return null;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8")) ? blobUrl : null;
}

function blobPointerPayload(userId, blobUrl) {
  return {
    blobUrl: blobUrl || null,
    blobSignature: blobUrl ? signBlobPointer(userId, blobUrl) : null,
  };
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

async function readUserDiary(pathname, user) {
  const metadata = user?.user_metadata || {};
  const hadStoredPointer = Boolean(metadata[BLOB_POINTER_URL_KEY] || metadata[BLOB_POINTER_SIGNATURE_KEY]);
  let blobUrl = getVerifiedBlobPointer(user);
  let blob = null;
  let downloaded = null;

  // A signed pointer is bound to this verified Supabase user ID.
  // Once stored, this reads the private Blob directly without calling list().
  if (blobUrl) {
    try {
      const candidate = await get(blobUrl, { access: "private", useCache: false });
      if (candidate && candidate.blob && candidate.blob.pathname === pathname) {
        downloaded = candidate;
        blob = candidate.blob;
      }
    } catch (error) {
      console.warn("Saved Blob pointer could not be read; falling back to exact-path lookup.");
    }
  }

  // Only the initial lookup or a stale pointer needs the Advanced Operation list().
  if (!downloaded) {
    const { blobs = [] } = await list({ prefix: pathname, limit: 1 });
    blob = blobs.find((item) => item.pathname === pathname);
    if (!blob) {
      return {
        exists: false,
        data: null,
        updatedAt: null,
        ...(hadStoredPointer ? { clearBlobPointer: true } : {}),
      };
    }
    blobUrl = blob.url;
    downloaded = await get(blobUrl, { access: "private", useCache: false });
  }

  if (!downloaded) return { exists: false, data: null, updatedAt: null };

  const rawText = await new Response(downloaded.stream).text();
  const record = JSON.parse(rawText);
  const data = cleanData(record.data ?? record);
  const resolvedUrl = blobUrl || blob?.url || downloaded.blob?.url;
  return {
    exists: true,
    data,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    etag: blob?.etag || downloaded.blob?.etag || null,
    ...blobPointerPayload(user.id, resolvedUrl),
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT");
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  let user;
  try {
    user = await authenticateRequest(req);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
    return send(res, status, {
      ok: false,
      error: error?.message || "인증을 확인하지 못했습니다.",
    });
  }

  // The server derives the Blob pathname from the verified user, so clients
  // cannot request another account's file by changing a user ID in the body/query.
  const pathname = userStorePath(user.id);

  if (req.method === "GET") {
    try {
      const result = await readUserDiary(pathname, user);
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      console.error("User diary cloud read failed:", error?.message || error);
      return send(res, 503, {
        ok: false,
        error: "이 계정의 다이어리를 읽지 못했습니다. Blob 연결과 배포 설정을 확인해 주세요.",
      });
    }
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString("utf8"));
    const data = cleanData(body?.data);
    const updatedAt = new Date().toISOString();
    const contents = JSON.stringify({ schemaVersion: 1, updatedAt, data });
    const expectedEtag = typeof body?.expectedEtag === "string" ? body.expectedEtag.trim() : "";
    // Existing blobs are updated only if their ETag still matches the last read.
    // A first write does not overwrite a blob created concurrently by another device.
    const writeOptions = {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
      ...(expectedEtag
        ? { allowOverwrite: true, ifMatch: expectedEtag }
        : { allowOverwrite: false }),
    };
    const savedBlob = await put(pathname, contents, writeOptions);

    return send(res, 200, {
      ok: true,
      exists: true,
      updatedAt,
      etag: savedBlob?.etag || null,
      ...blobPointerPayload(user.id, savedBlob?.url),
    });
  } catch (error) {
    const message = String(error?.message || "");
    const isConflict =
      error?.name === "BlobPreconditionFailedError" ||
      error?.name === "BlobAlreadyExistsError" ||
      /precondition|etag|already exists|already been created|overwrite/i.test(message);
    const status = /exceeds|must be|invalid record|data\./i.test(message)
      ? 400
      : isConflict
        ? 409
        : 503;
    if (status === 400) {
      console.warn("User diary cloud write rejected:", message);
    } else if (status === 409) {
      console.warn("User diary cloud write conflict:", message);
    } else {
      console.error("User diary cloud write failed:", error?.message || error);
    }
    return send(res, status, {
      ok: false,
      error: status === 400
        ? message
        : status === 409
          ? "중앙 기록이 다른 기기에서 먼저 변경되었거나 새로 생성되었습니다. 기존 로컬 기록은 보존했습니다. 다시 동기화해 최신 기록을 확인해 주세요."
          : "이 계정의 다이어리에 저장하지 못했습니다. Blob 연결 또는 사용 한도를 확인해 주세요.",
    });
  }
}
