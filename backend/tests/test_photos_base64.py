"""
CD Trofense — Photos stored in Supabase Storage (metadata in Postgres).

Covers:
- POST /api/athletes/{aid}/photos → doc created with content_type + size,
  response does NOT include storage_path.
- GET /api/athletes/{aid}/photos → payload never contains storage_path.
- GET /api/photos/{pid}/download → returns correct JPEG/PNG magic bytes,
  accepts ?auth=<token> and cookie auth.
- PUT /api/photos/{pid}/replace → next download returns the new image.
- DELETE /api/photos/{pid} → subsequent download returns 404.
- Upload >10MB → 413.
"""

import io
import os
import struct
import uuid
import zlib

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@trofense.pt"
ADMIN_PWD = "Trofense2026!"


# ---------- helpers ----------
def _make_jpeg(w: int = 8, h: int = 8, color: int = 0x80) -> bytes:
    """Return a minimal valid JPEG. Uses a precomputed 8x8 grey JPEG and
    ignores w/h (only needs to be a valid parsable JPEG for tests)."""
    # Minimal JPEG (grey 1x1 pixel image). Trusted magic bytes 0xFFD8FF.
    return bytes([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
        0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
        0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
        0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
        0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
        0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
        0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
        0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03,
        0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D,
        0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
        0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08,
        0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72,
        0x82, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFB,
        0xD0, 0xFF, 0xD9,
    ])


def _make_png() -> bytes:
    """Return a minimal valid PNG (1x1 red pixel). Magic bytes 89 50 4E 47."""
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(typ: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + typ + data + struct.pack(
            ">I", zlib.crc32(typ + data) & 0xFFFFFFFF
        )

    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    raw = b"\x00\xff\x00\x00"  # filter byte + one RGB pixel
    idat = chunk(b"IDAT", zlib.compress(raw))
    iend = chunk(b"IEND", b"")
    return sig + ihdr + idat + iend


# ---------- fixtures ----------
@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def admin_auth(api_client):
    r = api_client.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PWD},
    )
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    data = r.json()
    token = data["token"]
    api_client.headers.update({"Authorization": f"Bearer {token}"})
    return {"token": token, "id": data["user"]["id"], "cookies": r.cookies}


@pytest.fixture(scope="session")
def athlete_id(api_client, admin_auth):
    r = api_client.get(f"{BASE_URL}/api/athletes")
    assert r.status_code == 200
    athletes = r.json()
    assert athletes, "No athletes available in DB for testing"
    return athletes[0]["id"]


# ---------- Tests ----------
class TestPhotoUpload:
    def test_upload_creates_doc_without_base64_in_response(
        self, api_client, admin_auth, athlete_id
    ):
        jpeg = _make_jpeg()
        # multipart upload — clear Content-Type header from session
        headers = {"Authorization": f"Bearer {admin_auth['token']}"}
        files = {"file": ("test.jpg", io.BytesIO(jpeg), "image/jpeg")}
        data = {"date": "2026-01-10", "kind": "profile"}
        r = requests.post(
            f"{BASE_URL}/api/athletes/{athlete_id}/photos",
            headers=headers, files=files, data=data,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "id" in body
        assert body["content_type"] == "image/jpeg"
        assert body["size"] == len(jpeg)
        assert body["kind"] == "profile"
        assert "storage_path" not in body, "Response must NOT include storage_path"
        # save for further tests
        TestPhotoUpload._uploaded_id = body["id"]

    def test_list_photos_does_not_return_base64(
        self, api_client, admin_auth, athlete_id
    ):
        r = api_client.get(f"{BASE_URL}/api/athletes/{athlete_id}/photos")
        assert r.status_code == 200
        photos = r.json()
        assert isinstance(photos, list)
        assert len(photos) > 0, "expected at least the freshly-uploaded photo"
        for p in photos:
            assert "storage_path" not in p, f"storage_path leaked in list payload for {p.get('id')}"
            # essential fields
            assert "id" in p
            assert "kind" in p

    def test_upload_too_large_returns_413(self, api_client, admin_auth, athlete_id):
        # 11 MB payload
        big = b"\xff" * (11 * 1024 * 1024)
        headers = {"Authorization": f"Bearer {admin_auth['token']}"}
        files = {"file": ("big.jpg", io.BytesIO(big), "image/jpeg")}
        data = {"date": "2026-01-10", "kind": "profile"}
        r = requests.post(
            f"{BASE_URL}/api/athletes/{athlete_id}/photos",
            headers=headers, files=files, data=data,
        )
        assert r.status_code == 413, f"Expected 413, got {r.status_code}: {r.text[:200]}"


class TestPhotoDownload:
    def test_download_returns_jpeg_bytes(self, api_client, admin_auth, athlete_id):
        pid = getattr(TestPhotoUpload, "_uploaded_id", None)
        assert pid, "upload test must run first"
        # Bearer auth via header
        r = requests.get(
            f"{BASE_URL}/api/photos/{pid}/download",
            headers={"Authorization": f"Bearer {admin_auth['token']}"},
        )
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("image/jpeg")
        # JPEG magic bytes: FF D8 FF
        assert r.content[:3] == b"\xff\xd8\xff", (
            f"Not a JPEG. First bytes: {r.content[:6].hex()}"
        )

    def test_download_via_query_token(self, api_client, admin_auth, athlete_id):
        pid = getattr(TestPhotoUpload, "_uploaded_id", None)
        assert pid
        # Fresh session without auth headers/cookies
        s = requests.Session()
        r = s.get(f"{BASE_URL}/api/photos/{pid}/download?auth={admin_auth['token']}")
        assert r.status_code == 200
        assert r.content[:3] == b"\xff\xd8\xff"

    def test_download_via_cookie(self, api_client, admin_auth, athlete_id):
        pid = getattr(TestPhotoUpload, "_uploaded_id", None)
        assert pid
        s = requests.Session()
        # Login to set cookie
        lr = s.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PWD},
        )
        assert lr.status_code == 200
        # No auth header/query — must use cookie
        r = s.get(f"{BASE_URL}/api/photos/{pid}/download")
        assert r.status_code == 200, r.text[:200]
        assert r.content[:3] == b"\xff\xd8\xff"

    def test_download_unauthorized_returns_401(self):
        pid = getattr(TestPhotoUpload, "_uploaded_id", None)
        assert pid
        s = requests.Session()
        r = s.get(f"{BASE_URL}/api/photos/{pid}/download")
        assert r.status_code == 401


class TestPhotoReplace:
    def test_replace_returns_new_bytes(self, api_client, admin_auth, athlete_id):
        pid = getattr(TestPhotoUpload, "_uploaded_id", None)
        assert pid, "upload test must run first"
        png = _make_png()
        headers = {"Authorization": f"Bearer {admin_auth['token']}"}
        files = {"file": ("replacement.png", io.BytesIO(png), "image/png")}
        r = requests.put(
            f"{BASE_URL}/api/photos/{pid}/replace",
            headers=headers, files=files,
        )
        assert r.status_code == 200, r.text
        # Download and confirm new bytes
        d = requests.get(
            f"{BASE_URL}/api/photos/{pid}/download",
            headers=headers,
        )
        assert d.status_code == 200
        assert d.headers["content-type"].startswith("image/png")
        assert d.content[:4] == b"\x89PNG", (
            f"replaced photo should be PNG, got {d.content[:8].hex()}"
        )


class TestPhotoDelete:
    def test_delete_then_download_404(self, api_client, admin_auth):
        pid = getattr(TestPhotoUpload, "_uploaded_id", None)
        assert pid, "upload test must run first"
        r = api_client.delete(f"{BASE_URL}/api/photos/{pid}")
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}
        # Download must 404 now
        d = requests.get(
            f"{BASE_URL}/api/photos/{pid}/download",
            headers={"Authorization": f"Bearer {admin_auth['token']}"},
        )
        assert d.status_code == 404, f"Expected 404 after delete, got {d.status_code}"
