"""Passphrase-encrypted cloud credentials. The passphrase is never persisted."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

PROVIDERS = {"openai", "anthropic", "deepseek", "kimi", "groq", "mistral"}


def cipher(passphrase: str, salt: bytes) -> Fernet:
    if len(passphrase) < 8:
        raise ValueError("Passphrase must contain at least 8 characters")
    key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(passphrase.encode())
    return Fernet(base64.urlsafe_b64encode(key))


class KeyVault:
    def __init__(self, workspace: Path):
        self.path = workspace / ".unum" / "ai_keys.enc"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def providers(self) -> list[str]:
        if not self.path.is_file():
            return []
        return json.loads(self.path.read_text())["providers"]

    def _read(self, passphrase: str) -> tuple[bytes, dict]:
        if not self.path.is_file():
            salt = os.urandom(16)
            cipher(passphrase, salt)
            return salt, {}
        envelope = json.loads(self.path.read_text())
        salt = base64.b64decode(envelope["salt"])
        try:
            values = json.loads(cipher(passphrase, salt).decrypt(envelope["ciphertext"].encode()))
        except InvalidToken as exc:
            raise ValueError("Incorrect vault passphrase") from exc
        return salt, values

    def save(self, provider: str, api_key: str, passphrase: str) -> list[str]:
        if provider not in PROVIDERS or not api_key or len(api_key) > 4096:
            raise ValueError("Invalid provider or API key")
        salt, values = self._read(passphrase)
        values[provider] = api_key
        encrypted = cipher(passphrase, salt).encrypt(json.dumps(values).encode()).decode()
        envelope = {"version": 1, "salt": base64.b64encode(salt).decode(), "ciphertext": encrypted, "providers": sorted(values)}
        temporary = self.path.with_suffix(".tmp")
        descriptor = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(envelope, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.path)
        os.chmod(self.path, 0o600)
        return sorted(values)

    def get(self, provider: str, passphrase: str) -> str:
        if provider not in PROVIDERS:
            raise ValueError("Unknown provider")
        _, values = self._read(passphrase)
        if provider not in values:
            raise ValueError("Provider key is not configured")
        return values[provider]
