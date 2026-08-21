import contextlib
import importlib.util
import io
import unittest
from pathlib import Path


RUNNER_PATH = Path(__file__).parents[1] / "src" / "venues" / "hyperliquid_runner.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("hyperliquid_runner", RUNNER_PATH)
hyperliquid_runner = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(hyperliquid_runner)


class FakeInfo:
    def all_mids(self):
        return {"HYPE": "50"}

    def meta(self):
        return {"universe": [{"name": "HYPE", "szDecimals": 2}]}

    def user_state(self, _account_address):
        return {"marginSummary": {"accountValue": "0"}}


class HyperliquidNoSubmitFundingTest(unittest.TestCase):
    def setUp(self):
        self.order = {
            "market": "HYPE",
            "side": "buy",
            "quote_size": "5",
            "max_slippage_bps": "50",
            "live_order_mode": "tiny_fill",
        }

    def test_no_submit_checks_account_without_requiring_funds(self):
        resolved = hyperliquid_runner.resolve_limit_order(
            FakeInfo(), self.order, "0xowner", require_funds=False
        )

        self.assertTrue(resolved["account_state_checked"])
        self.assertEqual(resolved["tif"], "Ioc")

    def test_submit_still_rejects_insufficient_funds(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                hyperliquid_runner.resolve_limit_order(FakeInfo(), self.order, "0xowner")


if __name__ == "__main__":
    unittest.main()
