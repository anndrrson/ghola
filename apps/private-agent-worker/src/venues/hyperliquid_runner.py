#!/usr/bin/env python3
import json
import hashlib
import sys
import time
from decimal import Decimal, ROUND_DOWN, InvalidOperation, localcontext


def fail(message, error_code="connector_submit_failed"):
    print(json.dumps({"status": "failed", "error": message, "error_code": error_code}))
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
            assert_leverage_supported(info, order)
            assert_protective_prices(info, order)
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
            resolved = resolve_limit_order(
                info,
                order,
                account_address,
                require_funds=not bool(order.get("reduce_only")),
            )
            assert_leverage_supported(info, order)
            assert_protective_prices(info, order)
            requests = [build_entry_request(order, resolved, Cloid.from_str(cloid))]
            protection = order.get("protective_orders") or {}
            if protection.get("take_profit"):
                requests.append(build_trigger_request(
                    order,
                    resolved,
                    protection["take_profit"],
                    "tp",
                    derived_cloid(cloid, "tp", Cloid),
                ))
            if protection.get("stop_loss"):
                requests.append(build_trigger_request(
                    order,
                    resolved,
                    protection["stop_loss"],
                    "sl",
                    derived_cloid(cloid, "sl", Cloid),
                ))
            result = exchange.bulk_orders(
                requests,
                grouping="normalTpsl" if len(requests) > 1 else "na",
            )
            assert_order_statuses_ok(
                result,
                len(requests),
                exchange=exchange,
                order=order,
                resolved=resolved,
                entry_cloid=Cloid.from_str(cloid),
                cloid_type=Cloid,
            )
            print(json.dumps(redact_result("submitted", result, bracket_count=len(requests) - 1)))
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
        fail("hyperliquid request failed", "venue_rejected")

    fail("unsupported hyperliquid operation")


def build_entry_request(order, resolved, cloid):
    return {
        "coin": order["market"],
        "is_buy": order["side"] == "buy",
        "sz": float(resolved["base_size"]),
        "limit_px": float(resolved["limit_price"]),
        "order_type": {"limit": {"tif": resolved["tif"]}},
        "reduce_only": bool(order.get("reduce_only")),
        "cloid": cloid,
    }


def build_trigger_request(order, resolved, trigger_px, tpsl, cloid):
    trigger = Decimal(str(trigger_px))
    if trigger <= 0:
        fail("invalid hyperliquid trigger price", "venue_rejected")
    return {
        "coin": order["market"],
        "is_buy": order["side"] != "buy",
        "sz": float(resolved["base_size"]),
        "limit_px": float(price_to_5_sig(trigger)),
        "order_type": {
            "trigger": {
                "triggerPx": float(price_to_5_sig(trigger)),
                "isMarket": True,
                "tpsl": tpsl,
            }
        },
        "reduce_only": True,
        "cloid": cloid,
    }


def derived_cloid(parent, suffix, cloid_type):
    digest = hashlib.sha256(f"{parent}:{suffix}".encode("utf-8")).hexdigest()[:32]
    return cloid_type.from_str(f"0x{digest}")


def assert_action_ok(result, message):
    if not isinstance(result, dict) or result.get("status") != "ok":
        fail(message, "venue_rejected")


def assert_order_statuses_ok(result, expected, exchange=None, order=None, resolved=None, entry_cloid=None, cloid_type=None):
    assert_action_ok(result, "hyperliquid order batch failed")
    statuses = result.get("response", {}).get("data", {}).get("statuses", [])
    if len(statuses) != expected:
        if statuses:
            compensate_failed_bracket(exchange, order, resolved, statuses[0], entry_cloid, cloid_type)
        fail("hyperliquid order acknowledgement was incomplete", "venue_rejected")
    errors = [item.get("error") for item in statuses if isinstance(item, dict) and item.get("error")]
    if errors:
        compensate_failed_bracket(exchange, order, resolved, statuses[0], entry_cloid, cloid_type)
        fail(str(errors[0]), "venue_rejected")


def compensate_failed_bracket(exchange, order, resolved, entry_status, entry_cloid, cloid_type):
    if not exchange or not order or not resolved or not isinstance(entry_status, dict):
        return
    try:
        if entry_status.get("resting"):
            exchange.cancel_by_cloid(order["market"], entry_cloid)
            return
        if entry_status.get("filled"):
            exchange.market_close(
                order["market"],
                sz=float(resolved["base_size"]),
                slippage=0.01,
                cloid=derived_cloid(str(entry_cloid), "emergency-close", cloid_type),
            )
    except Exception:
        # The caller fails closed and reconciliation will surface an unprotected
        # position instead of claiming the bracket succeeded.
        return


def assert_leverage_supported(info, order):
    requested = int(order.get("leverage") or 1)
    try:
        for asset in info.meta().get("universe", []):
            if asset.get("name") == order.get("market"):
                maximum = int(asset.get("maxLeverage") or 1)
                if requested > maximum:
                    fail("requested leverage exceeds the market maximum", "venue_rejected")
                return
    except SystemExit:
        raise
    except Exception:
        fail("hyperliquid market metadata unavailable", "connector_submit_failed")
    fail("hyperliquid market is unavailable", "venue_rejected")


def assert_protective_prices(info, order):
    protection = order.get("protective_orders") or {}
    if not protection:
        return
    try:
        reference = Decimal(str(info.all_mids()[order.get("market")]))
        stop = Decimal(str(protection["stop_loss"])) if protection.get("stop_loss") else None
        take = Decimal(str(protection["take_profit"])) if protection.get("take_profit") else None
    except Exception:
        fail("hyperliquid trigger reference is unavailable", "connector_submit_failed")
    is_buy = order.get("side") == "buy"
    if stop is not None and ((is_buy and stop >= reference) or (not is_buy and stop <= reference)):
        fail("invalid stop-loss price for current mark", "venue_rejected")
    if take is not None and ((is_buy and take <= reference) or (not is_buy and take >= reference)):
        fail("invalid take-profit price for current mark", "venue_rejected")


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
        if notional > 0:
            check_account_value(
                info,
                account_address,
                notional,
                leverage=order.get("leverage") or 1,
                require_funds=require_funds,
            )
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

    account_state_checked = check_account_value(
        info,
        account_address,
        quote_size,
        leverage=order.get("leverage") or 1,
        require_funds=require_funds,
    )
    slippage = slippage_bps / Decimal("10000")
    limit = mid * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid tiny fill limit", "venue_rejected")

    price = price_to_5_sig(limit)
    base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid tiny fill size is below venue minimum", "venue_rejected")
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
    account_state_checked = check_account_value(
        info,
        account_address,
        notional,
        leverage=order.get("leverage") or 1,
        require_funds=require_funds,
    )
    slippage = slippage_bps / Decimal("10000")
    limit = mid * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid market order limit", "venue_rejected")
    price = price_to_5_sig(limit)
    if base_size <= 0:
        base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid market order size is below venue minimum", "venue_rejected")
    return {
        "base_size": decimal_text(base_size),
        "limit_price": decimal_text(price),
        "tif": "Ioc",
        "account_state_checked": account_state_checked,
    }


def check_account_value(info, account_address, quote_size, leverage=1, require_funds=True):
    try:
        state = info.user_state(account_address)
        account_value = Decimal(str(
            state.get("marginSummary", {}).get("accountValue") or
            state.get("crossMarginSummary", {}).get("accountValue") or
            "0"
        ))
        available = Decimal(str(state.get("withdrawable") or account_value))
        try:
            if info.query_user_abstraction_state(account_address) == "unifiedAccount":
                spot_state = info.spot_user_state(account_address)
                usdc = next(
                    (item for item in spot_state.get("balances", []) if item.get("coin") == "USDC"),
                    None,
                )
                if usdc:
                    unified_available = Decimal(str(usdc.get("total") or "0")) - Decimal(str(usdc.get("hold") or "0"))
                    available = max(available, unified_available)
        except Exception:
            # Legacy/standard accounts remain valid when abstraction metadata is
            # temporarily unavailable; their perp withdrawable value is authoritative.
            pass
        leverage_value = Decimal(str(leverage or 1))
        if leverage_value <= 0:
            fail("invalid hyperliquid leverage", "venue_rejected")
        required_margin = (quote_size / leverage_value) * Decimal("1.01")
        if require_funds and available < required_margin:
            fail("hyperliquid account has insufficient available value", "venue_rejected")
        return True
    except SystemExit:
        raise
    except Exception:
        fail("hyperliquid account state unavailable", "venue_rejected")


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


def redact_result(status, result, bracket_count=0):
    oid = None
    try:
        statuses = result.get("response", {}).get("data", {}).get("statuses", [])
        if statuses:
            resting = statuses[0].get("resting") or {}
            filled = statuses[0].get("filled") or {}
            oid = resting.get("oid") or filled.get("oid")
    except Exception:
        oid = None
    return {"status": status, "oid": oid, "bracket_count": bracket_count}


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
