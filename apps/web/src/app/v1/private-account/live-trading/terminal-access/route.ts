import {
  inspectLiveTradingOpeningAccess,
} from "@/lib/live-trading-opening-access.server";
import {
  privateAccountOwnerFromRequest,
  privateAccountSessionTokenFromRequest,
} from "../../_lib";
import { createTerminalAccessStatusGet } from "./_handler";

export const dynamic = "force-dynamic";

export const GET = createTerminalAccessStatusGet({
  ownerFromRequest: privateAccountOwnerFromRequest,
  sessionTokenFromRequest: privateAccountSessionTokenFromRequest,
  inspectOpeningAccess: inspectLiveTradingOpeningAccess,
});
