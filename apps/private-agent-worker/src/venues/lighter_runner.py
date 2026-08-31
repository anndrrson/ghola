#!/usr/bin/env python3
import asyncio
import csv
import io
import ipaddress
import json
import socket
import sys
from decimal import Decimal, ROUND_DOWN
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


def fail(message, code="connector_submit_failed"):
    print(json.dumps({"error": message, "error_code": code}))
    raise SystemExit(1)


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


def orders_from_response(response):
    orders = as_dict(response).get("orders")
    if not isinstance(orders, list):
        fail("lighter order read is invalid")
    return orders


async def exact_account_order(client, account_index, market_index, client_order_index, *, include_inactive):
    auth = await auth_token(client)
    active_response = await client.order_api.account_active_orders(
        account_index=int(account_index),
        market_id=int(market_index),
        authorization=auth,
    )
    target = exact_market_order(
        orders_from_response(active_response),
        client_order_index,
        market_index,
    )
    if target is not None or not include_inactive:
        return target
    inactive_response = await client.order_api.account_inactive_orders(
        account_index=int(account_index),
        limit=100,
        authorization=auth,
        market_id=int(market_index),
    )
    return exact_market_order(
        orders_from_response(inactive_response),
        client_order_index,
        market_index,
    )


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
            return {"order": order, "target_market_checked": True}
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
            return {"funding_rows": rows, "market_id": int(market.market_id), "symbol": str(market.symbol)}
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
