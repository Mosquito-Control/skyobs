// Always-200 health probe consumed by the TopBar ConnectionChip.
//
// Until Stream C's live ingest lands, the chip's only job is to confirm the
// dashboard can talk to its own Next.js server. Returning a static ok keeps the
// console clean (no 5s 404 spam) and the chip green by default.

import { NextResponse } from "next/server";

export const dynamic = "force-static";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: true, t: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
