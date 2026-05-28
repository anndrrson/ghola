#!/usr/bin/env python3
import json
import sys
import time
from decimal import Decimal, ROUND_DOWN, InvalidOperation, localcontext


def fail(message):
    print(json.dumps({"status": "failed", "error": message}))
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
    wallet = Account.from_key(credential["api_wallet_private_key"])
    account_address = credential["account_address"].lower()
    exchange = Exchange(wallet, base_url=base_url, account_address=account_address)
    op = instruction.get("operation_class")

    try:
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
            print(json.dumps(redact_result("submitted", result)))
            return
        if op == "cancel":
            cancel = instruction["cancel"]
            if cancel.get("client_order_id"):
                result = exchange.cancel_by_cloid(cancel["market"], Cloid.from_str(cancel["client_order_id"]))
            else:
                result = exchange.cancel(cancel["market"], int(cancel["order_id"]))
            print(json.dumps(redact_result("cancelled", result)))
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
        fail("hyperliquid request failed")

    fail("unsupported hyperliquid operation")


def resolve_limit_order(info, order, account_address):
    if order.get("live_order_mode") != "tiny_fill":
        return {
            "base_size": order.get("base_size") or "0",
            "limit_price": order.get("limit_price"),
            "tif": order.get("tif") or "Gtc",
        }

    coin = order.get("market")
    try:
        quote_size = Decimal(str(order.get("quote_size") or "0"))
        slippage_bps = Decimal(str(order.get("max_slippage_bps") or "50"))
    except (InvalidOperation, ValueError):
        fail("invalid hyperliquid tiny fill order")
    if quote_size <= 0 or slippage_bps <= 0:
        fail("invalid hyperliquid tiny fill order")

    try:
        mids = info.all_mids()
        mid = Decimal(str(mids[coin]))
    except Exception:
        fail("hyperliquid market data unavailable")
    if mid <= 0:
        fail("hyperliquid market data unavailable")

    check_account_value(info, account_address, quote_size)
    slippage = slippage_bps / Decimal("10000")
    limit = mid * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid tiny fill limit")

    price = price_to_5_sig(limit)
    base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid tiny fill size is below venue minimum")
    return {
        "base_size": decimal_text(base_size),
        "limit_price": decimal_text(price),
        "tif": "Ioc",
    }


def check_account_value(info, account_address, quote_size):
    try:
        state = info.user_state(account_address)
        account_value = Decimal(str(
            state.get("marginSummary", {}).get("accountValue") or
            state.get("crossMarginSummary", {}).get("accountValue") or
            "0"
        ))
        if account_value > 0 and account_value < quote_size:
            fail("hyperliquid account has insufficient available value")
    except SystemExit:
        raise
    except Exception:
        return


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
            resting = statuses[0].get("resting") or {}
            filled = statuses[0].get("filled") or {}
            oid = resting.get("oid") or filled.get("oid")
    except Exception:
        oid = None
    return {"status": status, "oid": oid}


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
