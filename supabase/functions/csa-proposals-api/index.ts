import { createClient } from "jsr:@supabase/supabase-js@2";

const SHEET_API = "https://csa-prep-sheet.jamesehigh.chatgpt.site/api/sheets";
const MASTER_SHEET_ID = "5444dfa0-e19c-42d1-8f40-4f97a2382c76";
const BUCKET = "csa-proposals";
const cors = {
  "Access-Control-Allow-Origin": "https://jamesehigh.github.io",
  "Access-Control-Allow-Headers": "content-type, x-franchise-token, x-master-sheet",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function cleanName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "proposal.pdf";
}

async function validateToken(token: string) {
  if (!/^[a-f0-9-]{36}$/i.test(token)) return null;
  const response = await fetch(`${SHEET_API}?franchiseToken=${encodeURIComponent(token)}`);
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.restricted || !data.fbc || !data.franchise) return null;
  return { sheetId: data.id || MASTER_SHEET_ID, fbc: data.fbc, franchise: data.franchise };
}

async function recordHash(sheetId: string, fbc: string, franchise: string) {
  const source = new TextEncoder().encode(`${sheetId}\n${fbc}\n${franchise}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "list";
    const token = req.headers.get("x-franchise-token") || url.searchParams.get("token") || "";
    const masterSheet = req.headers.get("x-master-sheet") || url.searchParams.get("sheet") || "";
    const scope = token ? await validateToken(token) : null;
    const master = !scope && masterSheet === MASTER_SHEET_ID;
    if (!scope && !master) return json({ error: "Unauthorized" }, 401);

    if (action === "upload" && req.method === "POST") {
      if (!scope) return json({ error: "Franchise link required" }, 403);
      const form = await req.formData();
      const file = form.get("file");
      const jobNumber = String(form.get("jobNumber") || "").trim();
      if (!(file instanceof File)) return json({ error: "PDF file required" }, 400);
      if (!jobNumber) return json({ error: "Job number required" }, 400);
      if (file.type !== "application/pdf" || !/\.pdf$/i.test(file.name)) {
        return json({ error: "Only PDF files are allowed" }, 400);
      }
      if (file.size <= 0 || file.size > 26214400) {
        return json({ error: "PDF must be 25 MB or smaller" }, 400);
      }
      const folder = await recordHash(scope.sheetId, scope.fbc, scope.franchise);
      const storagePath = `${scope.sheetId}/${folder}/${Date.now()}-${crypto.randomUUID()}-${cleanName(file.name)}`;
      const uploaded = await admin.storage.from(BUCKET).upload(storagePath, file, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploaded.error) return json({ error: uploaded.error.message }, 500);
      const inserted = await admin.from("csa_proposal_files").insert({
        sheet_id: scope.sheetId,
        fbc: scope.fbc,
        franchise: scope.franchise,
        job_number: jobNumber,
        storage_path: storagePath,
        original_name: file.name,
        file_size: file.size,
      }).select().single();
      if (inserted.error) {
        await admin.storage.from(BUCKET).remove([storagePath]);
        return json({ error: inserted.error.message }, 500);
      }
      return json({ file: inserted.data }, 201);
    }

    if (action === "open" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      let query = admin.from("csa_proposal_files").select("*").eq("id", id);
      query = scope
        ? query.eq("sheet_id", scope.sheetId).eq("fbc", scope.fbc).eq("franchise", scope.franchise)
        : query.eq("sheet_id", MASTER_SHEET_ID);
      const found = await query.maybeSingle();
      if (found.error || !found.data) return json({ error: "File not found" }, 404);
      const signed = await admin.storage.from(BUCKET).createSignedUrl(found.data.storage_path, 300);
      if (signed.error) return json({ error: signed.error.message }, 500);
      return json({ url: signed.data.signedUrl });
    }

    if (action === "delete" && req.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      let query = admin.from("csa_proposal_files").select("*").eq("id", id);
      query = scope
        ? query.eq("sheet_id", scope.sheetId).eq("fbc", scope.fbc).eq("franchise", scope.franchise)
        : query.eq("sheet_id", MASTER_SHEET_ID);
      const found = await query.maybeSingle();
      if (found.error || !found.data) return json({ error: "File not found" }, 404);
      const removed = await admin.storage.from(BUCKET).remove([found.data.storage_path]);
      if (removed.error) return json({ error: removed.error.message }, 500);
      const deleted = await admin.from("csa_proposal_files").delete().eq("id", found.data.id);
      if (deleted.error) return json({ error: deleted.error.message }, 500);
      return json({ deleted: true, id: found.data.id });
    }

    let query = admin.from("csa_proposal_files")
      .select("id,sheet_id,fbc,franchise,job_number,original_name,file_size,uploaded_at")
      .order("uploaded_at", { ascending: false });
    query = scope
      ? query.eq("sheet_id", scope.sheetId).eq("fbc", scope.fbc).eq("franchise", scope.franchise)
      : query.eq("sheet_id", MASTER_SHEET_ID);
    const result = await query;
    if (result.error) return json({ error: result.error.message }, 500);
    return json({ files: result.data || [] });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
