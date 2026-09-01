#!/usr/bin/env python3
import json
import hashlib
import sys
import time
from decimal import Decimal, ROUND_DOWN, InvalidOperation, localcontext


def fail(message, error_code="pre_submit_failed"):
    print(json.dumps({"status": "failed", "error": message, "error_code": error_code}))
    sys.exit(1)


def request_failure_code(broadcast_started):
    return "submission_ambiguous" if broadcast_started else "pre_submit_failed"


def main():
    broadcast_started = False
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
                fail("unsupported hyperliquid no-submit operation", "pre_submit_failed")
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
            expected_cloids = [cloid.lower()]
            protection = order.get("protective_orders") or {}
            if protection.get("take_profit"):
                take_profit_cloid = derived_cloid(cloid, "tp")
                requests.append(build_trigger_request(
                    order,
                    resolved,
                    protection["take_profit"],
                    "tp",
                    Cloid.from_str(take_profit_cloid),
                ))
                expected_cloids.append(take_profit_cloid)
            if protection.get("stop_loss"):
                stop_loss_cloid = derived_cloid(cloid, "sl")
                requests.append(build_trigger_request(
                    order,
                    resolved,
                    protection["stop_loss"],
                    "sl",
                    Cloid.from_str(stop_loss_cloid),
                ))
                expected_cloids.append(stop_loss_cloid)
            broadcast_started = True
            result = exchange.bulk_orders(
                requests,
                grouping="normalTpsl" if len(requests) > 1 else "na",
            )
            assert_order_statuses_ok(result, expected_cloids)
            print(json.dumps(redact_result("submitted", result, bracket_count=len(requests) - 1)))
            return
        if op == "cancel":
            cancel = instruction["cancel"]
            broadcast_started = True
            if cancel.get("client_order_id"):
                result = exchange.cancel_by_cloid(cancel["market"], Cloid.from_str(cancel["client_order_id"]))
            else:
                result = exchange.cancel(cancel["market"], int(cancel["order_id"]))
            assert_cancel_statuses_ok(result, 1)
            print(json.dumps(redact_result("cancelled", result)))
            return
        if op in ("read", "reconcile"):
            info = Info(base_url, skip_ws=True)
            fills = info.user_fills_by_time(account_address, int((time.time() - 86400) * 1000))
            if not isinstance(fills, list) or len(fills) > 32000:
                fail("hyperliquid fill history exceeds the bounded evidence window", "connector_submit_failed")
            print(json.dumps({
                "status": "reconciled",
                "fills": [redact_fill(fill) for fill in fills],
            }))
            return
    except Exception:
        error_code = request_failure_code(broadcast_started)
        message = (
            "hyperliquid submission outcome is ambiguous"
            if broadcast_started
            else "hyperliquid request failed before submission"
        )
        fail(message, error_code)

    fail("unsupported hyperliquid operation", "pre_submit_failed")


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
        fail("invalid hyperliquid trigger price", "pre_submit_failed")
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


def derived_cloid(parent, suffix):
    digest = hashlib.sha256(f"{parent}:{suffix}".encode("utf-8")).hexdigest()[:32]
    return f"0x{digest}"


def assert_action_ok(result, message):
    if not isinstance(result, dict) or result.get("status") != "ok":
        fail(message, "submission_ambiguous")


def assert_order_statuses_ok(result, expected_cloids):
    statuses = response_statuses(result, len(expected_cloids), "order")
    if not all(
        explicit_order_acknowledgement(item, expected_cloids[index])
        for index, item in enumerate(statuses)
    ):
        fail("hyperliquid order acknowledgement was incomplete", "submission_ambiguous")


def assert_cancel_statuses_ok(result, expected):
    statuses = response_statuses(result, expected, "cancel")
    if not all(item == "success" for item in statuses):
        fail("hyperliquid cancel acknowledgement was incomplete", "submission_ambiguous")


def response_statuses(result, expected, action):
    assert_action_ok(result, f"hyperliquid {action} failed")
    response = result.get("response")
    if not isinstance(response, dict):
        fail(f"hyperliquid {action} acknowledgement was incomplete", "submission_ambiguous")
    data = response.get("data") if isinstance(response, dict) else None
    statuses = data.get("statuses") if isinstance(data, dict) else None
    if response.get("type") != action or not isinstance(statuses, list) or len(statuses) != expected:
        fail(f"hyperliquid {action} acknowledgement was incomplete", "submission_ambiguous")
    return statuses


def explicit_order_acknowledgement(item, expected_cloid):
    if not isinstance(item, dict):
        return False
    resting = item.get("resting")
    if set(item) == {"resting"} and valid_resting_acknowledgement(resting, expected_cloid):
        return True
    filled = item.get("filled")
    return (
        set(item) == {"filled"}
        and valid_filled_acknowledgement(filled, expected_cloid)
    )


def valid_resting_acknowledgement(value, expected_cloid):
    return (
        isinstance(value, dict)
        and set(value).issubset({"oid", "cloid"})
        and nonnegative_integer(value.get("oid"))
        and ("cloid" not in value or matching_cloid(value["cloid"], expected_cloid))
    )


def valid_filled_acknowledgement(value, expected_cloid):
    return (
        isinstance(value, dict)
        and set(value).issubset({"oid", "cloid", "totalSz", "avgPx"})
        and {"oid", "totalSz", "avgPx"}.issubset(value)
        and nonnegative_integer(value.get("oid"))
        and positive_decimal(value.get("totalSz"))
        and positive_decimal(value.get("avgPx"))
        and ("cloid" not in value or matching_cloid(value["cloid"], expected_cloid))
    )


def matching_cloid(value, expected):
    if not isinstance(value, str) or len(value) != 34 or not value.startswith("0x"):
        return False
    return (
        all(character in "0123456789abcdefABCDEF" for character in value[2:])
        and value.lower() == expected.lower()
    )


def nonnegative_integer(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 9_007_199_254_740_991
    )


def positive_decimal(value):
    if not isinstance(value, str) or not value or len(value) > 64:
        return False
    whole, separator, fraction = value.partition(".")
    if not whole.isdigit() or (separator and not fraction.isdigit()):
        return False
    try:
        return Decimal(value).is_finite() and Decimal(value) > 0
    except InvalidOperation:
        return False


def assert_leverage_supported(info, order):
    requested = int(order.get("leverage") or 1)
    try:
        for asset in info.meta().get("universe", []):
            if asset.get("name") == order.get("market"):
                maximum = int(asset.get("maxLeverage") or 1)
                if requested > maximum:
                    fail("requested leverage exceeds the market maximum", "pre_submit_failed")
                return
    except SystemExit:
        raise
    except Exception:
        fail("hyperliquid market metadata unavailable", "pre_submit_failed")
    fail("hyperliquid market is unavailable", "pre_submit_failed")


def assert_protective_prices(info, order):
    protection = order.get("protective_orders") or {}
    if not protection:
        return
    try:
        reference = Decimal(str(info.all_mids()[order.get("market")]))
        stop = Decimal(str(protection["stop_loss"])) if protection.get("stop_loss") else None
        take = Decimal(str(protection["take_profit"])) if protection.get("take_profit") else None
    except Exception:
        fail("hyperliquid trigger reference is unavailable", "pre_submit_failed")
    is_buy = order.get("side") == "buy"
    if stop is not None and ((is_buy and stop >= reference) or (not is_buy and stop <= reference)):
        fail("invalid stop-loss price for current mark", "pre_submit_failed")
    if take is not None and ((is_buy and take <= reference) or (not is_buy and take >= reference)):
        fail("invalid take-profit price for current mark", "pre_submit_failed")


def resolve_limit_order(info, order, account_address, require_funds=True):
    if order.get("order_type") == "market":
        return resolve_market_ioc_order(info, order, account_address, require_funds=require_funds)

    if order.get("live_order_mode") != "tiny_fill":
        try:
            price = Decimal(str(order.get("limit_price") or "0"))
            base = Decimal(str(order.get("base_size") or "0"))
            quote = Decimal(str(order.get("quote_size") or "0"))
        except (InvalidOperation, ValueError):
            fail("invalid hyperliquid limit order", "pre_submit_failed")
        if price <= 0:
            fail("invalid hyperliquid limit price", "pre_submit_failed")
        if base <= 0 and quote > 0:
            base = floor_decimal(quote / price, coin_size_decimals(info, order.get("market")))
        if base <= 0:
            fail("hyperliquid limit order size is below venue minimum", "pre_submit_failed")
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
        fail("invalid hyperliquid tiny fill order", "pre_submit_failed")
    if quote_size <= 0 or slippage_bps <= 0:
        fail("invalid hyperliquid tiny fill order", "pre_submit_failed")

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
        fail("invalid hyperliquid tiny fill limit", "pre_submit_failed")

    price = price_to_5_sig(limit)
    base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid tiny fill size is below venue minimum", "pre_submit_failed")
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
        fail("invalid hyperliquid market order", "pre_submit_failed")
    if slippage_bps <= 0:
        fail("invalid hyperliquid market order", "pre_submit_failed")
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
        fail("invalid hyperliquid market order size", "pre_submit_failed")
    if quote_size <= 0 and base_size <= 0:
        fail("invalid hyperliquid market order size", "pre_submit_failed")

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
        fail("invalid hyperliquid market order limit", "pre_submit_failed")
    price = price_to_5_sig(limit)
    if base_size <= 0:
        base_size = floor_decimal(quote_size / price, coin_size_decimals(info, coin))
    if base_size <= 0:
        fail("hyperliquid market order size is below venue minimum", "pre_submit_failed")
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
            fail("invalid hyperliquid leverage", "pre_submit_failed")
        required_margin = (quote_size / leverage_value) * Decimal("1.01")
        if require_funds and available < required_margin:
            fail("hyperliquid account has insufficient available value", "pre_submit_failed")
        return True
    except SystemExit:
        raise
    except Exception:
        fail("hyperliquid account state unavailable", "pre_submit_failed")


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
