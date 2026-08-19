#!/usr/bin/env python3
import json
import hashlib
import re
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP, InvalidOperation, localcontext


EXECUTION_BOOK_MAX_AGE_MS = 2000
EXECUTION_EXPIRY_MAX_TTL_MS = 5 * 60 * 1000
API_WALLET_MIN_VALIDITY_MS = 5 * 60 * 1000
MIN_ORDER_NOTIONAL_USD = Decimal("10")
MIN_OPENING_REFERENCE_NOTIONAL_USD = Decimal("10.05")


def fail(message, error_code="connector_submit_failed"):
    print(json.dumps({"status": "failed", "error": message, "error_code": error_code}))
    sys.exit(1)


def verify_api_wallet_authorization(info, account_address, wallet_address):
    account = str(account_address or "").lower()
    agent = str(wallet_address or "").lower()
    if not re.fullmatch(r"0x[0-9a-f]{40}", account) or not re.fullmatch(r"0x[0-9a-f]{40}", agent):
        fail("hyperliquid API wallet identity is invalid", "venue_access_required")
    if account == agent:
        fail(
            "hyperliquid master-wallet signing is forbidden; use an approved trade-only API wallet",
            "venue_access_required",
        )
    try:
        if hasattr(info, "extra_agents"):
            agents = info.extra_agents(account)
        else:
            agents = info.post("/info", {"type": "extraAgents", "user": account})
    except Exception:
        fail("hyperliquid API wallet authorization could not be verified", "venue_access_required")
    if not isinstance(agents, list):
        fail("hyperliquid API wallet authorization response is invalid", "venue_access_required")
    now_ms = int(time.time() * 1000)
    for row in agents:
        if not isinstance(row, dict) or str(row.get("address") or "").lower() != agent:
            continue
        try:
            valid_until_ms = int(row.get("validUntil"))
        except (TypeError, ValueError):
            continue
        if valid_until_ms > now_ms + API_WALLET_MIN_VALIDITY_MS:
            return {"authorized": True, "valid_until_ms": valid_until_ms}
    fail(
        "hyperliquid API wallet is not approved, has expired, or expires too soon",
        "venue_access_required",
    )


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
        vault_address = (credential.get("vault_address") or credential.get("vaultAddress") or "").lower() or None
        execution_address = vault_address or account_address
    except Exception:
        fail("hyperliquid credentials are invalid", "venue_access_required")
    try:
        exchange = (
            Exchange(wallet, base_url=base_url, account_address=account_address, vault_address=vault_address)
            if vault_address
            else Exchange(wallet, base_url=base_url, account_address=account_address)
        )
    except TypeError:
        exchange = Exchange(wallet, base_url=base_url, account_address=account_address)
        if vault_address:
            setattr(exchange, "vault_address", vault_address)
    op = instruction.get("operation_class")

    try:
        info = Info(base_url, skip_ws=True)
        api_wallet = verify_api_wallet_authorization(info, account_address, wallet.address)
        if payload.get("verify_no_submit"):
            if op != "limit_order":
                fail("unsupported hyperliquid no-submit operation", "venue_rejected")
            order = instruction["order"]
            expires_after_ms = configure_action_expiry(exchange, instruction)
            resolved = resolve_limit_order(info, order, execution_address)
            market_gate = verify_fresh_execution_book(info, order, resolved, execution_address)
            Cloid.from_str(cloid)
            protection_checked = False
            if instruction.get("position_protection"):
                protected_limit_order_plan(
                    order,
                    resolved,
                    instruction["position_protection"],
                    cloid,
                    Cloid,
                )
                protection_checked = True
            print(json.dumps({
                "status": "verified_no_funds",
                "sdk_checked": True,
                "api_wallet_loaded": True,
                "api_wallet_authorized": api_wallet["authorized"],
                "api_wallet_not_expired": api_wallet["valid_until_ms"] > int(time.time() * 1000),
                "api_wallet_address": wallet.address.lower(),
                "api_wallet_valid_until_ms": api_wallet["valid_until_ms"],
                "market_data_checked": True,
                "account_state_checked": bool(resolved.get("account_state_checked")),
                "order_request_checked": True,
                "position_protection_checked": protection_checked,
                "action_expiry_checked": expires_after_ms > int(time.time() * 1000),
                "expires_after_ms": expires_after_ms,
                "market_freshness_checked": market_gate.get("freshness_proven") is True,
                "transaction_broadcast": False,
            }))
            return
        if op == "limit_order":
            order = instruction["order"]
            expires_after_ms = configure_action_expiry(exchange, instruction)
            resolved, execution_configuration, market_gate = prepare_live_limit_order(
                info,
                exchange,
                order,
                execution_address,
            )
            protection = instruction.get("position_protection")
            if protection:
                redacted = submit_protected_limit_order(
                    exchange,
                    info,
                    execution_address,
                    order,
                    resolved,
                    protection,
                    cloid,
                    Cloid,
                )
            else:
                result = exchange.order(
                    order["market"],
                    order["side"] == "buy",
                    float(resolved["base_size"]),
                    float(resolved["limit_price"]),
                    {"limit": {"tif": resolved["tif"]}},
                    reduce_only=bool(order.get("reduce_only")),
                    cloid=Cloid.from_str(cloid),
                )
                redacted = redact_result("submitted", result, order.get("market"))
                if redacted.get("status") == "filled":
                    fills = redacted.get("fills") or []
                    if len(fills) != 1 or Decimal(str(fills[0].get("sz") or "0")) != Decimal(resolved["base_size"]):
                        fail("hyperliquid IOC order only partially filled", "venue_rejected")
                redacted["venue_order_readback"] = accepted_parent_order_status(
                    info,
                    execution_address,
                    order,
                    resolved,
                    cloid,
                    redacted,
                )
            redacted["execution_configuration"] = execution_configuration
            redacted["execution_market_gate"] = market_gate
            redacted["expires_after_ms"] = expires_after_ms
            redacted["action_expiry_enforced"] = True
            print(json.dumps(redacted))
            return
        if op == "cancel":
            cancel = instruction["cancel"]
            expires_after_ms = configure_action_expiry(exchange, instruction)
            if cancel.get("client_order_id"):
                redacted = cancel_by_cloid_with_readback(
                    exchange,
                    info,
                    execution_address,
                    cancel["market"],
                    cancel["client_order_id"],
                    Cloid,
                )
            else:
                redacted = cancel_by_oid_with_readback(
                    exchange,
                    info,
                    execution_address,
                    cancel["market"],
                    int(cancel["order_id"]),
                )
            redacted["expires_after_ms"] = expires_after_ms
            redacted["action_expiry_enforced"] = True
            print(json.dumps(redacted))
            return
        if op in ("read", "reconcile"):
            fills = info.user_fills_by_time(execution_address, int((time.time() - 86400) * 1000))
            print(json.dumps({
                "status": "reconciled",
                "fills": [redact_fill(fill) for fill in fills[:25]],
            }))
            return
    except Exception as error:
        fail(hyperliquid_error_message(error), "venue_rejected")

    fail("unsupported hyperliquid operation")


def prepare_live_limit_order(info, exchange, order, execution_address):
    resolved = resolve_limit_order(info, order, execution_address)
    # Leverage is a signed venue mutation and can block. Complete it before the
    # final market proof so no network mutation can age the proven BBO/mark.
    execution_configuration = configure_isolated_leverage(exchange, order)
    market_gate = verify_fresh_execution_book(info, order, resolved, execution_address)
    return resolved, execution_configuration, market_gate


def resolve_limit_order(info, order, account_address):
    if order.get("order_type") == "market":
        return resolve_market_ioc_order(info, order, account_address)

    if order.get("live_order_mode") != "tiny_fill":
        try:
            price = Decimal(str(order.get("limit_price") or "0"))
            base = Decimal(str(order.get("base_size") or "0"))
            quote = Decimal(str(order.get("quote_size") or "0"))
        except (InvalidOperation, ValueError):
            fail("invalid hyperliquid limit order", "venue_rejected")
        if price <= 0:
            fail("invalid hyperliquid limit price", "venue_rejected")
        size_decimals = coin_size_decimals(info, order.get("market"))
        if not hyperliquid_perp_price_valid(price, size_decimals):
            fail("hyperliquid limit price violates venue tick precision", "venue_rejected")
        if base <= 0 and quote > 0:
            base = floor_decimal(quote / price, size_decimals)
        if base <= 0:
            fail("hyperliquid limit order size is below venue minimum", "venue_rejected")
        if base != floor_decimal(base, size_decimals):
            fail("hyperliquid limit order size violates venue lot precision", "venue_rejected")
        notional = base * price
        reduce_only = bool(order.get("reduce_only"))
        if not reduce_only and notional < MIN_ORDER_NOTIONAL_USD:
            fail("hyperliquid opening order is below the venue minimum notional", "venue_rejected")
        account_state_checked = True if reduce_only else check_account_value(
            info,
            account_address,
            notional,
            order.get("market"),
            order.get("side"),
            base,
        )
        return {
            "base_size": decimal_text(base),
            "limit_price": decimal_text(price),
            "tif": order.get("tif") or "Gtc",
            "size_decimals": size_decimals,
            "account_state_checked": account_state_checked,
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

    slippage = slippage_bps / Decimal("10000")
    limit = mid * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid tiny fill limit", "venue_rejected")

    size_decimals = coin_size_decimals(info, coin)
    price = quantize_hyperliquid_perp_price(limit, size_decimals, ROUND_DOWN if order.get("side") == "buy" else ROUND_UP)
    base_size = floor_decimal(quote_size / price, size_decimals)
    if base_size <= 0:
        fail("hyperliquid tiny fill size is below venue minimum", "venue_rejected")
    account_state_checked = check_account_value(
        info,
        account_address,
        quote_size,
        coin,
        order.get("side"),
        base_size,
    )
    return {
        "base_size": decimal_text(base_size),
        "limit_price": decimal_text(price),
        "tif": "Ioc",
        "account_state_checked": account_state_checked,
        "size_decimals": size_decimals,
    }


def configure_action_expiry(exchange, instruction):
    raw = instruction.get("expires_at")
    if not isinstance(raw, str) or not raw.strip():
        fail("hyperliquid execution expiry is required", "venue_rejected")
    try:
        expires_at = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        expires_after_ms = int(expires_at.timestamp() * 1000)
    except (TypeError, ValueError, OverflowError):
        fail("hyperliquid execution expiry is invalid", "venue_rejected")
    now_ms = int(time.time() * 1000)
    remaining_ms = expires_after_ms - now_ms
    if remaining_ms <= 0:
        fail("hyperliquid execution instruction expired", "venue_rejected")
    if remaining_ms > EXECUTION_EXPIRY_MAX_TTL_MS:
        fail("hyperliquid execution expiry exceeds the maximum TTL", "venue_rejected")
    setter = getattr(exchange, "set_expires_after", None)
    if not callable(setter):
        fail("hyperliquid SDK cannot enforce action expiry")
    setter(expires_after_ms)
    return expires_after_ms


def submit_protected_limit_order(exchange, info, execution_address, order, resolved, protection, cloid, cloid_type):
    plan = protected_limit_order_plan(order, resolved, protection, cloid, cloid_type)
    orders = plan["orders"]
    take_profit_cloid = plan["take_profit_cloid"]
    stop_loss_cloid = plan["stop_loss_cloid"]
    slippage_bps = plan["slippage_bps"]
    base_size = plan["base_size"]
    result = exchange.bulk_orders(orders, grouping="normalTpsl")
    redacted = redact_result("submitted", result, order.get("market"))
    if redacted.get("status") != "filled" or len(redacted.get("fills", [])) != 1:
        fail("hyperliquid protected IOC entry did not fill atomically", "position_protection_unconfirmed")
    if Decimal(redacted["fills"][0]["sz"]) != base_size:
        fail("hyperliquid protected IOC entry only partially filled", "position_protection_unconfirmed")
    redacted["venue_order_readback"] = accepted_parent_order_status(
        info,
        execution_address,
        order,
        resolved,
        cloid,
        redacted,
    )
    statuses = result.get("response", {}).get("data", {}).get("statuses", [])
    if len(statuses) != 3:
        fail("hyperliquid protection response is incomplete", "position_protection_unconfirmed")
    take_profit_oid = accepted_protection_status(
        statuses[1], info, execution_address, order["market"], take_profit_cloid
    )
    stop_loss_oid = accepted_protection_status(
        statuses[2], info, execution_address, order["market"], stop_loss_cloid
    )
    redacted["position_protection"] = {
        "venue_accepted": True,
        "grouping": "normalTpsl",
        "trigger_source": "mark",
        "trigger_order_type": "bounded_limit",
        "take_profit_oid": take_profit_oid,
        "stop_loss_oid": stop_loss_oid,
        "take_profit_cloid": take_profit_cloid,
        "stop_loss_cloid": stop_loss_cloid,
        "max_slippage_bps": int(slippage_bps),
    }
    return redacted


def protected_limit_order_plan(order, resolved, protection, cloid, cloid_type):
    if order.get("reduce_only") or resolved.get("tif") != "Ioc":
        fail("hyperliquid position protection requires a non-reduce-only IOC entry", "venue_rejected")
    try:
        entry_price = Decimal(str(resolved.get("limit_price")))
        base_size = Decimal(str(resolved.get("base_size")))
        take_profit = Decimal(str(protection.get("take_profit_trigger_price")))
        stop_loss = Decimal(str(protection.get("stop_loss_trigger_price")))
        slippage_bps = Decimal(str(protection.get("max_slippage_bps")))
        size_decimals = int(resolved.get("size_decimals"))
    except (InvalidOperation, TypeError, ValueError):
        fail("hyperliquid position protection is invalid", "venue_rejected")
    is_buy = order.get("side") == "buy"
    if (
        protection.get("mode") != "normal_tpsl" or
        protection.get("trigger_source") != "mark" or
        entry_price <= 0 or base_size <= 0 or slippage_bps <= 0 or slippage_bps > 100 or
        (is_buy and not (stop_loss < entry_price < take_profit)) or
        (not is_buy and not (take_profit < entry_price < stop_loss))
    ):
        fail("hyperliquid position protection is outside the entry bounds", "venue_rejected")
    if not hyperliquid_perp_price_valid(take_profit, size_decimals) or not hyperliquid_perp_price_valid(stop_loss, size_decimals):
        fail("hyperliquid position protection violates venue tick precision", "venue_rejected")

    exit_is_buy = not is_buy
    take_profit_limit = bounded_trigger_limit(take_profit, exit_is_buy, slippage_bps, size_decimals)
    stop_loss_limit = bounded_trigger_limit(stop_loss, exit_is_buy, slippage_bps, size_decimals)
    take_profit_cloid = derived_cloid(cloid, "take_profit")
    stop_loss_cloid = derived_cloid(cloid, "stop_loss")
    orders = [
        {
            "coin": order["market"],
            "is_buy": is_buy,
            "sz": float(base_size),
            "limit_px": float(entry_price),
            "order_type": {"limit": {"tif": "Ioc"}},
            "reduce_only": False,
            "cloid": cloid_type.from_str(cloid),
        },
        {
            "coin": order["market"],
            "is_buy": exit_is_buy,
            "sz": float(base_size),
            "limit_px": float(take_profit_limit),
            "order_type": {"trigger": {"triggerPx": float(take_profit), "isMarket": False, "tpsl": "tp"}},
            "reduce_only": True,
            "cloid": cloid_type.from_str(take_profit_cloid),
        },
        {
            "coin": order["market"],
            "is_buy": exit_is_buy,
            "sz": float(base_size),
            "limit_px": float(stop_loss_limit),
            "order_type": {"trigger": {"triggerPx": float(stop_loss), "isMarket": False, "tpsl": "sl"}},
            "reduce_only": True,
            "cloid": cloid_type.from_str(stop_loss_cloid),
        },
    ]
    return {
        "orders": orders,
        "take_profit_cloid": take_profit_cloid,
        "stop_loss_cloid": stop_loss_cloid,
        "slippage_bps": slippage_bps,
        "base_size": base_size,
    }


def accepted_parent_order_status(info, execution_address, order, resolved, cloid, redacted):
    expected_status = "filled" if redacted.get("status") == "filled" else "open"
    expected_oid = redacted.get("oid")
    expected_size = Decimal(str(resolved.get("base_size") or "0"))
    for delay_seconds in (0, 0.05, 0.15, 0.3, 0.5):
        if delay_seconds:
            time.sleep(delay_seconds)
        try:
            response = info.post("/info", {
                "type": "orderStatus",
                "user": execution_address,
                "oid": cloid,
            })
            if response.get("status") == "unknownOid":
                continue
            envelope = response.get("order") or response
            parent = envelope.get("order") or envelope
            parent_status = str(envelope.get("status") or parent.get("status") or "").strip().lower()
            parent_oid = parent.get("oid")
            returned_cloid = str(parent.get("cloid") or "").lower()
            returned_size = Decimal(str(parent.get("origSz") or "0"))
            if (
                parent_status == expected_status and
                str(parent.get("coin") or "").upper() == str(order.get("market") or "").upper() and
                returned_cloid == str(cloid).lower() and
                parent_oid is not None and
                str(parent_oid) == str(expected_oid) and
                returned_size == expected_size and
                bool(parent.get("reduceOnly")) == bool(order.get("reduce_only"))
            ):
                return {
                    "verified": True,
                    "status": parent_status,
                    "oid": parent_oid,
                    "cloid": str(cloid).lower(),
                }
        except (AttributeError, InvalidOperation, TypeError, ValueError):
            continue
    fail("hyperliquid parent order readback is unconfirmed", "venue_rejected")


def accepted_protection_status(status, info, execution_address, market, child_cloid):
    bulk_accepted = (
        isinstance(status, dict) and status.get("resting", {}).get("oid") is not None
    ) or status in ("waitingForFill", "waitingForTrigger")
    if not bulk_accepted:
        fail("hyperliquid did not accept both protection orders", "position_protection_unconfirmed")
    for delay_seconds in (0, 0.05, 0.15, 0.3, 0.5):
        if delay_seconds:
            time.sleep(delay_seconds)
        try:
            response = info.post("/info", {
                "type": "orderStatus",
                "user": execution_address,
                "oid": child_cloid,
            })
            if response.get("status") == "unknownOid":
                continue
            envelope = response.get("order") or response
            child = envelope.get("order") or envelope
            child_status = str(envelope.get("status") or child.get("status") or "").strip().lower()
            child_oid = child.get("oid")
            returned_cloid = str(child.get("cloid") or "").lower()
            if (
                child_status == "open" and
                child.get("reduceOnly") is True and
                child.get("isTrigger") is True and
                str(child.get("coin") or "").upper() == str(market).upper() and
                returned_cloid == str(child_cloid).lower() and
                child_oid is not None
            ):
                return child_oid
        except Exception:
            continue
    fail("hyperliquid did not accept both protection orders", "position_protection_unconfirmed")


def cancel_by_cloid_with_readback(exchange, info, execution_address, market, child_cloid, cloid_type):
    existing = order_status_by_cloid(info, execution_address, child_cloid)
    if existing and terminal_cancel_status(existing["status"]):
        return terminal_cancel_readback(existing, child_cloid, False)
    try:
        result = exchange.cancel_by_cloid(market, cloid_type.from_str(child_cloid))
    except Exception:
        current = order_status_by_cloid(info, execution_address, child_cloid)
        if current and terminal_cancel_status(current["status"]):
            return terminal_cancel_readback(current, child_cloid, False)
        raise
    if not cancel_response_accepted(result):
        current = order_status_by_cloid(info, execution_address, child_cloid)
        if current and terminal_cancel_status(current["status"]):
            return terminal_cancel_readback(current, child_cloid, False)
    redact_result("cancelled", result)
    for delay_seconds in (0, 0.05, 0.15, 0.3, 0.5):
        if delay_seconds:
            time.sleep(delay_seconds)
        current = order_status_by_cloid(info, execution_address, child_cloid)
        if current and terminal_cancel_status(current["status"]):
            return terminal_cancel_readback(current, child_cloid, True)
    fail("hyperliquid cancellation readback is unconfirmed", "venue_rejected")


def cancel_by_oid_with_readback(exchange, info, execution_address, market, oid):
    existing = order_status_by_oid(info, execution_address, oid)
    if existing and terminal_cancel_status(existing["status"]):
        return terminal_cancel_readback(existing, existing.get("cloid"), False)
    try:
        result = exchange.cancel(market, oid)
    except Exception:
        current = order_status_by_oid(info, execution_address, oid)
        if current and terminal_cancel_status(current["status"]):
            return terminal_cancel_readback(current, current.get("cloid"), False)
        raise
    if not cancel_response_accepted(result):
        current = order_status_by_oid(info, execution_address, oid)
        if current and terminal_cancel_status(current["status"]):
            return terminal_cancel_readback(current, current.get("cloid"), False)
    redact_result("cancelled", result)
    for delay_seconds in (0, 0.05, 0.15, 0.3, 0.5):
        if delay_seconds:
            time.sleep(delay_seconds)
        current = order_status_by_oid(info, execution_address, oid)
        if current and terminal_cancel_status(current["status"]):
            return terminal_cancel_readback(current, current.get("cloid"), True)
    fail("hyperliquid cancellation readback is unconfirmed", "venue_rejected")


def terminal_cancel_status(status):
    return status in ("canceled", "cancelled", "reduceonlycanceled")


def cancel_response_accepted(result):
    if not isinstance(result, dict) or result.get("status") != "ok":
        return False
    statuses = result.get("response", {}).get("data", {}).get("statuses", [])
    if not isinstance(statuses, list) or not statuses:
        return False
    first = statuses[0]
    return first == "success" or (isinstance(first, dict) and first.get("success") is not None)


def terminal_cancel_readback(current, child_cloid, broadcast_performed):
    return {
        "status": "cancelled",
        "oid": current["oid"],
        "fills": [],
        "broadcast_performed": broadcast_performed,
        "venue_cancel_readback": {
            "verified": True,
            "status": "canceled",
            "oid": current["oid"],
            "cloid": child_cloid.lower() if child_cloid else None,
        },
    }


def order_status_by_cloid(info, execution_address, child_cloid):
    try:
        response = info.post("/info", {
            "type": "orderStatus",
            "user": execution_address,
            "oid": child_cloid,
        })
        if not isinstance(response, dict) or response.get("status") == "unknownOid":
            return None
        envelope = response.get("order") or response
        order = envelope.get("order") or envelope
        returned_cloid = str(order.get("cloid") or "").lower()
        oid = order.get("oid")
        status = re.sub(r"[^a-z0-9]", "", str(envelope.get("status") or order.get("status") or "").lower())
        if returned_cloid != str(child_cloid).lower() or oid is None:
            return None
        return {"status": status, "oid": oid}
    except Exception:
        return None


def order_status_by_oid(info, execution_address, expected_oid):
    try:
        response = info.post("/info", {
            "type": "orderStatus",
            "user": execution_address,
            "oid": expected_oid,
        })
        if not isinstance(response, dict) or response.get("status") == "unknownOid":
            return None
        envelope = response.get("order") or response
        order = envelope.get("order") or envelope
        oid = order.get("oid")
        if str(oid) != str(expected_oid):
            return None
        status = re.sub(r"[^a-z0-9]", "", str(envelope.get("status") or order.get("status") or "").lower())
        cloid = str(order.get("cloid") or "").lower() or None
        if cloid and not re.fullmatch(r"0x[0-9a-f]{32}", cloid):
            return None
        return {"status": status, "oid": oid, "cloid": cloid}
    except Exception:
        return None


def bounded_trigger_limit(trigger_price, is_buy, slippage_bps, size_decimals):
    slippage = slippage_bps / Decimal("10000")
    limit = trigger_price * (Decimal("1") + slippage if is_buy else Decimal("1") - slippage)
    if limit <= 0:
        fail("hyperliquid protection limit is invalid", "venue_rejected")
    return quantize_hyperliquid_perp_price(
        limit,
        size_decimals,
        ROUND_DOWN if is_buy else ROUND_UP,
    )


def derived_cloid(parent_cloid, purpose):
    normalized = str(parent_cloid).lower().removeprefix("0x")
    if not re.fullmatch(r"[0-9a-f]{32}", normalized):
        fail("hyperliquid parent cloid is invalid", "venue_rejected")
    digest = hashlib.sha256(bytes.fromhex(normalized) + purpose.encode("utf-8")).hexdigest()
    return f"0x{digest[:32]}"


def verify_fresh_execution_book(info, order, resolved, account_address=None):
    coin = order.get("market")
    opening_order = not bool(order.get("reduce_only"))
    mark_price = None
    active_reference_received_at_ms = None
    if opening_order and account_address is not None:
        try:
            active = info.post("/info", {
                "type": "activeAssetData",
                "user": account_address,
                "coin": coin,
            })
            if (
                not isinstance(active, dict)
                or str(active.get("user") or "").lower() != str(account_address).lower()
                or active.get("coin") != coin
            ):
                raise ValueError("invalid active asset identity")
            mark_price = Decimal(str(active.get("markPx")))
            if not mark_price.is_finite() or mark_price <= 0:
                raise ValueError("invalid active asset mark price")
            active_reference_received_at_ms = int(time.time() * 1000)
        except (AttributeError, InvalidOperation, TypeError, ValueError):
            fail("hyperliquid active market reference is unavailable", "venue_rejected")
    # Account/capacity preflights can take long enough for the book used to
    # size the order to age out. Re-read immediately before acceptance and
    # prove the already-bounded limit against the current executable book.
    execution_book = fresh_execution_book(info, coin)
    source_time_ms = execution_book["source_time_ms"]
    best_bid = execution_book["best_bid"]
    best_ask = execution_book["best_ask"]
    now_ms = int(time.time() * 1000)
    source_age_ms = now_ms - source_time_ms
    if source_age_ms < -1000 or source_age_ms > EXECUTION_BOOK_MAX_AGE_MS:
        fail("hyperliquid executable book is stale", "venue_rejected")
    if (
        active_reference_received_at_ms is not None
        and now_ms - active_reference_received_at_ms > EXECUTION_BOOK_MAX_AGE_MS
    ):
        fail("hyperliquid active market reference is stale", "venue_rejected")
    if best_ask <= best_bid:
        fail("hyperliquid executable book is crossed", "venue_rejected")
    try:
        limit_price = Decimal(str(resolved.get("limit_price")))
        max_slippage_bps = Decimal(str(order.get("max_slippage_bps") or "0"))
    except (InvalidOperation, TypeError, ValueError):
        fail("hyperliquid execution slippage bound is invalid", "venue_rejected")
    if limit_price <= 0 or max_slippage_bps <= 0 or max_slippage_bps > 100:
        fail("hyperliquid execution slippage bound is invalid", "venue_rejected")
    reference = best_ask if order.get("side") == "buy" else best_bid
    if order.get("order_type") == "market":
        try:
            size_decimals = resolved.get("size_decimals")
            if type(size_decimals) is not int or size_decimals < 0:
                raise ValueError("invalid market size precision")
            slippage = max_slippage_bps / Decimal("10000")
            fresh_limit = reference * (
                Decimal("1") + slippage
                if order.get("side") == "buy"
                else Decimal("1") - slippage
            )
            fresh_price = quantize_hyperliquid_perp_price(
                fresh_limit,
                size_decimals,
                ROUND_DOWN if order.get("side") == "buy" else ROUND_UP,
            )
            quote_size = Decimal(str(order.get("quote_size") or "0"))
            if quote_size > 0:
                previous_base = Decimal(str(resolved.get("base_size")))
                fresh_base = floor_decimal(quote_size / fresh_price, size_decimals)
                if fresh_base <= 0 or fresh_base != previous_base:
                    fail("hyperliquid market moved across an order lot boundary", "venue_rejected")
                resolved["limit_price"] = decimal_text(fresh_price)
                limit_price = fresh_price
            elif bool(order.get("reduce_only")):
                resolved["limit_price"] = decimal_text(fresh_price)
                limit_price = fresh_price
        except SystemExit:
            raise
        except (AttributeError, InvalidOperation, TypeError, ValueError):
            fail("hyperliquid fresh market resolution is invalid", "venue_rejected")
    if opening_order:
        try:
            base_size = Decimal(str(resolved.get("base_size")))
        except (InvalidOperation, TypeError, ValueError):
            fail("hyperliquid opening order size is invalid", "venue_rejected")
        minimum_reference = min(reference, mark_price) if mark_price is not None else reference
        if (
            not base_size.is_finite()
            or base_size <= 0
            or base_size * minimum_reference < MIN_OPENING_REFERENCE_NOTIONAL_USD
        ):
            fail("hyperliquid opening order is too close to the venue minimum notional", "venue_rejected")
    adverse_bps = (
        (limit_price - reference) / reference * Decimal("10000")
        if order.get("side") == "buy"
        else (reference - limit_price) / reference * Decimal("10000")
    )
    if adverse_bps > max_slippage_bps:
        fail("hyperliquid limit exceeds the current executable slippage bound", "venue_rejected")
    return {
        "source_time_ms": source_time_ms,
        "source_age_ms": max(0, source_age_ms),
        "max_age_ms": EXECUTION_BOOK_MAX_AGE_MS,
        "freshness_proven": True,
        "slippage_bound_proven": True,
        "minimum_notional_proven": True,
    }


def fresh_execution_book(info, coin):
    try:
        book = info.post("/info", {"type": "l2Book", "coin": coin})
        source_time_ms = int(book.get("time"))
        levels = book.get("levels")
        bids = levels[0] if isinstance(levels, list) and len(levels) == 2 else []
        asks = levels[1] if isinstance(levels, list) and len(levels) == 2 else []
        best_bid = max(Decimal(str(level.get("px"))) for level in bids if Decimal(str(level.get("px"))) > 0)
        best_ask = min(Decimal(str(level.get("px"))) for level in asks if Decimal(str(level.get("px"))) > 0)
    except (AttributeError, InvalidOperation, TypeError, ValueError, StopIteration):
        fail("hyperliquid executable book is unavailable")
    source_age_ms = int(time.time() * 1000) - source_time_ms
    if source_age_ms < -1000 or source_age_ms > EXECUTION_BOOK_MAX_AGE_MS:
        fail("hyperliquid executable book is stale", "venue_rejected")
    if best_ask <= best_bid:
        fail("hyperliquid executable book is crossed", "venue_rejected")
    return {
        "source_time_ms": source_time_ms,
        "best_bid": best_bid,
        "best_ask": best_ask,
    }


def hyperliquid_error_message(error):
    message = getattr(error, "error_message", None) or getattr(error, "message", None)
    if not isinstance(message, str) or not message.strip():
        message = str(error)
    if not message.strip():
        return f"hyperliquid request failed ({type(error).__name__})"
    sanitized = " ".join(message.strip().split())
    sanitized = re.sub(r"0x[0-9a-fA-F]{64}", "[redacted-secret]", sanitized)
    return f"hyperliquid request failed ({type(error).__name__}): {sanitized[:240]}"


def resolve_market_ioc_order(info, order, account_address):
    coin = order.get("market")
    try:
        slippage_bps = Decimal(str(order.get("max_slippage_bps") or "50"))
    except (InvalidOperation, ValueError):
        fail("invalid hyperliquid market order", "venue_rejected")
    if slippage_bps <= 0:
        fail("invalid hyperliquid market order", "venue_rejected")
    execution_book = fresh_execution_book(info, coin)
    reference = execution_book["best_ask"] if order.get("side") == "buy" else execution_book["best_bid"]

    quote_raw = order.get("quote_size")
    base_raw = order.get("base_size")
    try:
        quote_size = Decimal(str(quote_raw)) if quote_raw else Decimal("0")
        base_size = Decimal(str(base_raw)) if base_raw else Decimal("0")
    except (InvalidOperation, ValueError):
        fail("invalid hyperliquid market order size", "venue_rejected")
    if quote_size <= 0 and base_size <= 0:
        fail("invalid hyperliquid market order size", "venue_rejected")

    requested_notional = quote_size if quote_size > 0 else base_size * reference
    slippage = slippage_bps / Decimal("10000")
    limit = reference * (Decimal("1") + slippage if order.get("side") == "buy" else Decimal("1") - slippage)
    if limit <= 0:
        fail("invalid hyperliquid market order limit", "venue_rejected")
    size_decimals = coin_size_decimals(info, coin)
    price = quantize_hyperliquid_perp_price(limit, size_decimals, ROUND_DOWN if order.get("side") == "buy" else ROUND_UP)
    if base_size <= 0:
        base_size = floor_decimal(quote_size / price, size_decimals)
    if base_size <= 0:
        fail("hyperliquid market order size is below venue minimum", "venue_rejected")
    if base_size != floor_decimal(base_size, size_decimals):
        fail("hyperliquid market order size violates venue lot precision", "venue_rejected")
    reduce_only = bool(order.get("reduce_only"))
    effective_notional = base_size * price
    if not reduce_only and effective_notional < MIN_ORDER_NOTIONAL_USD:
        fail("hyperliquid opening order is below the venue minimum notional", "venue_rejected")
    account_state_checked = True if reduce_only else check_account_value(
        info,
        account_address,
        max(requested_notional, effective_notional),
        coin,
        order.get("side"),
        base_size,
    )
    return {
        "base_size": decimal_text(base_size),
        "limit_price": decimal_text(price),
        "tif": "Ioc",
        "account_state_checked": account_state_checked,
        "size_decimals": size_decimals,
        "execution_book": execution_book,
    }


def check_account_value(info, account_address, quote_size, market, side, base_size):
    try:
        abstraction = hyperliquid_account_abstraction(info, account_address)
        if abstraction in ("default", "disabled"):
            state = info.user_state(account_address)
            available = exact_nonnegative_account_decimal(
                state.get("withdrawable") or "0",
            )
        elif abstraction == "unifiedAccount":
            available = unified_account_available_usdc(info, account_address)
        elif abstraction == "portfolioMargin":
            fail("hyperliquid portfolio margin accounts are unsupported", "venue_rejected")
        else:
            fail("hyperliquid account abstraction mode is unsupported", "venue_rejected")
        with localcontext() as ctx:
            ctx.prec = exact_account_decimal_precision(quote_size, available)
            fee_buffer = max(Decimal("0.01"), quote_size * Decimal("0.001"))
            required = quote_size + fee_buffer
        if available < required:
            fail("hyperliquid account has insufficient available value", "venue_rejected")
        if abstraction == "unifiedAccount":
            verify_unified_active_asset_capacity(
                info,
                account_address,
                market,
                side,
                base_size,
                required,
            )
        return True
    except SystemExit:
        raise
    except Exception:
        fail("hyperliquid account state unavailable", "venue_rejected")


def hyperliquid_account_abstraction(info, account_address):
    query = getattr(info, "query_user_abstraction_state", None)
    abstraction = (
        query(account_address)
        if callable(query)
        else info.post("/info", {"type": "userAbstraction", "user": account_address})
    )
    if not isinstance(abstraction, str):
        raise ValueError("invalid Hyperliquid account abstraction response")
    return abstraction


def unified_account_available_usdc(info, account_address):
    query = getattr(info, "spot_user_state", None)
    state = (
        query(account_address)
        if callable(query)
        else info.post("/info", {"type": "spotClearinghouseState", "user": account_address})
    )
    if not isinstance(state, dict) or not isinstance(state.get("balances"), list):
        raise ValueError("invalid Hyperliquid spot account state")
    balances = state["balances"]
    if any(not isinstance(balance, dict) for balance in balances):
        raise ValueError("invalid Hyperliquid spot balance")
    usdc_balances = [
        balance
        for balance in balances
        if balance.get("coin") == "USDC" or balance.get("token") == 0
    ]
    if not usdc_balances:
        return Decimal("0")
    if (
        len(usdc_balances) != 1
        or usdc_balances[0].get("coin") != "USDC"
        or usdc_balances[0].get("token") != 0
    ):
        raise ValueError("invalid Hyperliquid USDC spot balance")
    total = exact_nonnegative_account_decimal(usdc_balances[0].get("total"))
    hold = exact_nonnegative_account_decimal(usdc_balances[0].get("hold"))
    if hold > total:
        raise ValueError("invalid Hyperliquid USDC spot hold")
    with localcontext() as ctx:
        ctx.prec = exact_account_decimal_precision(total, hold)
        return total - hold


def verify_unified_active_asset_capacity(
    info,
    account_address,
    market,
    side,
    base_size,
    required,
):
    if (
        not isinstance(account_address, str)
        or not re.fullmatch(r"0x[0-9a-fA-F]{40}", account_address)
        or not isinstance(market, str)
        or not market
        or len(market) > 128
        or market.strip() != market
        or side not in ("buy", "sell")
        or not isinstance(base_size, Decimal)
        or not base_size.is_finite()
        or base_size <= 0
        or not isinstance(required, Decimal)
        or not required.is_finite()
        or required <= 0
    ):
        raise ValueError("invalid Hyperliquid active asset request")
    state = info.post("/info", {
        "type": "activeAssetData",
        "user": account_address,
        "coin": market,
    })
    if not isinstance(state, dict):
        raise ValueError("invalid Hyperliquid active asset state")
    returned_user = state.get("user")
    returned_coin = state.get("coin")
    if (
        not isinstance(returned_user, str)
        or not re.fullmatch(r"0x[0-9a-fA-F]{40}", returned_user)
        or returned_user.lower() != account_address.lower()
        or not isinstance(returned_coin, str)
        or returned_coin != market
    ):
        raise ValueError("invalid Hyperliquid active asset identity")
    leverage = state.get("leverage")
    if (
        not isinstance(leverage, dict)
        or not isinstance(leverage.get("type"), str)
        or type(leverage.get("value")) is not int
    ):
        raise ValueError("invalid Hyperliquid active asset leverage")
    if leverage["type"] == "isolated":
        exact_signed_account_decimal(leverage.get("rawUsd"))
    if leverage["type"] != "isolated" or leverage["value"] != 1:
        fail("hyperliquid active market must already use isolated 1x leverage", "venue_rejected")
    available_raw = state.get("availableToTrade")
    max_size_raw = state.get("maxTradeSzs")
    if (
        not isinstance(available_raw, list)
        or len(available_raw) != 2
        or not isinstance(max_size_raw, list)
        or len(max_size_raw) != 2
    ):
        raise ValueError("invalid Hyperliquid active asset capacity")
    available = [exact_nonnegative_account_decimal(value) for value in available_raw]
    max_sizes = [exact_nonnegative_account_decimal(value) for value in max_size_raw]
    side_index = 0 if side == "buy" else 1
    if available[side_index] < required:
        fail("hyperliquid active market has insufficient available value", "venue_rejected")
    if base_size > max_sizes[side_index]:
        fail("hyperliquid order exceeds the active market maximum size", "venue_rejected")
    return True


def exact_nonnegative_account_decimal(value):
    if (
        not isinstance(value, str)
        or len(value) > 128
        or not re.fullmatch(r"\d+(?:\.\d+)?", value)
    ):
        raise ValueError("invalid Hyperliquid account decimal")
    return Decimal(value)


def exact_signed_account_decimal(value):
    if (
        not isinstance(value, str)
        or len(value) > 128
        or not re.fullmatch(r"-?\d+(?:\.\d+)?", value)
    ):
        raise ValueError("invalid Hyperliquid account decimal")
    return Decimal(value)


def exact_account_decimal_precision(*values):
    return max(
        40,
        *(len(value.as_tuple().digits) + abs(value.as_tuple().exponent) + 2 for value in values),
    )


def configure_isolated_leverage(exchange, order):
    margin_mode = str(order.get("margin_mode") or "isolated").strip().lower()
    try:
        leverage = int(order.get("leverage") or 1)
    except (TypeError, ValueError):
        fail("invalid hyperliquid leverage configuration", "venue_rejected")
    if margin_mode != "isolated" or leverage != 1:
        fail("hyperliquid live trading requires isolated 1x leverage", "venue_rejected")
    result = exchange.update_leverage(leverage, order.get("market"), False)
    if not isinstance(result, dict) or result.get("status") != "ok":
        fail("hyperliquid isolated 1x configuration was not accepted", "venue_rejected")
    return {
        "margin_mode": "isolated",
        "leverage": 1,
        "venue_accepted": True,
    }


def coin_size_decimals(info, coin):
    try:
        meta = info.meta()
        for asset in meta.get("universe", []):
            if asset.get("name") == coin:
                value = int(asset.get("szDecimals"))
                if 0 <= value <= 6:
                    return value
                break
    except Exception:
        pass
    fail("hyperliquid size metadata is unavailable", "venue_rejected")


def floor_decimal(value, decimals):
    decimals = max(0, min(int(decimals), 12))
    quantum = Decimal("1").scaleb(-decimals)
    with localcontext() as ctx:
        ctx.prec = 40
        return value.quantize(quantum, rounding=ROUND_DOWN)


def hyperliquid_perp_price_quantum(value, size_decimals):
    if value <= 0 or not 0 <= int(size_decimals) <= 6:
        fail("hyperliquid price precision is invalid", "venue_rejected")
    with localcontext() as ctx:
        ctx.prec = 40
        decimal_quantum = Decimal("1").scaleb(-(6 - int(size_decimals)))
        significant_quantum = Decimal("1") if value >= Decimal("10000") else Decimal("1").scaleb(value.adjusted() - 4)
        return max(decimal_quantum, significant_quantum)


def hyperliquid_perp_price_valid(value, size_decimals):
    quantum = hyperliquid_perp_price_quantum(value, size_decimals)
    with localcontext() as ctx:
        ctx.prec = 40
        return value == value.quantize(quantum)


def quantize_hyperliquid_perp_price(value, size_decimals, rounding):
    quantum = hyperliquid_perp_price_quantum(value, size_decimals)
    with localcontext() as ctx:
        ctx.prec = 40
        return value.quantize(quantum, rounding=rounding)


def decimal_text(value):
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def redact_result(
    status,
    result,
    coin=None,
    execution_configuration=None,
    execution_market_gate=None,
    expires_after_ms=None,
):
    if not isinstance(result, dict) or result.get("status") != "ok":
        fail(hyperliquid_response_error(result), "venue_rejected")
    statuses = result.get("response", {}).get("data", {}).get("statuses", [])
    if not isinstance(statuses, list) or not statuses:
        fail("hyperliquid response did not prove venue acceptance", "venue_rejected")
    first = statuses[0]
    if status == "cancelled":
        if first == "success" or (isinstance(first, dict) and first.get("success") is not None):
            return {"status": "cancelled", "oid": None, "fills": []}
        fail(hyperliquid_response_error(first), "venue_rejected")
    if not isinstance(first, dict):
        fail(hyperliquid_response_error(first), "venue_rejected")
    if first.get("error"):
        fail(hyperliquid_response_error(first), "venue_rejected")

    oid = None
    fills = []
    resolved_status = status
    resting = first.get("resting") or {}
    filled = first.get("filled") or {}
    oid = resting.get("oid") or filled.get("oid")
    if filled:
        total_size = filled.get("totalSz") or filled.get("sz")
        average_price = filled.get("avgPx") or filled.get("px")
        if not total_size or not average_price:
            fail("hyperliquid fill response is incomplete", "venue_rejected")
        fills.append({
            "coin": coin,
            "px": str(average_price),
            "sz": str(total_size),
            "fee": "0",
            "time": int(time.time() * 1000),
        })
        resolved_status = "filled"
    elif not resting:
        fail("hyperliquid order response did not prove resting or filled status", "venue_rejected")
    redacted = {
        "status": resolved_status,
        "oid": oid,
        "fills": fills,
    }
    if execution_configuration is not None:
        redacted["execution_configuration"] = execution_configuration
    if execution_market_gate is not None:
        redacted["execution_market_gate"] = execution_market_gate
    if expires_after_ms is not None:
        redacted["expires_after_ms"] = expires_after_ms
        redacted["action_expiry_enforced"] = True
    return redacted


def hyperliquid_response_error(value):
    if isinstance(value, dict):
        value = value.get("error") or value.get("response") or value.get("msg")
    message = value if isinstance(value, str) else "hyperliquid venue rejected request"
    sanitized = " ".join(message.strip().split())[:200]
    return f"hyperliquid venue rejected request: {sanitized}" if sanitized else "hyperliquid venue rejected request"


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
