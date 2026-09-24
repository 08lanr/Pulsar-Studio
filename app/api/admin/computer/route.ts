import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { syncCloudCopies } from "@/lib/cloud-copy";
import { saveComputer } from "@/lib/computer";
import {
  computerSummary,
  connectFilmsFolder,
  disconnectFilmsFolder,
  downloadPipeline,
  installPythonPackages,
  invalidateReadiness,
  setCloudCopy,
  updatePipeline,
} from "@/lib/computer-setup";
import { ensureInProcessWorker } from "@/lib/segment/worker";
import { handle, parseJson } from "../../titles/_lib/handler";

// This computer (decision 2026-09-24, "two computers, one database"; the
// "This computer" card on Import films and New film run).
//   GET  ?check=1 → ComputerSummary (staff; `check` reruns the readiness checks now)
//   POST { action, ... } → ComputerSummary (admin)
//     rename { name } · connect { folder } · disconnect · pipeline_download ·
//     pipeline_update · install_packages · check · cloud { on } · cloud_sync
// The long ones (download, update, install) start a background task and
// answer at once; the card polls GET while `task` runs. Everything acts on
// this computer's disk and its .studio-computer.json, never the database.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    return NextResponse.json(await computerSummary({ force: req.nextUrl.searchParams.get("check") === "1" }));
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), name: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("connect"), folder: z.string().trim().min(1).max(1024) }),
  z.object({ action: z.literal("disconnect") }),
  z.object({ action: z.literal("pipeline_download") }),
  z.object({ action: z.literal("pipeline_update") }),
  z.object({ action: z.literal("install_packages") }),
  z.object({ action: z.literal("check") }),
  z.object({ action: z.literal("cloud"), on: z.boolean() }),
  z.object({ action: z.literal("cloud_sync") }),
]);

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const body = parsed.data;
    switch (body.action) {
      case "rename":
        saveComputer({ name: body.name });
        break;
      case "connect":
        connectFilmsFolder(body.folder);
        invalidateReadiness();
        ensureInProcessWorker(); // a films folder is what the live worker waits for
        break;
      case "disconnect":
        disconnectFilmsFolder();
        invalidateReadiness();
        break;
      case "pipeline_download":
        downloadPipeline();
        break;
      case "pipeline_update":
        await updatePipeline();
        break;
      case "install_packages":
        await installPythonPackages();
        break;
      case "check":
        invalidateReadiness();
        break;
      case "cloud":
        setCloudCopy(body.on);
        if (body.on) void syncCloudCopies({ force: true });
        break;
      case "cloud_sync":
        void syncCloudCopies({ force: true });
        break;
    }
    return NextResponse.json(await computerSummary({ force: body.action === "check" }));
  });
}
