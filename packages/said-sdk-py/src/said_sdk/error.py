from __future__ import annotations

from typing import Optional


class SAIDError(Exception):
    """Base exception for the SAID SDK."""

    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        code: Optional[str] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
