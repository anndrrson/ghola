#!/usr/bin/env python3
import json
import sys
import time
from decimal import Decimal, ROUND_DOWN, InvalidOperation, localcontext


MIN_PERP_NOTIONAL = Decimal("10")


def fail(message, error_code="connector_submit_failed", submission_state="not_submitted"):
    print(json.dumps({
        "status": "failed",
        "error": message,
        "error_code": error_code,
        "submission_state": submission_state,
    }))
    sys.exit(1)


def main():
    try:
        payload = json.load(sys.stdin)
        credential = payload["credential"]
        instruction = payload["instruction"]
        cloid = payload["cloid"]
    except Exception:
        fail("invalid runner payload")

    try:
        from eth_account import Account
        from hyperliquid.exchange import Exchange
        from hyperliquid.info import Info
        from hyperliquid.utils.types import Cloid
    except Exception:
        fail("hyperliquid python sdk unavailable")

    base_url = credential.get("base_url") or (
        "https://api.hyperliquid-testnet.xyz"
        if credential.get("network") == "testnet"
        else "https://api.hyperliquid.xyz"
    )
    try:
        wallet = Account.from_key(credential["api_wallet_private_key"])
        account_address = credential["account_address"].lower()
    except Exception:
        fail("hyperliquid credentials are invalid", "venue_access_required")
    exchange = Exchange(wallet, base_url=base_url, account_address=account_address)
    op = instruction.get("operation_class")

    try:
        if payload.get("verify_no_submit"):
            if op != "limit_order":
                fail("unsupported hyperliquid no-submit operation", "venue_rejected")
            order = instruction["order"]
            info = Info(base_url, skip_ws=True)
            resolved = resolve_limit_order(info, order, account_address, require_funds=False)
            Cloid.from_str(cloid)
            print(json.dumps({
                "status": "verified_no_funds",
                "sdk_checked": True,
                "api_wallet_loaded": True,
                "market_data_checked": True,
                "account_state_checked": bool(resolved.get("account_state_checked")),
                "order_request_checked": True,
                "transaction_broadcast": False,
            }))
            return
        if op == "limit_order":
            order = instruction["order"]
            info = Info(base_url, skip_ws=True)
            resolved = resolve_limit_order(info, order, account_address)
            result = exchange.order(
                order["market"],
                order["side"] == "buy",
                float(resolved["base_size"]),
                float(resolved["limit_price"]),
                {"limit": {"tif": resolved["tif"]}},
                reduce_only=bool(order.get("reduce_only")),
                cloid=Cloid.from_str(cloid),
            )
            redacted = redact_result("submitted", result)
            if redacted.get("status") == "rejected":
                fail(
                    "hyperliquid venue rejected order",
                    redacted.get("error_code") or "venue_rejected",
                    "not_submitted",
                )
            if redacted.get("status") == "outcome_unknown":
                fail(
                    "hyperliquid venue returned an unrecognized order result",
                    "connector_submit_failed",
                    "unknown",
                )
            print(json.dumps(redacted))
            return
        if op == "cancel":
            cancel = instruction["cancel"]
            if cancel.get("client_order_id"):
                result = exchange.cancel_by_cloid(cancel["market"], Cloid.from_str(cancel["client_order_id"]))
            else:
                result = exchange.cancel(cancel["market"], int(cancel["order_id"]))
            redacted = redact_result("cancelled", result)
            if redacted.get("status") == "rejected":
                fail("hyperliquid venue rejected cancel", "venue_rejected", "not_submitted")
            if redacted.get("status") == "outcome_unknown":
                fail("hyperliquid venue returned an unrecognized cancel result", "connector_submit_failed", "unknown")
            print(json.dumps(redacted))
            return
        if op in ("read", "reconcile"):
            info = Info(base_url, skip_ws=True)
            fills = info.user_fills_by_time(account_address, int((time.time() - 86400) * 1000))
            print(json.dumps({
                "status": "reconciled",
                "fills": [redact_fill(fill) for fill in fills[:25]],
            }))
            return
    except Exception:
        submission_state = "unknown" if op in ("limit_order", "cancel") else "not_submitted"
        fail("hyperliquid request failed", "connector_submit_failed", submission_state)

    fail("unsupported hyperliquid operation")


def resolve_limit_order(info, order, account_address, require_funds=True):
    if order.get("order_type") == "market":
        return resolve_market_ioc_order(info, order, account_address, require_funds=require_funds)

    if order.get("live_order_mode") != "tiny_fill":
        try:
            price = Decimal(str(order.get("limit_price") or "0"))
            base = Decimal(str(order.get("base_size") or "0"))
            quote = Decimal(str(order.get("quote_size") or "0"))
        except (InvalidOperation, ValueError):
            fail("invalid hyperliquid limit order", "venue_rejected")
        if price <= 0:
            fail("invalid hyperliquid limit price", "venue_rejected")
        if base <= 0 and quote > 0:
            base = floor_decimal(quote / price, coin_size_decimals(info, order.get("market")))
        if base <= 0:
            fail("hyperliquid limit order size is below venue minimum", "venue_rejected")
        notional = base * price
        enforce_minimum_notional(order, notional)
        if notional > 0:
            check_account_value(info, account_address, notional, require_funds=require_funds)
        return {
            "base_size": decimal_text(base),
            "limit_price": decimal_text(price),
            "tif": order.get("tif") or "Gtc",
        }

    coin = order.get("market")
    try:
        quote_size = Decimal(str(order.get("quote_size") or "0"))
        slippage_bps = Decimal(str(order.get("max_slippage_bps") or "50"))
    except (InvalidOperation, ValueError):
        fail("invalid hyperliquid tiny fill order", "venue_rejected")
    if quote_size <= 0 or slippage_bps <= 0:
        fail("invalid hyperliquid tiny fill order", "venue_rejected")

    try:
        mids = info.all_mids()
        mid = Decimal(str(mids[coin]))
    except Exception:
        fail("hyperliquid market data unavailable")
    if mid <= 0:
        fail("hyperliquid market data unavailable")

    account_state_checked = check_account_value(info, account_address, quote_size, require_funds=require_funds)
    slippage = slippage_bps / Decimal("10000")
    limit = mid * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid tiny fill limit", "venue_rejected")

    price = price_to_5_sig(limit)
    base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid tiny fill size is below venue minimum", "venue_rejected")
    enforce_minimum_notional(order, base_size * price)
    return {
        "base_size": decimal_text(base_size),
        "limit_price": decimal_text(price),
        "tif": "Ioc",
        "account_state_checked": account_state_checked,
    }


def resolve_market_ioc_order(info, order, account_address, require_funds=True):
    coin = order.get("market")
    try:
        slippage_bps = Decimal(str(order.get("max_slippage_bps") or "50"))
    except (InvalidOperation, ValueError):
        fail("invalid hyperliquid market order", "venue_rejected")
    if slippage_bps <= 0:
        fail("invalid hyperliquid market order", "venue_rejected")
    try:
        mids = info.all_mids()
        mid = Decimal(str(mids[coin]))
    except Exception:
        fail("hyperliquid market data unavailable")
    if mid <= 0:
        fail("hyperliquid market data unavailable")

    quote_raw = order.get("quote_size")
    base_raw = order.get("base_size")
    try:
        quote_size = Decimal(str(quote_raw)) if quote_raw else Decimal("0")
        base_size = Decimal(str(base_raw)) if base_raw else Decimal("0")
    except (InvalidOperation, ValueError):
        fail("invalid hyperliquid market order size", "venue_rejected")
    if quote_size <= 0 and base_size <= 0:
        fail("invalid hyperliquid market order size", "venue_rejected")

    notional = quote_size if quote_size > 0 else base_size * mid
    account_state_checked = check_account_value(info, account_address, notional, require_funds=require_funds)
    slippage = slippage_bps / Decimal("10000")
    limit = mid * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid market order limit", "venue_rejected")
    price = price_to_5_sig(limit)
    if base_size <= 0:
        base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid market order size is below venue minimum", "venue_rejected")
    enforce_minimum_notional(order, base_size * price)
    return {
        "base_size": decimal_text(base_size),
        "limit_price": decimal_text(price),
        "tif": "Ioc",
        "account_state_checked": account_state_checked,
    }


def check_account_value(info, account_address, quote_size, require_funds=True):
    try:
        abstraction = info.post("/info", {"type": "userAbstraction", "user": account_address})
        if abstraction in ("unifiedAccount", "portfolioMargin"):
            spot_state = info.spot_user_state(account_address)
            account_value = spot_usdc_available(spot_state)
        else:
            state = info.user_state(account_address)
            account_value = Decimal(str(
                state.get("marginSummary", {}).get("accountValue") or
                state.get("crossMarginSummary", {}).get("accountValue") or
                "0"
            ))
        if require_funds and account_value < quote_size:
            fail("hyperliquid account has insufficient available value", "venue_rejected")
        return True
    except SystemExit:
        raise
    except Exception:
        fail("hyperliquid account state unavailable", "venue_rejected")


def enforce_minimum_notional(order, notional):
    if not order.get("reduce_only") and notional < MIN_PERP_NOTIONAL:
        fail(
            "hyperliquid order is below the venue's $10 minimum after lot-size rounding",
            "order_below_venue_minimum",
            "not_submitted",
        )


def spot_usdc_available(spot_state):
    for item in spot_state.get("tokenToAvailableAfterMaintenance", []):
        if isinstance(item, list) and len(item) >= 2 and int(item[0]) == 0:
            return Decimal(str(item[1]))
    for balance in spot_state.get("balances", []):
        if balance.get("coin") == "USDC" or int(balance.get("token", -1)) == 0:
            return max(
                Decimal("0"),
                Decimal(str(balance.get("total") or "0")) - Decimal(str(balance.get("hold") or "0")),
            )
    return Decimal("0")


def coin_size_decimals(info, coin):
    try:
        meta = info.meta()
        for asset in meta.get("universe", []):
            if asset.get("name") == coin:
                return int(asset.get("szDecimals", 6))
    except Exception:
        return 6
    return 6


def floor_decimal(value, decimals):
    decimals = max(0, min(int(decimals), 12))
    quantum = Decimal("1").scaleb(-decimals)
    with localcontext() as ctx:
        ctx.prec = 40
        return value.quantize(quantum, rounding=ROUND_DOWN)


def price_to_5_sig(value):
    with localcontext() as ctx:
        ctx.prec = 40
        exponent = value.adjusted() - 4
        quantum = Decimal("1").scaleb(exponent)
        return value.quantize(quantum, rounding=ROUND_DOWN)


def decimal_text(value):
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def redact_result(status, result):
    oid = None
    try:
        statuses = result.get("response", {}).get("data", {}).get("statuses", [])
        if statuses:
            first = statuses[0]
            if status == "cancelled" and first == "success":
                return {"status": "cancelled", "oid": None}
            if not isinstance(first, dict):
                return {"status": "outcome_unknown", "oid": None}
            if first.get("error"):
                error_text = str(first.get("error") or "").lower()
                error_code = "order_below_venue_minimum" if "minimum value" in error_text else "venue_rejected"
                return {"status": "rejected", "oid": None, "error_code": error_code}
            resting = first.get("resting") or {}
            filled = first.get("filled") or {}
            oid = resting.get("oid") or filled.get("oid")
            if oid is not None:
                return {"status": status, "oid": oid}
    except Exception:
        oid = None
    return {"status": "outcome_unknown", "oid": None}


def redact_fill(fill):
    return {
        "coin": fill.get("coin"),
        "px": fill.get("px"),
        "sz": fill.get("sz"),
        "fee": fill.get("fee"),
        "time": fill.get("time"),
    }


if __name__ == "__main__":
    main()
