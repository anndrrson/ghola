#!/usr/bin/env python3
import asyncio
import csv
import hashlib
import io
import ipaddress
import json
import socket
import sys
from decimal import Decimal, ROUND_DOWN
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

MAX_INACTIVE_ORDER_PAGES = 4
INACTIVE_ORDER_PAGE_SIZE = 100
MAX_TRADE_PAGES = 8
TRADE_PAGE_SIZE = 100
LIGHTER_FEE_TICK_DENOMINATOR = Decimal(1_000_000)
LIGHTER_ORDER_TIME_SKEW_MS = 300_000
LIGHTER_TIME_IN_FORCE = {
    "ioc": "immediate-or-cancel",
    "gtc": "good-till-time",
    "alo": "post-only",
}
LIGHTER_CANCELED_ORDER_STATUSES = frozenset({
    "canceled",
    "canceled-post-only",
    "canceled-reduce-only",
    "canceled-position-not-allowed",
    "canceled-margin-not-allowed",
    "canceled-too-much-slippage",
    "canceled-not-enough-liquidity",
    "canceled-self-trade",
    "canceled-expired",
    "canceled-oco",
    "canceled-child",
    "canceled-liquidation",
    "canceled-invalid-balance",
})


def fail(message, code="connector_submit_failed"):
    print(json.dumps({"error": message, "error_code": code}))
    raise SystemExit(1)


def exact_timestamp_ms(value, message):
    timestamp = exact_integer(value, message)
    timestamp_ms = timestamp * 1000 if timestamp < 10_000_000_000 else timestamp
    if timestamp_ms <= 0:
        fail(message)
    return timestamp_ms


def as_dict(value):
    if value is None:
        return {}
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return value if isinstance(value, dict) else {}


def exact_market_order(orders, client_order_index, market_index):
    target_client_order = int(client_order_index)
    target_market = int(market_index)
    for item in orders if isinstance(orders, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            item_client_order = int(item.get("client_order_index", -1))
            item_market = int(item.get("market_index", item.get("market_id", -1)))
        except (TypeError, ValueError):
            continue
        if item_client_order == target_client_order and item_market == target_market:
            return item
    return None


def scale(value, decimals):
    return int((Decimal(str(value)) * (Decimal(10) ** decimals)).to_integral_value(rounding=ROUND_DOWN))


def human(value, decimals):
    return format(Decimal(value) / (Decimal(10) ** decimals), f".{decimals}f")


def safe_https_url(value):
    parsed = urlparse(str(value or ""))
    if parsed.scheme != "https" or not parsed.hostname:
        fail("lighter funding export URL is invalid")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)}
    except Exception:
        fail("lighter funding export host is unavailable")
    for value in addresses:
        address = ipaddress.ip_address(value)
        if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_unspecified:
            fail("lighter funding export host is invalid")
    return parsed.geturl()


async def market_for(client, symbol):
    books = await client.order_api.order_books()
    for market in books.order_books:
        if str(market.symbol).upper() == str(symbol).upper() and str(getattr(market, "market_type", "perp")) == "perp":
            return market
    fail("lighter market is unavailable", "venue_rejected")


async def account_for(client, account_index):
    response = await lighter.AccountApi(client.api_client).account(by="index", value=str(account_index))
    if not response.accounts:
        fail("lighter account is unavailable", "venue_access_required")
    return as_dict(response.accounts[0])


def order_page_from_response(response):
    payload = as_dict(response)
    orders = payload.get("orders")
    if not isinstance(orders, list):
        fail("lighter order read is invalid")
    cursor = payload.get("next_cursor")
    if cursor is not None and not isinstance(cursor, str):
        fail("lighter order cursor is invalid")
    return orders, str(cursor or "").strip() or None


def trade_page_from_response(response):
    raw_data = getattr(response, "raw_data", None)
    if raw_data is not None:
        if not isinstance(raw_data, (bytes, bytearray, str)):
            fail("lighter raw trade read is invalid")
        try:
            payload = json.loads(raw_data)
        except (TypeError, ValueError, UnicodeDecodeError):
            fail("lighter raw trade read is invalid")
    else:
        payload = as_dict(response)
    if not isinstance(payload, dict):
        fail("lighter trade read is invalid")
    trades = payload.get("trades")
    if not isinstance(trades, list):
        fail("lighter trade read is invalid")
    cursor = payload.get("next_cursor")
    if cursor is not None and not isinstance(cursor, str):
        fail("lighter trade cursor is invalid")
    normalized = [as_dict(item) for item in trades]
    if any(not item for item in normalized):
        fail("lighter trade row is invalid")
    return normalized, str(cursor or "").strip() or None


def exact_integer(value, label, *, signed=False):
    if isinstance(value, bool):
        fail(label)
    if isinstance(value, int):
        number = value
    elif isinstance(value, str):
        text = value.strip()
        digits = text[1:] if signed and text.startswith("-") else text
        if not digits.isdigit():
            fail(label)
        number = int(text)
    else:
        fail(label)
    if not signed and number < 0:
        fail(label)
    return number


def exact_decimal(value, label, *, positive=False):
    text = "" if value is None else str(value).strip()
    unsigned = text[1:] if text.startswith("-") else text
    parts = unsigned.split(".")
    if len(parts) > 2 or not parts[0].isdigit() or (len(parts) == 2 and not parts[1].isdigit()):
        fail(label)
    number = Decimal(text)
    if not number.is_finite() or (positive and number <= 0):
        fail(label)
    return number


def decimal_text(value):
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def terminal_order_status(value):
    status = str(value or "").lower()
    return status == "filled" or status in LIGHTER_CANCELED_ORDER_STATUSES


def submitted_order_fingerprint_matches(
    order,
    fingerprint,
    *,
    account_index,
    market_index,
    market_symbol,
    expected_order_index=None,
):
    if not isinstance(order, dict) or not isinstance(fingerprint, dict):
        return False
    try:
        if fingerprint.get("version") != 1:
            return False
        expected_client_order_index = exact_integer(
            fingerprint.get("client_order_index"), "lighter fingerprint client order is invalid"
        )
        expected_side = str(fingerprint.get("side") or "").lower()
        expected_base = exact_decimal(
            fingerprint.get("base_size"), "lighter fingerprint base size is invalid", positive=True
        )
        expected_price = exact_decimal(
            fingerprint.get("limit_price"), "lighter fingerprint price is invalid", positive=True
        )
        expected_tif = str(fingerprint.get("time_in_force") or "").lower()
        submitted_at_ms = exact_timestamp_ms(
            fingerprint.get("submitted_at_ms"), "lighter fingerprint submission time is invalid"
        )
        if (
            str(fingerprint.get("market") or "").upper() != str(market_symbol).upper()
            or expected_side not in ("buy", "sell")
            or expected_tif not in LIGHTER_TIME_IN_FORCE
            or not isinstance(fingerprint.get("reduce_only"), bool)
            or exact_integer(order.get("owner_account_index"), "lighter order account is invalid") != int(account_index)
            or exact_integer(order.get("market_index"), "lighter order market is invalid") != int(market_index)
            or exact_integer(order.get("client_order_index"), "lighter order client id is invalid") != expected_client_order_index
            or exact_decimal(order.get("initial_base_amount"), "lighter order size is invalid", positive=True) != expected_base
            or exact_decimal(order.get("price"), "lighter order price is invalid", positive=True) != expected_price
            or order.get("is_ask") is not (expected_side == "sell")
            or str(order.get("side") or "").lower() != expected_side
            or order.get("type") != "limit"
            or order.get("time_in_force") != LIGHTER_TIME_IN_FORCE[expected_tif]
            or order.get("reduce_only") is not fingerprint["reduce_only"]
        ):
            return False
        created_at_ms = exact_timestamp_ms(
            order.get("created_at", order.get("timestamp", order.get("transaction_time"))),
            "lighter order creation time is invalid",
        )
        if abs(created_at_ms - submitted_at_ms) > LIGHTER_ORDER_TIME_SKEW_MS:
            return False
        order_index = exact_integer(order.get("order_index"), "lighter order index is invalid")
        if expected_order_index is not None and order_index != exact_integer(
            expected_order_index, "lighter expected order lineage is invalid"
        ):
            return False
        return True
    except (ArithmeticError, TypeError, ValueError):
        return False


def incomplete_trade_fee_proof(account_index, market_index, order_index, client_order_index, reason):
    return {
        "version": 1,
        "proof_kind": "lighter_authenticated_order_trades_fee_v1",
        "complete": False,
        "pagination_complete": True,
        "transaction_broadcast": False,
        "account_index": int(account_index),
        "market_id": int(market_index),
        "order_index": str(order_index),
        "client_order_index": int(client_order_index),
        "reason": reason,
    }


def zero_trade_fee_proof(account_index, market_index, order_index, client_order_index):
    evidence = "[]"
    return {
        "version": 1,
        "proof_kind": "lighter_authenticated_order_trades_fee_v1",
        "complete": True,
        "pagination_complete": True,
        "transaction_broadcast": False,
        "account_index": int(account_index),
        "market_id": int(market_index),
        "order_index": str(order_index),
        "client_order_index": int(client_order_index),
        "trade_count": 0,
        "first_trade_id": None,
        "last_trade_id": None,
        "first_fill_at_ms": None,
        "last_fill_at_ms": None,
        "fill_time_provenance": None,
        "fill_times_authoritative": False,
        "authenticated_fills": [],
        "filled_base_amount": "0",
        "filled_quote_amount": "0",
        "fee_quote_amount": "0",
        "fee_asset": "USDC",
        "fee_rate_tick_denominator": int(LIGHTER_FEE_TICK_DENOMINATOR),
        "quote_atomic_denominator": 1_000_000,
        "evidence_commitment": "sha256:" + hashlib.sha256(evidence.encode("utf-8")).hexdigest(),
    }


async def exact_account_order_trades(client, account_index, market_index, client_order_index, order):
    account_index = int(account_index)
    market_index = int(market_index)
    client_order_index = int(client_order_index)
    order_index = exact_integer(order.get("order_index"), "lighter terminal order index is invalid")
    expected_base = exact_decimal(order.get("filled_base_amount"), "lighter terminal fill size is invalid")
    expected_quote = exact_decimal(order.get("filled_quote_amount"), "lighter terminal fill quote is invalid")
    if expected_base < 0 or expected_quote < 0 or (expected_base == 0) != (expected_quote == 0):
        fail("lighter terminal fill totals are invalid")
    auth = await auth_token(client)
    cursor = None
    seen_cursors = set()
    rows = []
    for _ in range(MAX_TRADE_PAGES):
        params = {
            "sort_by": "timestamp",
            "sort_dir": "desc",
            "limit": TRADE_PAGE_SIZE,
            "authorization": auth,
            "market_id": market_index,
            "account_index": account_index,
            "order_index": order_index,
            "aggregate": False,
        }
        if cursor is not None:
            params["cursor"] = cursor
        response = await client.order_api.trades_with_http_info(**params)
        page, next_cursor = trade_page_from_response(response)
        rows.extend(page)
        if next_cursor is None:
            break
        if next_cursor == cursor or next_cursor in seen_cursors:
            fail("lighter trade pagination did not advance")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    else:
        fail("lighter trade pagination exceeded the evidence bound")

    normalized = []
    seen_trade_ids = set()
    base_total = Decimal(0)
    quote_total = Decimal(0)
    fee_total = Decimal(0)
    expected_is_ask = order.get("is_ask")
    if expected_is_ask is not None and not isinstance(expected_is_ask, bool):
        fail("lighter terminal order side is invalid")
    for trade in rows:
        trade_id = exact_integer(trade.get("trade_id"), "lighter trade id is invalid")
        executed_at_ms = exact_timestamp_ms(trade.get("timestamp"), "lighter trade timestamp is invalid")
        if trade_id in seen_trade_ids:
            fail("lighter trade evidence contains a duplicate trade")
        seen_trade_ids.add(trade_id)
        if trade.get("type") != "trade":
            fail("lighter trade type binding failed")
        if exact_integer(trade.get("market_id"), "lighter trade market is invalid") != market_index:
            fail("lighter trade market binding failed")
        ask_account = exact_integer(trade.get("ask_account_id"), "lighter trade ask account is invalid")
        bid_account = exact_integer(trade.get("bid_account_id"), "lighter trade bid account is invalid")
        account_is_ask = ask_account == account_index
        account_is_bid = bid_account == account_index
        if account_is_ask == account_is_bid:
            fail("lighter trade account binding failed")
        side = "ask" if account_is_ask else "bid"
        bound_order_id = trade.get("ask_id") if account_is_ask else trade.get("bid_id")
        bound_client_id = trade.get("ask_client_id") if account_is_ask else trade.get("bid_client_id")
        if exact_integer(bound_order_id, "lighter trade order is invalid") != order_index:
            fail("lighter trade order binding failed")
        if exact_integer(bound_client_id, "lighter trade client order is invalid") != client_order_index:
            fail("lighter trade client-order binding failed")
        if expected_is_ask is not None and expected_is_ask != account_is_ask:
            fail("lighter trade side binding failed")
        is_maker_ask = trade.get("is_maker_ask")
        if not isinstance(is_maker_ask, bool):
            fail("lighter trade maker side is invalid")
        role = "maker" if account_is_ask == is_maker_ask else "taker"
        fee_key = f"{role}_fee"
        fee_tick = 0 if fee_key not in trade else exact_integer(
            trade[fee_key], "lighter trade fee tick is invalid", signed=True
        )
        if abs(fee_tick) > int(LIGHTER_FEE_TICK_DENOMINATOR):
            fail("lighter trade fee tick is out of bounds")
        size = exact_decimal(trade.get("size"), "lighter trade size is invalid", positive=True)
        price = exact_decimal(trade.get("price"), "lighter trade price is invalid", positive=True)
        quote = exact_decimal(trade.get("usd_amount"), "lighter trade quote amount is invalid", positive=True)
        fee = quote * Decimal(fee_tick) / LIGHTER_FEE_TICK_DENOMINATOR
        base_total += size
        quote_total += quote
        fee_total += fee
        normalized.append({
            "trade_id": trade_id,
            "market_id": market_index,
            "account_index": account_index,
            "order_index": order_index,
            "client_order_index": client_order_index,
            "side": side,
            "role": role,
            "size": decimal_text(size),
            "price": decimal_text(price),
            "quote_size": decimal_text(quote),
            "fee_rate_tick": fee_tick,
            "fee_quote_amount": decimal_text(fee),
            "executed_at_ms": executed_at_ms,
        })

    if not normalized and expected_base == 0 and expected_quote == 0:
        return zero_trade_fee_proof(
            account_index, market_index, order_index, client_order_index
        )
    if not normalized:
        return incomplete_trade_fee_proof(
            account_index, market_index, order_index, client_order_index, "no_order_trades"
        )
    if base_total > expected_base or quote_total > expected_quote:
        fail("lighter trade totals exceed the terminal order")
    if base_total != expected_base or quote_total != expected_quote:
        return incomplete_trade_fee_proof(
            account_index, market_index, order_index, client_order_index, "trade_totals_incomplete"
        )
    evidence = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    return {
        "version": 1,
        "proof_kind": "lighter_authenticated_order_trades_fee_v1",
        "complete": True,
        "pagination_complete": True,
        "transaction_broadcast": False,
        "account_index": account_index,
        "market_id": market_index,
        "order_index": str(order_index),
        "client_order_index": client_order_index,
        "trade_count": len(normalized),
        "first_trade_id": str(normalized[0]["trade_id"]),
        "last_trade_id": str(normalized[-1]["trade_id"]),
        "first_fill_at_ms": min(item["executed_at_ms"] for item in normalized),
        "last_fill_at_ms": max(item["executed_at_ms"] for item in normalized),
        "fill_time_provenance": "lighter_authenticated_order_trades_timestamp_v1",
        "fill_times_authoritative": True,
        "authenticated_fills": [
            {
                "size": item["size"],
                "quote_size": item["quote_size"],
                "price": item["price"],
                "fee": item["fee_quote_amount"],
                "fee_asset": "USDC",
                "executed_at_ms": item["executed_at_ms"],
            }
            for item in normalized
        ],
        "filled_base_amount": decimal_text(base_total),
        "filled_quote_amount": decimal_text(quote_total),
        "fee_quote_amount": decimal_text(fee_total),
        "fee_asset": "USDC",
        "fee_rate_tick_denominator": int(LIGHTER_FEE_TICK_DENOMINATOR),
        "quote_atomic_denominator": 1_000_000,
        "evidence_commitment": "sha256:" + hashlib.sha256(evidence.encode("utf-8")).hexdigest(),
    }


async def exact_account_order(client, account_index, market_index, client_order_index, *, include_inactive):
    auth = await auth_token(client)
    active_response = await client.order_api.account_active_orders(
        account_index=int(account_index),
        market_id=int(market_index),
        authorization=auth,
    )
    active_orders, _ = order_page_from_response(active_response)
    target = exact_market_order(
        active_orders,
        client_order_index,
        market_index,
    )
    if target is not None or not include_inactive:
        return target
    cursor = None
    seen_cursors = set()
    for _ in range(MAX_INACTIVE_ORDER_PAGES):
        params = {
            "account_index": int(account_index),
            "limit": INACTIVE_ORDER_PAGE_SIZE,
            "authorization": auth,
            "market_id": int(market_index),
        }
        if cursor is not None:
            params["cursor"] = cursor
        inactive_response = await client.order_api.account_inactive_orders(**params)
        inactive_orders, next_cursor = order_page_from_response(inactive_response)
        target = exact_market_order(inactive_orders, client_order_index, market_index)
        if target is not None or next_cursor is None:
            return target
        if next_cursor in seen_cursors:
            fail("lighter inactive-order pagination did not advance")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return None


def signed_order(client, order, market, *, nonce=-1, skip_nonce=0):
    size_decimals = int(market.supported_size_decimals)
    price_decimals = int(market.supported_price_decimals)
    base_amount = scale(order["base_size"], size_decimals)
    price = scale(order["limit_price"], price_decimals)
    if base_amount <= 0 or price <= 0:
        fail("lighter order is below market precision", "venue_rejected")
    tif = {
        "ioc": client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
        "gtc": client.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
        "alo": client.ORDER_TIME_IN_FORCE_POST_ONLY,
    }[order["tif"]]
    signed = client.sign_create_order(
        market_index=int(market.market_id),
        client_order_index=int(order["client_order_index"]),
        base_amount=base_amount,
        price=price,
        is_ask=order["side"] == "sell",
        order_type=client.ORDER_TYPE_LIMIT,
        time_in_force=tif,
        reduce_only=bool(order.get("reduce_only")),
        nonce=nonce,
        skip_nonce=skip_nonce,
        api_key_index=int(credential["api_key_index"]),
    )
    return signed, {
        "base_size": human(base_amount, size_decimals),
        "limit_price": human(price, price_decimals),
        "quantity_step_e8": 10 ** max(0, 8 - size_decimals),
        "price_tick_e8": 10 ** max(0, 8 - price_decimals),
    }, {
        "MarketIndex": int(market.market_id),
        "ClientOrderIndex": int(order["client_order_index"]),
        "BaseAmount": base_amount,
        "Price": price,
        "IsAsk": int(order["side"] == "sell"),
        "Type": int(client.ORDER_TYPE_LIMIT),
        "TimeInForce": int(tif),
        "ReduceOnly": int(bool(order.get("reduce_only"))),
    }


def check_signed_order_fields(tx_info, expected):
    try:
        packet = json.loads(tx_info)
    except (TypeError, ValueError):
        fail("lighter signed order packet is invalid", "venue_rejected")
    if not isinstance(packet, dict):
        fail("lighter signed order packet is invalid", "venue_rejected")
    for field, expected_value in expected.items():
        actual = packet.get(field)
        if isinstance(actual, bool):
            actual = int(actual)
        if not isinstance(actual, int) or actual != expected_value:
            fail("lighter signed order packet binding failed", "venue_rejected")
    return True


async def auth_token(client):
    token, err = client.create_auth_token_with_expiry(api_key_index=int(credential["api_key_index"]))
    if err is not None:
        fail("lighter auth token failed", "venue_access_required")
    return token


async def run(payload):
    global lighter, credential
    try:
        import lighter
    except Exception:
        fail("lighter python sdk unavailable")
    action = payload.get("action")
    if action == "generate_api_key":
        private_key, public_key, error = lighter.create_api_key()
        if error is not None:
            fail("lighter API key generation failed", "key_generation_failed")
        return {
            "private_key": private_key,
            "public_key": public_key,
            "error": None,
        }
    credential = payload.get("credential") or {}
    try:
        client = lighter.SignerClient(
            url=credential["api_base_url"],
            account_index=int(credential["account_index"]),
            api_private_keys={int(credential["api_key_index"]): credential["api_private_key"]},
        )
    except Exception:
        fail("lighter signer initialization failed", "venue_access_required")
    try:
        err = client.check_client()
        if err is not None:
            fail("lighter API key is not authorized for this account", "venue_access_required")
        if action == "credential":
            account = await account_for(client, credential["account_index"])
            return {
                "credential_verified": True,
                "account_read": True,
                "transaction_broadcast": False,
                "account": account,
            }
        if action == "route_terms":
            account, asset_details, withdrawal_delay = await asyncio.gather(
                account_for(client, credential["account_index"]),
                client.order_api.asset_details(asset_id=client.ASSET_ID_USDC),
                lighter.InfoApi(client.api_client).withdrawal_delay(),
            )
            assets = getattr(asset_details, "asset_details", None) or []
            usdc = next((item for item in assets if str(getattr(item, "symbol", "")).upper() == "USDC"), None)
            if usdc is None:
                fail("lighter USDC withdrawal terms are unavailable", "venue_access_required")
            delay_seconds = int(getattr(withdrawal_delay, "seconds", -1))
            if delay_seconds < 0:
                fail("lighter withdrawal delay is unavailable", "venue_access_required")
            return {
                "credential_verified": True,
                "account_state_checked": True,
                "withdrawal_terms_checked": True,
                "normal_withdrawal_fee_usdc": "0",
                "fee_source": "lighter_sdk_normal_withdrawal_v1",
                "minimum_withdrawal_usdc": str(getattr(usdc, "min_withdrawal_amount", "")),
                "maximum_withdrawal_usdc": str(account.get("available_balance", "")),
                "withdrawal_delay_seconds": delay_seconds,
                "transaction_broadcast": False,
            }
        if action in ("verify", "submit"):
            order = payload.get("order") or {}
            market = await market_for(client, order.get("market"))
            account = await account_for(client, credential["account_index"])
            if action == "verify":
                (tx_type, tx_info, tx_hash, sign_err), shape, expected_fields = signed_order(
                    client, order, market, nonce=0, skip_nonce=client.SKIP_NONCE_ON
                )
                if sign_err is not None or tx_type is None or tx_info is None:
                    fail("lighter order packet could not be signed", "venue_rejected")
                check_signed_order_fields(tx_info, expected_fields)
                return {
                    "credential_verified": True,
                    "account_state_checked": True,
                    "market_data_checked": True,
                    "order_packet_built": True,
                    "signed_order_fields_checked": True,
                    "transaction_broadcast": False,
                    "account": account,
                    "market": as_dict(market),
                    "order_shape": shape,
                }
            size_decimals = int(market.supported_size_decimals)
            price_decimals = int(market.supported_price_decimals)
            base_amount = scale(order["base_size"], size_decimals)
            price = scale(order["limit_price"], price_decimals)
            tif = {
                "ioc": client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
                "gtc": client.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
                "alo": client.ORDER_TIME_IN_FORCE_POST_ONLY,
            }[order["tif"]]
            tx, response, submit_err = await client.create_order(
                market_index=int(market.market_id),
                client_order_index=int(order["client_order_index"]),
                base_amount=base_amount,
                price=price,
                is_ask=order["side"] == "sell",
                order_type=client.ORDER_TYPE_LIMIT,
                time_in_force=tif,
                reduce_only=bool(order.get("reduce_only")),
                api_key_index=int(credential["api_key_index"]),
            )
            if submit_err is not None or getattr(response, "code", 200) != 200:
                fail("lighter order was rejected", "venue_rejected")
            return {"accepted": True, "status": "submitted", "tx_hash": getattr(response, "tx_hash", None)}
        if action == "cancel":
            market = await market_for(client, payload.get("market"))
            target = int(payload["client_order_index"])
            order = await exact_account_order(
                client,
                credential["account_index"],
                market.market_id,
                target,
                include_inactive=False,
            )
            if order is None or order.get("order_index") is None:
                fail("lighter cancel target is unavailable", "venue_rejected")
            tx, response, cancel_err = await client.cancel_order(
                market_index=int(market.market_id),
                order_index=int(order["order_index"]),
                api_key_index=int(credential["api_key_index"]),
            )
            if cancel_err is not None or getattr(response, "code", 200) != 200:
                fail("lighter cancel was rejected", "venue_rejected")
            return {"accepted": True, "status": "cancelled", "tx_hash": getattr(response, "tx_hash", None)}
        if action == "reconcile":
            market = await market_for(client, payload.get("market"))
            target = int(payload["client_order_index"])
            order = await exact_account_order(
                client,
                credential["account_index"],
                market.market_id,
                target,
                include_inactive=True,
            )
            expected_fingerprint = payload.get("expected_order_fingerprint")
            fingerprint_checked = isinstance(expected_fingerprint, dict)
            fingerprint_matched = fingerprint_checked and order is not None and submitted_order_fingerprint_matches(
                order,
                expected_fingerprint,
                account_index=credential["account_index"],
                market_index=market.market_id,
                market_symbol=market.symbol,
                expected_order_index=payload.get("expected_order_index"),
            )
            identifier_collision = order is not None and not fingerprint_matched
            if not fingerprint_matched:
                order = None
            fee_proof = None
            if order is not None:
                status = str(order.get("status") or "").lower()
                filled = exact_decimal(order.get("filled_base_amount", "0"), "lighter fill size is invalid")
                if terminal_order_status(status):
                    filled_quote = exact_decimal(
                        order.get("filled_quote_amount", "0"), "lighter fill quote is invalid"
                    )
                    if filled == 0 and filled_quote != 0:
                        fail("lighter zero-fill terminal order quote is invalid")
                    fee_proof = await exact_account_order_trades(
                        client,
                        credential["account_index"],
                        market.market_id,
                        target,
                        order,
                    )
            outbound_order = None
            if order is not None:
                outbound_order = dict(order)
                if outbound_order.get("order_index") is not None:
                    outbound_order["order_index"] = str(exact_integer(
                        outbound_order["order_index"], "lighter order index is invalid"
                    ))
            return {
                "order": outbound_order,
                "fee_proof": fee_proof,
                "account_index": int(credential["account_index"]),
                "market_id": int(market.market_id),
                "target_market_checked": True,
                "target_fingerprint_checked": fingerprint_checked,
                "target_fingerprint_matched": fingerprint_matched,
                "target_identifier_collision": identifier_collision,
            }
        if action == "funding":
            market = await market_for(client, payload.get("market"))
            auth = await auth_token(client)
            query = urlencode({
                "account_index": int(credential["account_index"]),
                "market_id": int(market.market_id),
                "type": "funding",
                "start_timestamp": int(payload["start_time_ms"]),
                "end_timestamp": int(payload["end_time_ms"]),
                "side": "all",
                "aggregate": "false",
            })
            base = str(credential["api_base_url"]).rstrip("/")
            export_request = Request(f"{base}/api/v1/export?{query}", headers={"authorization": auth, "accept": "application/json"})
            with urlopen(export_request, timeout=12) as response:
                exported = json.loads(response.read(1_000_000).decode("utf-8"))
            data_url = str(exported.get("data_url") or "")
            safe_https_url(data_url)
            with urlopen(Request(data_url, headers={"accept": "text/csv"}), timeout=12) as response:
                safe_https_url(response.geturl())
                content = response.read(20_000_001)
            if len(content) > 20_000_000:
                fail("lighter funding export is too large")
            rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
            market_id = int(market.market_id)
            for row in rows:
                if row.get("type") != "funding":
                    fail("lighter funding type binding failed")
                if exact_integer(row.get("market_id"), "lighter funding market is invalid") != market_id:
                    fail("lighter funding market binding failed")
            return {
                "funding_rows": rows,
                "account_index": int(credential["account_index"]),
                "market_id": market_id,
                "symbol": str(market.symbol),
            }
        fail("unsupported lighter runner action")
    finally:
        await client.close()


def main():
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(asyncio.run(run(payload))))
    except SystemExit:
        raise
    except Exception:
        fail("lighter runner request failed")


if __name__ == "__main__":
    main()
