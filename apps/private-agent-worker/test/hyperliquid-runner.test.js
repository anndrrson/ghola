import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("Hyperliquid runner proves accepted outcomes and rejects ambiguous responses", () => {
  const runnerPath = resolve("src/venues/hyperliquid_runner.py");
  const source = `
import contextlib
import importlib.util
import io
import json
import time
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location("hyperliquid_runner", ${JSON.stringify(runnerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

resting = module.redact_result("submitted", {
    "status": "ok",
    "response": {"data": {"statuses": [{"resting": {"oid": 42}}]}},
}, "HYPE")
assert resting == {"status": "submitted", "oid": 42, "fills": []}

filled = module.redact_result("submitted", {
    "status": "ok",
    "response": {"data": {"statuses": [{"filled": {"oid": 43, "totalSz": "1", "avgPx": "10"}}]}},
}, "HYPE")
assert filled["status"] == "filled"
assert filled["oid"] == 43
assert filled["fills"][0]["sz"] == "1"

class FakeExchange:
    def __init__(self):
        self.calls = []
        self.expires_after = None
    def update_leverage(self, leverage, market, is_cross):
        self.calls.append((leverage, market, is_cross))
        return {"status": "ok"}
    def set_expires_after(self, value):
        self.expires_after = value

exchange = FakeExchange()
configured = module.configure_isolated_leverage(exchange, {
    "market": "HYPE", "margin_mode": "isolated", "leverage": 1,
})
assert exchange.calls == [(1, "HYPE", False)]
assert configured == {"margin_mode": "isolated", "leverage": 1, "venue_accepted": True}

live_prepare_events = []
original_resolve = module.resolve_limit_order
original_configure = module.configure_isolated_leverage
original_verify_book = module.verify_fresh_execution_book
try:
    def ordered_resolve(_info, _order, _address):
        live_prepare_events.append("resolve")
        return {"base_size": "0.18", "limit_price": "60", "size_decimals": 2}
    def ordered_configure(_exchange, _order):
        live_prepare_events.append("update_leverage")
        time.sleep(0.01)
        return {"margin_mode": "isolated", "leverage": 1, "venue_accepted": True}
    def ordered_verify(_info, _order, resolved, _address):
        live_prepare_events.append("final_market_gate")
        assert resolved["base_size"] == "0.18"
        return {"freshness_proven": True}
    module.resolve_limit_order = ordered_resolve
    module.configure_isolated_leverage = ordered_configure
    module.verify_fresh_execution_book = ordered_verify
    prepared = module.prepare_live_limit_order(object(), object(), {"market": "HYPE"}, "0x" + "a" * 40)
finally:
    module.resolve_limit_order = original_resolve
    module.configure_isolated_leverage = original_configure
    module.verify_fresh_execution_book = original_verify_book
assert live_prepare_events == ["resolve", "update_leverage", "final_market_gate"]
assert prepared[2] == {"freshness_proven": True}

expiry = int(time.time() * 1000) + 5000
configured_expiry = module.configure_action_expiry(exchange, {
    "expires_at": datetime.fromtimestamp(expiry / 1000, tz=timezone.utc).isoformat(),
})
assert configured_expiry == expiry
assert exchange.expires_after == expiry

class FakeAgentInfo:
    def __init__(self, valid_until):
        self.valid_until = valid_until
    def extra_agents(self, account):
        assert account == "0x" + "a" * 40
        return [{
            "name": "ghola-proof",
            "address": "0x" + "b" * 40,
            "validUntil": self.valid_until,
        }]

authorization = module.verify_api_wallet_authorization(
    FakeAgentInfo(int(time.time() * 1000) + 600000),
    "0x" + "a" * 40,
    "0x" + "b" * 40,
)
assert authorization["authorized"] is True

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.verify_api_wallet_authorization(
            FakeAgentInfo(int(time.time() * 1000) + 60000),
            "0x" + "a" * 40,
            "0x" + "b" * 40,
        )
    except SystemExit:
        pass
expired_agent = json.loads(output.getvalue())
assert expired_agent["error_code"] == "venue_access_required"
assert "expires too soon" in expired_agent["error"]

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.verify_api_wallet_authorization(
            FakeAgentInfo(int(time.time() * 1000) + 600000),
            "0x" + "a" * 40,
            "0x" + "a" * 40,
        )
    except SystemExit:
        pass
master_key = json.loads(output.getvalue())
assert master_key["error_code"] == "venue_access_required"
assert "master-wallet" in master_key["error"]

class FakeCloid:
    @staticmethod
    def from_str(value):
        assert value.startswith("0x") and len(value) == 34
        return value

class FakeProtectionInfo:
    def __init__(self, parent_oid=50):
        self.parent_oid = parent_oid
    def post(self, path, body):
        assert path == "/info"
        assert body["type"] == "orderStatus"
        child = body["oid"]
        if child == "0x" + "1" * 32:
            return {
                "status": "order",
                "order": {
                    "order": {
                        "coin": "HYPE",
                        "oid": self.parent_oid,
                        "cloid": child,
                        "origSz": "0.1",
                        "reduceOnly": False,
                    },
                    "status": "filled",
                },
            }
        return {
            "status": "order",
            "order": {
                "order": {
                    "coin": "HYPE",
                    "oid": 61 if child.endswith("09") else 62,
                    "cloid": child,
                    "reduceOnly": True,
                    "isTrigger": True,
                },
                "status": "open",
            },
        }

class FakeProtectedExchange:
    def __init__(self):
        self.orders = None
        self.grouping = None
    def bulk_orders(self, orders, grouping):
        self.orders = orders
        self.grouping = grouping
        return {
            "status": "ok",
            "response": {"data": {"statuses": [
                {"filled": {"oid": 50, "totalSz": "0.1", "avgPx": "100"}},
                {"resting": {"oid": 51}},
                {"resting": {"oid": 52}},
            ]}},
        }

protected_exchange = FakeProtectedExchange()
protected = module.submit_protected_limit_order(
    protected_exchange,
    FakeProtectionInfo(),
    "0x" + "a" * 40,
    {"market": "HYPE", "side": "buy", "reduce_only": False},
    {"base_size": "0.1", "limit_price": "100", "tif": "Ioc", "size_decimals": 2},
    {
        "mode": "normal_tpsl",
        "trigger_source": "mark",
        "take_profit_trigger_price": "110",
        "stop_loss_trigger_price": "95",
        "max_slippage_bps": "50",
    },
    "0x" + "1" * 32,
    FakeCloid,
)
assert protected_exchange.grouping == "normalTpsl"
assert len(protected_exchange.orders) == 3
assert protected_exchange.orders[1]["reduce_only"] is True
assert protected_exchange.orders[1]["order_type"]["trigger"]["tpsl"] == "tp"
assert protected_exchange.orders[2]["order_type"]["trigger"]["tpsl"] == "sl"
assert protected_exchange.orders[2]["limit_px"] < 95
assert protected["position_protection"]["venue_accepted"] is True
assert protected["venue_order_readback"] == {
    "verified": True,
    "status": "filled",
    "oid": 50,
    "cloid": "0x" + "1" * 32,
}
assert protected["position_protection"]["take_profit_oid"] == 61
assert protected["position_protection"]["stop_loss_oid"] == 62
assert protected["position_protection"]["take_profit_cloid"] != protected["position_protection"]["stop_loss_cloid"]
assert protected["position_protection"]["take_profit_cloid"] == "0x6d8f5b3364447cf319e70007e1e9bb09"
assert protected["position_protection"]["stop_loss_cloid"] == "0x5197b14ce6d43a2816442fd709b29006"

class FakeWaitingProtectedExchange(FakeProtectedExchange):
    def bulk_orders(self, orders, grouping):
        self.orders = orders
        self.grouping = grouping
        return {
            "status": "ok",
            "response": {"data": {"statuses": [
                {"filled": {"oid": 60, "totalSz": "0.1", "avgPx": "100"}},
                "waitingForFill",
                "waitingForTrigger",
            ]}},
        }

waiting_exchange = FakeWaitingProtectedExchange()
waiting_protected = module.submit_protected_limit_order(
    waiting_exchange,
    FakeProtectionInfo(60),
    "0x" + "a" * 40,
    {"market": "HYPE", "side": "buy", "reduce_only": False},
    {"base_size": "0.1", "limit_price": "100", "tif": "Ioc", "size_decimals": 2},
    {
        "mode": "normal_tpsl",
        "trigger_source": "mark",
        "take_profit_trigger_price": "110",
        "stop_loss_trigger_price": "95",
        "max_slippage_bps": "50",
    },
    "0x" + "1" * 32,
    FakeCloid,
)
assert waiting_protected["position_protection"]["take_profit_oid"] == 61
assert waiting_protected["position_protection"]["stop_loss_oid"] == 62

assert module.hyperliquid_perp_price_valid(module.Decimal("63034"), 5)
assert not module.hyperliquid_perp_price_valid(module.Decimal("63033.5"), 5)
assert module.hyperliquid_perp_price_valid(module.Decimal("56.365"), 2)
assert not module.hyperliquid_perp_price_valid(module.Decimal("56.3645"), 2)
assert module.quantize_hyperliquid_perp_price(module.Decimal("56.3645"), 2, module.ROUND_UP) == module.Decimal("56.365")

class FreshnessInfo:
    def __init__(self):
        self.calls = 0
    def post(self, path, body):
        assert path == "/info"
        assert body == {"type": "l2Book", "coin": "HYPE"}
        self.calls += 1
        return {
            "time": int(time.time() * 1000),
            "levels": [[{"px": "100"}], [{"px": "100.01"}]],
        }

freshness_info = FreshnessInfo()
freshness_gate = module.verify_fresh_execution_book(
    freshness_info,
    {"market": "HYPE", "side": "buy", "max_slippage_bps": "100"},
    {
        "execution_book": {
            "source_time_ms": int(time.time() * 1000) - 10_000,
            "best_bid": module.Decimal("99"),
            "best_ask": module.Decimal("100"),
        },
        "base_size": "0.11",
        "limit_price": "101",
    },
)
assert freshness_info.calls == 1
assert freshness_gate["freshness_proven"] is True
assert freshness_gate["source_age_ms"] <= module.EXECUTION_BOOK_MAX_AGE_MS

class ProofNotionalInfo:
    def meta(self):
        return {"universe": [{"name": "HYPE", "szDecimals": 2}]}
    def query_user_abstraction_state(self, _address):
        return "default"
    def user_state(self, _address):
        return {"marginSummary": {"accountValue": "1000"}, "withdrawable": "1000"}
    def post(self, path, body):
        assert path == "/info"
        if body == {"type": "l2Book", "coin": "HYPE"}:
            return {
                "time": int(time.time() * 1000),
                "levels": [[{"px": "58.743"}], [{"px": "58.744"}]],
            }
        assert body == {
            "type": "activeAssetData",
            "user": "0x" + "a" * 40,
            "coin": "HYPE",
        }
        return {
            "user": "0x" + "a" * 40,
            "coin": "HYPE",
            "markPx": "58.744",
        }

old_proof_order = {
    "market": "HYPE", "side": "buy", "order_type": "market",
    "quote_size": "10.5", "reduce_only": False, "max_slippage_bps": "100",
}
old_proof_resolved = module.resolve_limit_order(
    ProofNotionalInfo(), old_proof_order, "0x" + "a" * 40,
)
assert old_proof_resolved["base_size"] == "0.17"
assert old_proof_resolved["limit_price"] == "59.331"
output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.verify_fresh_execution_book(
            ProofNotionalInfo(), old_proof_order, old_proof_resolved, "0x" + "a" * 40,
        )
    except SystemExit:
        pass
old_proof_failure = json.loads(output.getvalue())
assert old_proof_failure["error_code"] == "venue_rejected"
assert "too close to the venue minimum notional" in old_proof_failure["error"]

new_proof_order = {**old_proof_order, "quote_size": "11"}
new_proof_resolved = module.resolve_limit_order(
    ProofNotionalInfo(), new_proof_order, "0x" + "a" * 40,
)
assert new_proof_resolved["base_size"] == "0.18"
assert new_proof_resolved["limit_price"] == "59.331"
new_proof_gate = module.verify_fresh_execution_book(
    ProofNotionalInfo(), new_proof_order, new_proof_resolved, "0x" + "a" * 40,
)
assert new_proof_gate["minimum_notional_proven"] is True

class DelayedActiveReferenceInfo:
    def post(self, path, body):
        assert path == "/info"
        if body.get("type") == "activeAssetData":
            return {
                "user": "0x" + "a" * 40,
                "coin": "HYPE",
                "markPx": "100",
            }
        time.sleep(0.01)
        return {
            "time": int(time.time() * 1000),
            "levels": [[{"px": "99.99"}], [{"px": "100"}]],
        }

previous_book_max_age = module.EXECUTION_BOOK_MAX_AGE_MS
module.EXECUTION_BOOK_MAX_AGE_MS = 5
try:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            module.verify_fresh_execution_book(
                DelayedActiveReferenceInfo(),
                {"market": "HYPE", "side": "buy", "max_slippage_bps": "50"},
                {"base_size": "0.11", "limit_price": "100.5"},
                "0x" + "a" * 40,
            )
        except SystemExit:
            pass
    delayed_reference_failure = json.loads(output.getvalue())
    assert delayed_reference_failure["error_code"] == "venue_rejected"
    assert "active market reference is stale" in delayed_reference_failure["error"]
finally:
    module.EXECUTION_BOOK_MAX_AGE_MS = previous_book_max_age

class FakePrecisionInfo:
    def meta(self):
        return {"universe": [{"name": "HYPE", "szDecimals": 2}]}
    def query_user_abstraction_state(self, _address):
        return "default"
    def user_state(self, _address):
        return {"marginSummary": {"accountValue": "1000"}, "withdrawable": "1000"}

class FakeUnfundedPrecisionInfo(FakePrecisionInfo):
    def user_state(self, _address):
        return {"marginSummary": {"accountValue": "0"}, "withdrawable": "0"}

unfunded_order = {
    "market": "HYPE",
    "side": "buy",
    "order_type": "limit",
    "live_order_mode": "full_ticket",
    "base_size": "0.19",
    "limit_price": "56.365",
    "tif": "Ioc",
}
no_submit_unfunded = module.resolve_limit_order(
    FakeUnfundedPrecisionInfo(),
    unfunded_order,
    "0x" + "a" * 40,
    require_funds=False,
)
assert no_submit_unfunded["account_state_checked"] is True

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.resolve_limit_order(
            FakeUnfundedPrecisionInfo(),
            unfunded_order,
            "0x" + "a" * 40,
        )
    except SystemExit:
        pass
live_unfunded_failure = json.loads(output.getvalue())
assert live_unfunded_failure["error_code"] == "venue_rejected"
assert "insufficient available value" in live_unfunded_failure["error"]

valid_order = module.resolve_limit_order(FakePrecisionInfo(), {
    "market": "HYPE",
    "side": "buy",
    "order_type": "limit",
    "live_order_mode": "full_ticket",
    "base_size": "0.19",
    "quote_size": "10.71",
    "limit_price": "56.365",
    "tif": "Ioc",
}, "0x" + "a" * 40)
assert valid_order["size_decimals"] == 2

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.resolve_limit_order(FakePrecisionInfo(), {
            "market": "HYPE",
            "side": "buy",
            "order_type": "limit",
            "live_order_mode": "full_ticket",
            "base_size": "0.17",
            "limit_price": "56.365",
            "tif": "Ioc",
        }, "0x" + "a" * 40)
    except SystemExit:
        pass
minimum_failure = json.loads(output.getvalue())
assert minimum_failure["error_code"] == "venue_rejected"
assert "minimum notional" in minimum_failure["error"]

class FakeReduceInfo(FakePrecisionInfo):
    def query_user_abstraction_state(self, _address):
        raise AssertionError("reduce-only must not query account abstraction")
    def user_state(self, _address):
        raise AssertionError("reduce-only must not require opening margin")

reduce_only = module.resolve_limit_order(FakeReduceInfo(), {
    "market": "HYPE",
    "side": "sell",
    "order_type": "limit",
    "live_order_mode": "full_ticket",
    "base_size": "0.01",
    "limit_price": "56.365",
    "reduce_only": True,
    "tif": "Ioc",
}, "0x" + "a" * 40)
assert reduce_only["base_size"] == "0.01"
assert reduce_only["account_state_checked"] is True

class FakeMarketExitInfo(FakeReduceInfo):
    def post(self, path, body):
        assert path == "/info"
        assert body == {"type": "l2Book", "coin": "HYPE"}
        return {
            "time": int(time.time() * 1000) - 100,
            "levels": [
                [{"px": "56.99", "sz": "1", "n": 1}],
                [{"px": "57", "sz": "1", "n": 1}],
            ],
        }

market_exit = module.resolve_limit_order(FakeMarketExitInfo(), {
    "market": "HYPE",
    "side": "sell",
    "order_type": "market",
    "live_order_mode": "tiny_fill",
    "base_size": "0.18",
    "reduce_only": True,
    "max_slippage_bps": "100",
}, "0x" + "a" * 40)
assert market_exit["base_size"] == "0.18"
assert market_exit["tif"] == "Ioc"
assert module.Decimal(market_exit["limit_price"]) < module.Decimal("56.99")
assert market_exit["account_state_checked"] is True
market_exit_gate = module.verify_fresh_execution_book(
    FakeMarketExitInfo(),
    {"market": "HYPE", "side": "sell", "reduce_only": True, "max_slippage_bps": "100"},
    market_exit,
)
assert market_exit_gate["slippage_bound_proven"] is True

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.resolve_limit_order(FakePrecisionInfo(), {
            "market": "HYPE",
            "side": "buy",
            "order_type": "limit",
            "live_order_mode": "full_ticket",
            "base_size": "0.191",
            "quote_size": "10.77",
            "limit_price": "56.3645",
            "tif": "Ioc",
        }, "0x" + "a" * 40)
    except SystemExit:
        pass
precision_failure = json.loads(output.getvalue())
assert precision_failure["error_code"] == "venue_rejected"
assert "tick precision" in precision_failure["error"]

class FakeInfo:
    def __init__(self, age_ms=350):
        self.age_ms = age_ms
    def post(self, path, body):
        assert path == "/info"
        assert body == {"type": "l2Book", "coin": "HYPE"}
        return {
            "time": int(time.time() * 1000) - self.age_ms,
            "levels": [
                [{"px": "99", "sz": "1", "n": 1}],
                [{"px": "101", "sz": "1", "n": 1}],
            ],
        }

market_gate = module.verify_fresh_execution_book(
    FakeInfo(),
    {"market": "HYPE", "side": "buy", "max_slippage_bps": "50"},
    {"base_size": "0.11", "limit_price": "101.5"},
)
assert market_gate["freshness_proven"] is True
assert market_gate["slippage_bound_proven"] is True
assert market_gate["source_age_ms"] <= 2000

class RepricedMarketInfo:
    def __init__(self, ask="90", bid="89"):
        self.ask = ask
        self.bid = bid
    def post(self, path, body):
        assert path == "/info"
        assert body == {"type": "l2Book", "coin": "HYPE"}
        return {
            "time": int(time.time() * 1000),
            "levels": [[{"px": self.bid}], [{"px": self.ask}]],
        }

repriced_resolution = {
    "base_size": "0.12",
    "limit_price": "91",
    "size_decimals": 2,
}
module.verify_fresh_execution_book(
    RepricedMarketInfo(),
    {
        "market": "HYPE", "side": "buy", "order_type": "market",
        "quote_size": "11", "max_slippage_bps": "50",
    },
    repriced_resolution,
)
assert repriced_resolution["limit_price"] == "90.45"

base_opening_resolution = {
    "base_size": "0.12",
    "limit_price": "90.4",
    "size_decimals": 2,
}
module.verify_fresh_execution_book(
    RepricedMarketInfo(),
    {
        "market": "HYPE", "side": "buy", "order_type": "market",
        "base_size": "0.12", "max_slippage_bps": "50",
    },
    base_opening_resolution,
)
assert base_opening_resolution["limit_price"] == "90.4"

reduce_only_resolution = {
    "base_size": "0.11",
    "limit_price": "88.6",
    "size_decimals": 2,
}
module.verify_fresh_execution_book(
    RepricedMarketInfo(),
    {
        "market": "HYPE", "side": "sell", "order_type": "market",
        "base_size": "0.11", "reduce_only": True, "max_slippage_bps": "50",
    },
    reduce_only_resolution,
)
assert reduce_only_resolution["limit_price"] == "88.555"

explicit_limit_resolution = {
    "base_size": "0.12",
    "limit_price": "90.4",
    "size_decimals": 2,
}
module.verify_fresh_execution_book(
    RepricedMarketInfo(),
    {
        "market": "HYPE", "side": "buy", "order_type": "limit",
        "base_size": "0.12", "max_slippage_bps": "50",
    },
    explicit_limit_resolution,
)
assert explicit_limit_resolution["limit_price"] == "90.4"

output = io.StringIO()
lot_boundary_resolution = {"base_size": "0.12", "limit_price": "91", "size_decimals": 2}
with contextlib.redirect_stdout(output):
    try:
        module.verify_fresh_execution_book(
            RepricedMarketInfo("80", "79"),
            {
                "market": "HYPE", "side": "buy", "order_type": "market",
                "quote_size": "11", "max_slippage_bps": "50",
            },
            lot_boundary_resolution,
        )
    except SystemExit:
        pass
lot_boundary_failure = json.loads(output.getvalue())
assert lot_boundary_failure["error_code"] == "venue_rejected"
assert "lot boundary" in lot_boundary_failure["error"]
assert lot_boundary_resolution["limit_price"] == "91"

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.verify_fresh_execution_book(
            FakeInfo(2501),
            {"market": "HYPE", "side": "buy", "max_slippage_bps": "50"},
            {"base_size": "0.11", "limit_price": "101.5"},
        )
    except SystemExit:
        pass
stale_failure = json.loads(output.getvalue())
assert stale_failure["error_code"] == "venue_rejected"
assert "stale" in stale_failure["error"]

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.verify_fresh_execution_book(
            FakeInfo(),
            {"market": "HYPE", "side": "buy", "max_slippage_bps": "50"},
            {"base_size": "0.099", "limit_price": "101.5"},
        )
    except SystemExit:
        pass
minimum_notional_failure = json.loads(output.getvalue())
assert minimum_notional_failure["error_code"] == "venue_rejected"
assert "too close to the venue minimum notional" in minimum_notional_failure["error"]

class ExactMinimumInfo:
    def post(self, path, body):
        assert path == "/info"
        assert body == {"type": "l2Book", "coin": "HYPE"}
        return {
            "time": int(time.time() * 1000),
            "levels": [[{"px": "99.99"}], [{"px": "100"}]],
        }

exact_minimum_gate = module.verify_fresh_execution_book(
    ExactMinimumInfo(),
    {"market": "HYPE", "side": "buy", "max_slippage_bps": "50"},
    {"base_size": "0.1005", "limit_price": "100.5"},
)
assert exact_minimum_gate["minimum_notional_proven"] is True

for unsafe_base in ("0.100499", "NaN"):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            module.verify_fresh_execution_book(
                ExactMinimumInfo(),
                {"market": "HYPE", "side": "buy", "max_slippage_bps": "50"},
                {"base_size": unsafe_base, "limit_price": "100.5"},
            )
        except SystemExit:
            pass
    unsafe_minimum = json.loads(output.getvalue())
    assert unsafe_minimum["error_code"] == "venue_rejected"

reduce_only_minimum_gate = module.verify_fresh_execution_book(
    ExactMinimumInfo(),
    {"market": "HYPE", "side": "sell", "reduce_only": True, "max_slippage_bps": "50"},
    {"base_size": "0.01", "limit_price": "99.5"},
)
assert reduce_only_minimum_gate["minimum_notional_proven"] is True

cancel_target = "0x" + "7" * 32

class FakeCancelInfo:
    def __init__(self, status="open", returned_cloid=cancel_target):
        self.status = status
        self.returned_cloid = returned_cloid
    def post(self, path, body):
        assert path == "/info"
        assert body == {"type": "orderStatus", "user": "0x" + "a" * 40, "oid": cancel_target}
        return {
            "status": "order",
            "order": {
                "order": {"coin": "HYPE", "oid": 77, "cloid": self.returned_cloid},
                "status": self.status,
            },
        }

class FakeCancelExchange:
    def __init__(self, info):
        self.info = info
        self.calls = []
    def cancel_by_cloid(self, market, cloid):
        self.calls.append((market, cloid))
        self.info.status = "canceled"
        return {"status": "ok", "response": {"data": {"statuses": ["success"]}}}

cancel_info = FakeCancelInfo()
cancel_exchange = FakeCancelExchange(cancel_info)
cancel_proof = module.cancel_by_cloid_with_readback(
    cancel_exchange, cancel_info, "0x" + "a" * 40, "HYPE", cancel_target, FakeCloid,
)
assert cancel_exchange.calls == [("HYPE", cancel_target)]
assert cancel_proof["broadcast_performed"] is True
assert cancel_proof["venue_cancel_readback"]["status"] == "canceled"

already_canceled_info = FakeCancelInfo("canceled")
already_canceled_exchange = FakeCancelExchange(already_canceled_info)
already_canceled = module.cancel_by_cloid_with_readback(
    already_canceled_exchange,
    already_canceled_info,
    "0x" + "a" * 40,
    "HYPE",
    cancel_target,
    FakeCloid,
)
assert already_canceled_exchange.calls == []
assert already_canceled["broadcast_performed"] is False

reduce_only_canceled_info = FakeCancelInfo("reduceOnlyCanceled")
reduce_only_canceled_exchange = FakeCancelExchange(reduce_only_canceled_info)
reduce_only_canceled = module.cancel_by_cloid_with_readback(
    reduce_only_canceled_exchange,
    reduce_only_canceled_info,
    "0x" + "a" * 40,
    "HYPE",
    cancel_target,
    FakeCloid,
)
assert reduce_only_canceled_exchange.calls == []
assert reduce_only_canceled["broadcast_performed"] is False
assert reduce_only_canceled["venue_cancel_readback"]["status"] == "canceled"

class FakeCancelRaceExchange:
    def __init__(self, info):
        self.info = info
        self.calls = []
    def cancel_by_cloid(self, market, cloid):
        self.calls.append((market, cloid))
        self.info.status = "reduceOnlyCanceled"
        return {
            "status": "ok",
            "response": {"data": {"statuses": [{
                "error": "Order was never placed, already canceled, or filled."
            }]}},
        }

race_info = FakeCancelInfo()
race_exchange = FakeCancelRaceExchange(race_info)
race_proof = module.cancel_by_cloid_with_readback(
    race_exchange, race_info, "0x" + "a" * 40, "HYPE", cancel_target, FakeCloid,
)
assert race_exchange.calls == [("HYPE", cancel_target)]
assert race_proof["broadcast_performed"] is False
assert race_proof["venue_cancel_readback"]["status"] == "canceled"

bad_info = FakeCancelInfo("open", "0x" + "6" * 32)
output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.cancel_by_cloid_with_readback(
            FakeCancelExchange(bad_info), bad_info, "0x" + "a" * 40, "HYPE", cancel_target, FakeCloid,
        )
    except SystemExit:
        pass
bad_cancel = json.loads(output.getvalue())
assert bad_cancel["error_code"] == "venue_rejected"
assert "readback" in bad_cancel["error"]

cancelled = module.redact_result("cancelled", {
    "status": "ok",
    "response": {"data": {"statuses": ["success"]}},
})
assert cancelled == {"status": "cancelled", "oid": None, "fills": []}

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.redact_result("submitted", {
            "status": "ok",
            "response": {"data": {"statuses": [{"error": "minimum order value"}]}},
        })
    except SystemExit:
        pass
failure = json.loads(output.getvalue())
assert failure["status"] == "failed"
assert failure["error_code"] == "venue_rejected"
assert "minimum order value" in failure["error"]
`;
  const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", source], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Hyperliquid runner selects collateral by account abstraction mode and fails closed", () => {
  const runnerPath = resolve("src/venues/hyperliquid_runner.py");
  const source = `
import contextlib
import importlib.util
import io
import json

spec = importlib.util.spec_from_file_location("hyperliquid_runner", ${JSON.stringify(runnerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ACCOUNT = "0x" + "a" * 40

def rejection(info, quote="10", side="buy", base_size="0.2"):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            module.check_account_value(
                info,
                ACCOUNT,
                module.Decimal(quote),
                "HYPE",
                side,
                module.Decimal(base_size),
            )
        except SystemExit:
            pass
        else:
            raise AssertionError("expected account preflight rejection")
    return json.loads(output.getvalue())

class StandardInfo:
    def __init__(self, mode, withdrawable):
        self.mode = mode
        self.withdrawable = withdrawable
        self.calls = []
    def query_user_abstraction_state(self, address):
        self.calls.append(("abstraction", address))
        return self.mode
    def user_state(self, address):
        self.calls.append(("perp", address))
        return {"withdrawable": self.withdrawable}
    def spot_user_state(self, _address):
        raise AssertionError("standard mode must not query spot collateral")

for standard_mode in ("default", "disabled"):
    standard = StandardInfo(standard_mode, "10.0100000000000000000001")
    assert module.check_account_value(
        standard, ACCOUNT, module.Decimal("10"), "HYPE", "buy", module.Decimal("0.2")
    ) is True
    assert standard.calls == [("abstraction", ACCOUNT), ("perp", ACCOUNT)]

standard_short = StandardInfo("default", "10.0099999999999999999999")
standard_failure = rejection(standard_short)
assert standard_failure["error_code"] == "venue_rejected"
assert "insufficient" in standard_failure["error"]
assert standard_short.calls == [("abstraction", ACCOUNT), ("perp", ACCOUNT)]

def active_asset(available=None, max_sizes=None, leverage=None, user=ACCOUNT, coin="HYPE"):
    return {
        "user": user,
        "coin": coin,
        "leverage": leverage if leverage is not None else {"type": "isolated", "value": 1, "rawUsd": "-1.25"},
        "availableToTrade": available if available is not None else ["10.01", "0"],
        "maxTradeSzs": max_sizes if max_sizes is not None else ["0.2", "0"],
    }

class UnifiedInfo:
    def __init__(self, balances, active=None):
        self.balances = balances
        self.active = active_asset() if active is None else active
        self.calls = []
    def query_user_abstraction_state(self, address):
        self.calls.append(("abstraction", address))
        return "unifiedAccount"
    def spot_user_state(self, address):
        self.calls.append(("spot", address))
        return {"balances": self.balances}
    def post(self, path, body):
        self.calls.append(("active", path, body))
        assert path == "/info"
        assert body == {"type": "activeAssetData", "user": ACCOUNT, "coin": "HYPE"}
        return self.active
    def user_state(self, _address):
        raise AssertionError("unified mode must not query perp withdrawable")

unified = UnifiedInfo([
    {"coin": "HYPE", "token": 150, "total": "200", "hold": "0"},
    {
        "coin": "USDC",
        "token": 0,
        "total": "10.01000000000000000000000000000000000000009",
        "hold": "0.00000000000000000000000000000000000000008",
    },
])
assert module.check_account_value(
    unified, ACCOUNT, module.Decimal("10"), "HYPE", "buy", module.Decimal("0.2")
) is True
assert unified.calls == [
    ("abstraction", ACCOUNT),
    ("spot", ACCOUNT),
    ("active", "/info", {"type": "activeAssetData", "user": ACCOUNT, "coin": "HYPE"}),
]

held = UnifiedInfo([
    {
        "coin": "USDC",
        "token": 0,
        "total": "10.01000000000000000000000000000000000000007",
        "hold": "0.00000000000000000000000000000000000000008",
    },
])
held_failure = rejection(held)
assert "insufficient" in held_failure["error"]

missing_usdc = UnifiedInfo([
    {"coin": "HYPE", "token": 150, "total": "200", "hold": "0"},
])
assert "insufficient" in rejection(missing_usdc)["error"]

sell = UnifiedInfo(
    [{"coin": "USDC", "token": 0, "total": "20", "hold": "0"}],
    active_asset(available=["0", "10.01"], max_sizes=["0", "0.2"]),
)
assert module.check_account_value(
    sell, ACCOUNT, module.Decimal("10"), "HYPE", "sell", module.Decimal("0.2")
) is True

wrong_buy_index = UnifiedInfo(
    [{"coin": "USDC", "token": 0, "total": "20", "hold": "0"}],
    active_asset(available=["10.00999999999999999999999999999", "20"]),
)
assert "active market has insufficient" in rejection(wrong_buy_index)["error"]

wrong_sell_index = UnifiedInfo(
    [{"coin": "USDC", "token": 0, "total": "20", "hold": "0"}],
    active_asset(available=["20", "10.00999999999999999999999999999"], max_sizes=["1", "1"]),
)
assert "active market has insufficient" in rejection(wrong_sell_index, side="sell")["error"]

max_size_short = UnifiedInfo(
    [{"coin": "USDC", "token": 0, "total": "20", "hold": "0"}],
    active_asset(max_sizes=["0.19999999999999999999999999999", "0"]),
)
assert "maximum size" in rejection(max_size_short)["error"]

for leverage in ({"type": "cross", "value": 1}, {"type": "isolated", "value": 2, "rawUsd": "0"}):
    wrong_leverage = UnifiedInfo(
        [{"coin": "USDC", "token": 0, "total": "20", "hold": "0"}],
        active_asset(leverage=leverage),
    )
    assert "isolated 1x" in rejection(wrong_leverage)["error"]

malformed_active_states = [
    {},
    active_asset(user="not-an-address"),
    active_asset(user="0x" + "b" * 40),
    active_asset(coin="BTC"),
    active_asset(leverage={"type": "isolated", "value": "1"}),
    active_asset(leverage={"type": "isolated", "value": 1}),
    active_asset(leverage={"type": "isolated", "value": 1, "rawUsd": "NaN"}),
    active_asset(available=["20"]),
    active_asset(available=["20", 20]),
    active_asset(available=["20", "-1"]),
    active_asset(max_sizes=["1"]),
    active_asset(max_sizes=["NaN", "1"]),
]
for active in malformed_active_states:
    malformed_active = UnifiedInfo(
        [{"coin": "USDC", "token": 0, "total": "20", "hold": "0"}],
        active,
    )
    assert rejection(malformed_active)["error"] == "hyperliquid account state unavailable"

class ModeOnlyInfo:
    def __init__(self, mode):
        self.mode = mode
        self.calls = []
    def query_user_abstraction_state(self, address):
        self.calls.append(("abstraction", address))
        return self.mode
    def user_state(self, _address):
        raise AssertionError("unsupported mode must not query perp collateral")
    def spot_user_state(self, _address):
        raise AssertionError("unsupported mode must not query spot collateral")

portfolio = ModeOnlyInfo("portfolioMargin")
portfolio_failure = rejection(portfolio)
assert "portfolio margin" in portfolio_failure["error"]
assert portfolio.calls == [("abstraction", ACCOUNT)]

for unsupported_mode in ("dexAbstraction", "futureMode", None, {"mode": "unifiedAccount"}):
    unsupported = ModeOnlyInfo(unsupported_mode)
    unsupported_failure = rejection(unsupported)
    assert unsupported_failure["error_code"] == "venue_rejected"
    assert "unsupported" in unsupported_failure["error"] or "unavailable" in unsupported_failure["error"]
    assert unsupported.calls == [("abstraction", ACCOUNT)]

malformed_spot_states = [
    None,
    {},
    {"balances": "not-a-list"},
    {"balances": [None]},
    {"balances": [
        {"coin": "USDC", "token": 0, "total": "10.02", "hold": "0"},
        {"coin": "USDC", "token": 0, "total": "10.02", "hold": "0"},
    ]},
    {"balances": [{"coin": "USDC", "token": 9, "total": "10.02", "hold": "0"}]},
    {"balances": [{"coin": "USDC", "token": 0, "total": "10", "hold": "10.01"}]},
    {"balances": [{"coin": "USDC", "token": 0, "total": "NaN", "hold": "0"}]},
    {"balances": [{"coin": "USDC", "token": 0, "total": "1e100000000", "hold": "0"}]},
]

class MalformedUnifiedInfo(UnifiedInfo):
    def __init__(self, state):
        self.state = state
        self.calls = []
    def spot_user_state(self, address):
        self.calls.append(("spot", address))
        return self.state

for state in malformed_spot_states:
    malformed = MalformedUnifiedInfo(state)
    malformed_failure = rejection(malformed)
    assert malformed_failure["error"] == "hyperliquid account state unavailable"

class ApiFallbackInfo:
    def __init__(self):
        self.calls = []
    def post(self, path, body):
        self.calls.append((path, body))
        if body["type"] == "userAbstraction":
            return "unifiedAccount"
        if body["type"] == "spotClearinghouseState":
            return {"balances": [
                {"coin": "USDC", "token": 0, "total": "10.02", "hold": "0.01"},
            ]}
        if body["type"] == "activeAssetData":
            return active_asset()
        raise AssertionError("unexpected info request")

fallback = ApiFallbackInfo()
assert module.check_account_value(
    fallback, ACCOUNT, module.Decimal("10"), "HYPE", "buy", module.Decimal("0.2")
) is True
assert fallback.calls == [
    ("/info", {"type": "userAbstraction", "user": ACCOUNT}),
    ("/info", {"type": "spotClearinghouseState", "user": ACCOUNT}),
    ("/info", {"type": "activeAssetData", "user": ACCOUNT, "coin": "HYPE"}),
]

class TinyOrderingInfo:
    def __init__(self):
        self.calls = []
    def all_mids(self):
        self.calls.append("mids")
        return {"HYPE": "100"}
    def meta(self):
        self.calls.append("meta")
        return {"universe": [{"name": "HYPE", "szDecimals": 2}]}
    def query_user_abstraction_state(self, _address):
        self.calls.append("abstraction")
        return "default"
    def user_state(self, _address):
        self.calls.append("perp")
        return {"withdrawable": "20"}

tiny_info = TinyOrderingInfo()
tiny = module.resolve_limit_order(tiny_info, {
    "market": "HYPE",
    "side": "buy",
    "order_type": "limit",
    "live_order_mode": "tiny_fill",
    "quote_size": "10.1",
    "max_slippage_bps": "50",
}, ACCOUNT)
assert tiny["base_size"] == "0.1"
assert tiny_info.calls == ["mids", "meta", "abstraction", "perp"]
`;
  const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", source], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
